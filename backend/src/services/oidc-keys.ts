/**
 * The OpenID Connect provider's signing keys (epic #2014 phase #2016; ADR 0119, decisions 2 and
 * 4): generating them, keeping the private half encrypted, publishing the public half as a JSON Web
 * Key Set, signing a token with ES256, and rotating.
 *
 * THE LIFE OF A KEY. Every key is made as `next`, published from that moment so a client has time to
 * fetch it, and becomes `current` (the one that signs) only when it is at least 24 hours old, unless
 * the owner forces it. The key that was `current` becomes `retired` and stays published for seven
 * days, so a token signed just before a rotation still verifies. The first rotation of an empty
 * table makes a `current` and a `next` together; there is no window in which nothing signs once
 * that has happened.
 *
 * THE PRIVATE KEY NEVER LEAVES. It is generated in memory, encrypted with `encrypt()` under
 * `OIDC_SECRET` before it is stored, decrypted only to sign, and returned by nothing: the published
 * set is built from an allow-list of public members, so a private member that reached the public
 * column by any route is still not emitted. A decrypted key is cached for the life of the isolate,
 * keyed by the key's id AND the secret it was decrypted under, so a warm cache is no way around a
 * wrong secret.
 *
 * ROTATION IS ONE BATCH, AND THE TABLE'S INDEXES ARE ITS LOCK. The state is read, a key is made, and
 * the changes go to D1 in one batch (a transaction): retire the current key named in the read,
 * promote the `next` key named in the read, insert the new `next`, and write the audit row. A second
 * rotation that read the same state finds its statements matching nothing, and its insert of a new
 * `next` (or of a first `current`) breaks a partial unique index, so the whole batch is refused,
 * which is reported as `conflict` and leaves the table as the winner made it. The caller reads the
 * keys again. Only the keys' own unique violation is a conflict: any other constraint failure is a
 * defect and is thrown.
 *
 * Each statement names the key id it read AND the state it read it in (`kid = ? AND state = ...`).
 * The id stops a stale rotation from promoting the key the winner had just made, at the age of zero.
 * The state matters when two rotations, or a rotation and a revocation, finish between a slow
 * writer's read and its write: without it the writer's statement would match a key that is no longer
 * `next` or `current` and rewrite it into a state its stamps forbid, and the failure would be a CHECK
 * violation (a 500) instead of a clean `conflict`. A test per statement holds each.
 *
 * ROTATION PROVES THE KEY IT PROMOTES CAN BE READ. A `next` key that was encrypted under another
 * `OIDC_SECRET` would become `current` and then fail on the first token: so before the batch is
 * built, the key about to sign is decrypted and checked against the public key published for it,
 * and a key that cannot be read refuses the rotation (`key_unreadable`) and changes nothing.
 *
 * A FORCED ROTATION IS NOT INSTANT. A key published a moment ago may not be in the key set a client
 * cached, so `force` refuses while the next key is under 6 minutes old unless the owner says it is
 * an emergency (`emergency`), and the audit row records both.
 *
 * Time is D1's (`datetime('now')`), never the Worker's clock, for the same reason as the re-pull
 * dispatch cap: one clock for the rule and the stamps it reads.
 */

import {
  OIDC_FORCE_MIN_NEXT_AGE_MINUTES,
  OIDC_KEY_MIN_NEXT_AGE_HOURS,
  OIDC_KID_HEX_LENGTH,
  OIDC_RETIRED_KEY_PUBLISH_DAYS,
  OIDC_RETIRED_KEY_PUBLISH_MAX,
  OIDC_SIGNING_ALG,
  isOidcKid,
} from "../../../shared/oidc.js";
import { applyEditWithAudit, auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { EncryptionError, decrypt, encrypt } from "./encryption.js";
import { oidcSecret } from "./oidc-config.js";
import { randomHex, toBase64Url } from "./oidc-encoding.js";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** `OIDC_SECRET` is unset or not in the `nmsso-` form: nothing safe can be signed or stored. */
export class OidcNotConfiguredError extends Error {
  constructor() {
    super("OIDC_SECRET is not set, or is not in the required form");
    this.name = "OidcNotConfiguredError";
  }
}

/** There is no `current` key: the keys were never rotated into existence. */
export class NoSigningKeyError extends Error {
  constructor() {
    super("There is no current signing key; run the first key rotation");
    this.name = "NoSigningKeyError";
  }
}

/**
 * The private half behind a key row is not the one the row publishes: a ciphertext that was moved to
 * another row, or a row that was edited. It decrypts fine and must still never sign.
 */
export class KeyMismatchError extends Error {
  constructor(kid: string) {
    super(`the private key stored for ${kid} does not match the public key published for it`);
    this.name = "KeyMismatchError";
  }
}

function requireSecret(env: Pick<Bindings, "OIDC_SECRET">): string {
  const secret = oidcSecret(env);
  if (secret === null) throw new OidcNotConfiguredError();
  return secret;
}

const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------------------------

/** What generating a key yields: its id, its public half, and its private half already encrypted. */
interface GeneratedKey {
  kid: string;
  publicJwk: string;
  encryptedPrivate: string;
}

async function generateKey(secret: string): Promise<GeneratedKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const { x, y, d } = exported;
  if (!x || !y || !d) throw new Error("the key export did not hold x, y and d");
  const kid = randomHex(OIDC_KID_HEX_LENGTH / 2);
  const publicJwk = { kty: "EC", crv: "P-256", x, y, kid, use: "sig", alg: OIDC_SIGNING_ALG };
  const privateJwk = { kty: "EC", crv: "P-256", x, y, d };
  return {
    kid,
    publicJwk: JSON.stringify(publicJwk),
    encryptedPrivate: await encrypt(JSON.stringify(privateJwk), secret),
  };
}

// ---------------------------------------------------------------------------------------------
// The decrypted-key cache
// ---------------------------------------------------------------------------------------------

interface CachedKey {
  secret: string;
  key: CryptoKey;
}

/**
 * Decrypted signing keys, for the life of the isolate. One entry per key that ever signed in this
 * isolate: a rotation adds one, and rotations are the owner's rare act, so the map stays tiny.
 */
const decryptedKeys = new Map<string, CachedKey>();

/** What reading a key needs of its row: its id, its public half and its sealed private half. */
interface KeyMaterial {
  kid: string;
  public_jwk: string;
  private_jwk_encrypted: string | null;
}

/**
 * The private key behind a row, decrypted under `secret` and checked against the public key the row
 * publishes (the same `x` and `y`), so a ciphertext moved between rows cannot sign under another
 * row's `kid`. Throws an `EncryptionError` for the wrong secret and a {@link KeyMismatchError} for
 * the wrong row. The result is cached, keyed by the id and the secret it was proven under.
 */
async function privateKeyFor(secret: string, row: KeyMaterial): Promise<CryptoKey> {
  const hit = decryptedKeys.get(row.kid);
  if (hit && hit.secret === secret) return hit.key;
  if (!row.private_jwk_encrypted) throw new KeyMismatchError(row.kid);
  const kid = row.kid;
  const jwk = JSON.parse(await decrypt(row.private_jwk_encrypted, secret)) as JsonWebKey;
  const published = JSON.parse(row.public_jwk) as { x?: unknown; y?: unknown };
  if (!jwk.x || !jwk.y || jwk.x !== published.x || jwk.y !== published.y) {
    throw new KeyMismatchError(kid);
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  decryptedKeys.set(kid, { secret, key });
  return key;
}

/** Test seam: how many decrypted keys are held. */
export function __oidcDecryptedKeyCacheSize(): number {
  return decryptedKeys.size;
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

/** The current key's id and both halves. Exported so a test reads the statement that runs. */
export const CURRENT_KEY_SQL =
  "SELECT kid, public_jwk, private_jwk_encrypted FROM oidc_signing_keys WHERE state = 'current'";

/**
 * A compact JSON Web Token signed with the current key, ES256. WebCrypto's ECDSA output is already
 * the JOSE `r || s` form (64 bytes for P-256), so nothing is converted. The header names the key id,
 * which is how a client picks the published key that verifies it.
 *
 * `typ` is the token type in the header: `JWT` for an identity token, and `logout+jwt` for a back-channel
 * logout token (OpenID Connect Back-Channel Logout 1.0), which `services/oidc-logout.ts` signs with this.
 *
 * Throws {@link OidcNotConfiguredError} with no usable secret, {@link NoSigningKeyError} with no
 * current key, an `EncryptionError` when the stored key cannot be decrypted under the secret, and a
 * {@link KeyMismatchError} when what decrypts is not the key the row publishes.
 */
export async function signJwt(
  env: Pick<Bindings, "DB" | "OIDC_SECRET">,
  claims: Record<string, unknown>,
  options: { typ?: string } = {},
): Promise<string> {
  const secret = requireSecret(env);
  const row = await env.DB.prepare(CURRENT_KEY_SQL).first<KeyMaterial>();
  if (!row) throw new NoSigningKeyError();
  const key = await privateKeyFor(secret, row);
  const header = { alg: OIDC_SIGNING_ALG, kid: row.kid, typ: options.typ ?? "JWT" };
  const signingInput = `${toBase64Url(textBytes(JSON.stringify(header)))}.${toBase64Url(textBytes(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textBytes(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

// ---------------------------------------------------------------------------------------------
// The published key set
// ---------------------------------------------------------------------------------------------

/**
 * The keys a client may need: the current one, the next one, and the most recently retired ones that
 * are still inside their publication window (seven days, at most five). The window is D1's clock,
 * bound as a modifier. A revoked key is never published.
 */
export const JWKS_SQL = `SELECT kid, state, public_jwk FROM oidc_signing_keys
   WHERE state IN ('next', 'current')
      OR kid IN (SELECT kid FROM oidc_signing_keys
                  WHERE state = 'retired' AND retired_at > datetime('now', ?)
                  ORDER BY retired_at DESC, kid LIMIT ?)
   ORDER BY CASE state WHEN 'current' THEN 0 WHEN 'next' THEN 1 ELSE 2 END, retired_at DESC, kid`;

/** The members of a published key. Anything else on the row, a private member included, is dropped. */
const PUBLIC_MEMBERS = ["kty", "crv", "x", "y"] as const;

/** One published key from its stored public half: the allow-listed members, the row's own id. */
function publishedKey(kid: string, stored: string): Record<string, string> | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stored) as Record<string, unknown>;
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const member of PUBLIC_MEMBERS) {
    const value = parsed[member];
    if (typeof value !== "string" || value === "") return null;
    out[member] = value;
  }
  // Every key here is an ES256 signing key, so the constants are the row's, not the JSON's.
  out.use = "sig";
  out.alg = OIDC_SIGNING_ALG;
  out.kid = kid;
  return out;
}

/** How long a built key set is kept for one database object. Rotation clears it at once. */
export const JWKS_MEMO_TTL_MS = 30_000;

/**
 * The key set is served without a rate limit (ADR 0119: a client that cannot fetch it cannot
 * validate a token), so the read it costs is kept for a short time per database object. A rotation
 * through this module (a rotation, a revocation) clears the entry in the same isolate; another
 * isolate may serve the previous set for up to the window. That is harmless next to the five minutes
 * a client caches the set for (`OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS`): a `next` key is published 24
 * hours before it signs (6 minutes in a forced emergency), and a retired key for seven days after.
 *
 * The cache saves the read only if a Worker is handed the SAME `env.DB` object on every request of
 * an isolate. Under workerd, the runtime of `wrangler dev` and of the dev Worker, it is, and
 * `backend/test/oidc-jwks-memo-identity.test.ts` holds that against Miniflare. Whether the deployed edge
 * does is unverified until the dev Worker has served traffic; if it does not, this is a no-op that
 * costs one read per request and should move to a key the runtime keeps.
 */
const jwksMemo = new WeakMap<object, { at: number; body: string }>();

/** The JSON text of the published key set. `now` is the clock the window is read by. */
export async function jwksDocument(db: D1Database, now: number = Date.now()): Promise<string> {
  const hit = jwksMemo.get(db);
  if (hit && now - hit.at >= 0 && now - hit.at < JWKS_MEMO_TTL_MS) return hit.body;
  const { results } = await db
    .prepare(JWKS_SQL)
    .bind(`-${OIDC_RETIRED_KEY_PUBLISH_DAYS} days`, OIDC_RETIRED_KEY_PUBLISH_MAX)
    .all<{ kid: string; state: string; public_jwk: string }>();
  const keys: Array<Record<string, string>> = [];
  for (const row of results ?? []) {
    const key = publishedKey(row.kid, row.public_jwk);
    if (key) {
      keys.push(key);
    } else if (row.state === "retired") {
      // An old key that cannot be published verifies only tokens that have since expired.
      console.error(
        `[oidc-keys] the public key of the retired key ${row.kid} is malformed and is not published`,
      );
    } else {
      // The key that signs, or the one about to: a key set without it would fail every client's
      // verification and say nothing. Fail the request, which is not cached and is not a public document.
      throw new Error(`the public key of the ${row.state} key ${row.kid} is malformed`);
    }
  }
  const body = JSON.stringify({ keys });
  jwksMemo.set(db, { at: now, body });
  return body;
}

/** Test seam: forget every cached decrypted key. The key-set cache is per database object. */
export function __resetOidcKeyCachesForTests(): void {
  decryptedKeys.clear();
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

/** One key as the owner sees it. No private member exists on this shape. */
export interface SigningKeyView {
  kid: string;
  alg: string;
  state: string;
  created_at: string;
  promoted_at: string | null;
  retired_at: string | null;
  revoked_at: string | null;
  /** For a `next` key, when it is old enough to sign without force; null for any other state. */
  promotable_at: string | null;
}

/** What an owner reads of a key: every column but the two key halves. */
const KEY_VIEW_COLUMNS = `kid, alg, state, created_at, promoted_at, retired_at, revoked_at,
       CASE WHEN state = 'next' THEN datetime(created_at, '+${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours') END AS promotable_at`;

/** Every key, current first, then next, then retired, then revoked, newest first. Never the private half. */
export const LIST_KEYS_SQL = `SELECT ${KEY_VIEW_COLUMNS}
  FROM oidc_signing_keys
 ORDER BY CASE state WHEN 'current' THEN 0 WHEN 'next' THEN 1 WHEN 'retired' THEN 2 ELSE 3 END, created_at DESC, kid
 LIMIT 200`;

export const GET_KEY_SQL = `SELECT ${KEY_VIEW_COLUMNS} FROM oidc_signing_keys WHERE kid = ?`;

const viewOf = (r: SigningKeyView): SigningKeyView => ({
  ...r,
  promotable_at: r.promotable_at ?? null,
});

export async function listSigningKeys(db: D1Database): Promise<SigningKeyView[]> {
  const { results } = await db.prepare(LIST_KEYS_SQL).all<SigningKeyView>();
  return (results ?? []).map(viewOf);
}

export async function getSigningKey(db: D1Database, kid: string): Promise<SigningKeyView | null> {
  const row = await db.prepare(GET_KEY_SQL).bind(kid).first<SigningKeyView>();
  return row ? viewOf(row) : null;
}

// ---------------------------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------------------------

export type RotationResult =
  | { ok: true; action: "bootstrapped" | "rotated" | "next_created"; keys: SigningKeyView[] }
  | { ok: false; code: "too_early"; promotable_at: string }
  | { ok: false; code: "forced_too_early" }
  | { ok: false; code: "key_unreadable" }
  | { ok: false; code: "conflict" };

/**
 * The two keys that matter for a rotation: whether `next` is old enough, whether it is under the
 * force floor, and both halves of each, so the key about to sign can be proven readable.
 */
export const ROTATION_STATE_SQL = `SELECT kid, state, created_at, public_jwk, private_jwk_encrypted,
       created_at <= datetime('now', '-${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours') AS aged,
       created_at > datetime('now', '-${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes') AS young,
       datetime(created_at, '+${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours') AS promotable_at
  FROM oidc_signing_keys WHERE state IN ('next', 'current')`;

export const INSERT_CURRENT_SQL = `INSERT INTO oidc_signing_keys
  (kid, alg, state, public_jwk, private_jwk_encrypted, promoted_at)
  VALUES (?, '${OIDC_SIGNING_ALG}', 'current', ?, ?, datetime('now'))`;

export const INSERT_NEXT_SQL = `INSERT INTO oidc_signing_keys
  (kid, alg, state, public_jwk, private_jwk_encrypted)
  VALUES (?, '${OIDC_SIGNING_ALG}', 'next', ?, ?)`;

export const RETIRE_CURRENT_SQL = `UPDATE oidc_signing_keys
  SET state = 'retired', retired_at = datetime('now') WHERE kid = ? AND state = 'current'`;

/**
 * Promote the `next` key the caller read, if it is still `next`. The age rule is applied once, to
 * the same read that names the key (`ROTATION_STATE_SQL`): a key that was 24 hours old when it was
 * read is still, so no second check is made here.
 */
export const PROMOTE_NEXT_SQL = `UPDATE oidc_signing_keys
  SET state = 'current', promoted_at = datetime('now')
  WHERE kid = ? AND state = 'next'`;

/**
 * The keys' own state index refusing a second `next` or `current`, as SQLite and D1 word it
 * (`UNIQUE constraint failed: oidc_signing_keys.state`). Nothing else is a conflict: a CHECK, another
 * table's index, the key id's primary key, or an unrelated error is a defect and is thrown.
 */
const STATE_INDEX_RE = /UNIQUE constraint failed: oidc_signing_keys\.state\b/;

interface StateRow extends KeyMaterial {
  state: "next" | "current";
  aged: number;
  young: number;
  promotable_at: string;
}

/** True when the key behind a row cannot be used under `secret`: another secret, or another row's key. */
async function isUnreadable(secret: string, row: StateRow): Promise<boolean> {
  try {
    await privateKeyFor(secret, row);
    return false;
  } catch (err) {
    if (
      err instanceof EncryptionError ||
      err instanceof KeyMismatchError ||
      err instanceof SyntaxError
    ) {
      return true;
    }
    throw err;
  }
}

/**
 * Rotate the keys once, as the owner asked.
 *
 *   - no `current` and no `next`: make both (`bootstrapped`);
 *   - a `next` key: if it is 24 hours old, or `force` is set, it becomes `current`, the old
 *     `current` becomes `retired`, and a new `next` is made (`rotated`); otherwise nothing changes
 *     and the answer says when it may (`too_early`);
 *   - a `current` key and no `next` (a state only a hand edit can reach): make a `next`
 *     (`next_created`), which changes nothing that signs.
 *
 * Refused, and nothing changed: `too_early` (the next key is under 24 hours old and the rotation is
 * not forced), `forced_too_early` (forced, the next key is under 6 minutes old and it is not an
 * emergency), `key_unreadable` (the key about to sign cannot be decrypted under `OIDC_SECRET`, or is
 * not the key its row publishes), and `conflict` (another rotation won between the read and the
 * write).
 */
export async function rotateSigningKeys(
  env: Pick<Bindings, "DB" | "OIDC_SECRET">,
  options: { force?: boolean; emergency?: boolean; actorId: number | null },
): Promise<RotationResult> {
  const secret = requireSecret(env);
  const db = env.DB;
  const force = options.force === true;
  const emergency = force && options.emergency === true;

  const { results } = await db.prepare(ROTATION_STATE_SQL).all<StateRow>();
  const current = (results ?? []).find((r) => r.state === "current");
  const next = (results ?? []).find((r) => r.state === "next");

  if (next && !force && !next.aged) {
    return { ok: false, code: "too_early", promotable_at: next.promotable_at };
  }
  if (next && force && next.young && !emergency) return { ok: false, code: "forced_too_early" };
  // The key that is about to sign, or about to be kept signing: prove it can be read first.
  const aboutToSign = next ?? current;
  if (aboutToSign && (await isUnreadable(secret, aboutToSign))) {
    return { ok: false, code: "key_unreadable" };
  }

  let action: "bootstrapped" | "rotated" | "next_created";
  const statements: D1PreparedStatement[] = [];
  let signingKid: string;
  if (!current && !next) {
    action = "bootstrapped";
    const first = await generateKey(secret);
    const second = await generateKey(secret);
    signingKid = first.kid;
    statements.push(
      db.prepare(INSERT_CURRENT_SQL).bind(first.kid, first.publicJwk, first.encryptedPrivate),
      db.prepare(INSERT_NEXT_SQL).bind(second.kid, second.publicJwk, second.encryptedPrivate),
    );
  } else if (next) {
    action = "rotated";
    const fresh = await generateKey(secret);
    signingKid = next.kid;
    if (current) statements.push(db.prepare(RETIRE_CURRENT_SQL).bind(current.kid));
    statements.push(
      db.prepare(PROMOTE_NEXT_SQL).bind(next.kid),
      db.prepare(INSERT_NEXT_SQL).bind(fresh.kid, fresh.publicJwk, fresh.encryptedPrivate),
    );
  } else {
    action = "next_created";
    const fresh = await generateKey(secret);
    signingKid = (current as StateRow).kid;
    statements.push(
      db.prepare(INSERT_NEXT_SQL).bind(fresh.kid, fresh.publicJwk, fresh.encryptedPrivate),
    );
  }

  // Shape only: what happened, whether it was forced, and the id of the key that signs afterwards
  // (public: it is in every token's header). No key material, no ciphertext.
  statements.push(
    auditLogStatement(db, {
      userId: options.actorId,
      action: "oidc.keys.rotate",
      resourceType: "oidc_signing_key",
      resourceId: signingKid,
      details: JSON.stringify({ action, forced: force, emergency }),
    }),
  );

  try {
    await db.batch(statements);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (STATE_INDEX_RE.test(message)) return { ok: false, code: "conflict" };
    throw err;
  }
  jwksMemo.delete(db);
  return { ok: true, action, keys: await listSigningKeys(db) };
}

// ---------------------------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------------------------

export type RevokeResult =
  | { ok: true; key: SigningKeyView; changed: boolean }
  | { ok: false; code: "key_not_found" | "key_not_revocable" };

export const KEY_STATE_SQL = "SELECT state FROM oidc_signing_keys WHERE kid = ?";

/** Revoke a key that is retired: it is no longer published, so it verifies nothing. */
export const REVOKE_KEY_SQL = `UPDATE oidc_signing_keys
  SET state = 'revoked', revoked_at = datetime('now') WHERE kid = ? AND state = 'retired'`;

/**
 * Withdraw a retired key from the key set at once, for a key whose private half is thought to have
 * leaked: tokens it signed stop verifying wherever the key set is read again (clients cache it for
 * up to five minutes). Only a retired key can be revoked: the key that signs and the one about to
 * are refused, and the owner rotates first. Revoking a revoked key changes nothing and writes no
 * audit row.
 */
export async function revokeSigningKey(
  env: Pick<Bindings, "DB">,
  kid: string,
  actorId: number | null,
): Promise<RevokeResult> {
  if (!isOidcKid(kid)) throw new RangeError("that is not a key id; the route validates it first");
  const db = env.DB;
  const row = await db.prepare(KEY_STATE_SQL).bind(kid).first<{ state: string }>();
  if (!row) return { ok: false, code: "key_not_found" };
  if (row.state === "current" || row.state === "next")
    return { ok: false, code: "key_not_revocable" };
  let changed = false;
  if (row.state === "retired") {
    changed = await applyEditWithAudit(db, db.prepare(REVOKE_KEY_SQL).bind(kid), {
      userId: actorId,
      action: "oidc.keys.revoke",
      resourceType: "oidc_signing_key",
      resourceId: kid,
      details: null,
    });
  }
  if (changed) jwksMemo.delete(db);
  const key = await getSigningKey(db, kid);
  if (!key) return { ok: false, code: "key_not_found" };
  return { ok: true, key, changed };
}
