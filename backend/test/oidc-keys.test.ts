/**
 * The OpenID Connect signing keys (epic #2014 phase #2016; ADR 0119, decisions 2 and 4):
 * generation, encryption at rest, the published key set, ES256 signing and the rotation state
 * machine, driven through the service that the owner route calls, over a real SQLite database that
 * carries every migration (so the partial unique indexes are the production ones).
 *
 * What is pinned, and the line each guards:
 *
 *   - the key set holds `next`, `current` and retired keys for seven days, names no private member
 *     however the row was written, and carries a `next` key before it ever signs;
 *   - a token signed by the service verifies, with `crypto.subtle`, against the PUBLISHED key whose
 *     `kid` the token names, and against no other and not after a change;
 *   - the stored private key is ciphertext, a wrong `OIDC_SECRET` cannot read it, and the decrypted
 *     key cache is keyed by the secret as well as the key, so a warm cache is not a way around that;
 *   - rotation: an empty table gets `current` and `next`; `next` becomes `current` only at 24 hours
 *     old unless forced; `current` becomes `retired` and a new `next` is made; two rotations at
 *     once make exactly one; a refusal changes nothing and leaves no audit row.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  OIDC_FORCE_MIN_NEXT_AGE_MINUTES,
  OIDC_KEY_MIN_NEXT_AGE_HOURS,
  OIDC_RETIRED_KEY_PUBLISH_MAX,
  isOidcKid,
} from "../../shared/oidc";
import { EncryptionError, decrypt } from "../src/services/encryption";
import {
  JWKS_MEMO_TTL_MS,
  KEY_STATE_SQL,
  NoSigningKeyError,
  ROTATION_STATE_SQL,
  __oidcDecryptedKeyCacheSize,
  __resetOidcKeyCachesForTests,
  jwksDocument,
  listSigningKeys,
  revokeSigningKey,
  rotateSigningKeys,
  signJwt,
} from "../src/services/oidc-keys";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1, wrapD1 } from "./helpers/d1";
import { BAD_OIDC_SECRETS, fakeOidcSecret } from "./helpers/oidc-secret";

const SECRET = fakeOidcSecret("oidc-keys-test");
const OTHER_SECRET = fakeOidcSecret("a-different-oidc-secret");
const PUBLIC_MEMBERS = ["alg", "crv", "kid", "kty", "use", "x", "y"];

let db: Database;
let env: Bindings;

function makeEnv(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    OIDC_SECRET: SECRET,
    API_BASE_URL: "https://api.nemar.org",
    ENVIRONMENT: "test",
    ...over,
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  env = makeEnv();
  __resetOidcKeyCachesForTests();
});

interface KeyRow {
  kid: string;
  state: string;
  public_jwk: string;
  private_jwk_encrypted: string;
  created_at: string;
  promoted_at: string | null;
  retired_at: string | null;
}

const rows = (): KeyRow[] =>
  db.query<KeyRow, []>("SELECT * FROM oidc_signing_keys ORDER BY created_at, kid").all();
const kidIn = (state: string): string => {
  const found = rows().filter((r) => r.state === state);
  expect(found, `exactly one ${state} key`).toHaveLength(1);
  return (found[0] as KeyRow).kid;
};
const countIn = (state: string): number => rows().filter((r) => r.state === state).length;

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad), (c) =>
    c.charCodeAt(0),
  );
}
const b64urlToText = (s: string): string => new TextDecoder().decode(b64urlToBytes(s));

async function bootstrap(): Promise<void> {
  const r = await rotateSigningKeys(env, { actorId: 1 });
  expect(r.ok).toBe(true);
}

/** Verify a compact JWT against a published JSON Web Key, with nothing but Web Crypto. */
async function verifies(jwt: string, jwk: Record<string, unknown>): Promise<boolean> {
  const [h, p, s] = jwt.split(".") as [string, string, string];
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
}

async function publishedKey(kid: string): Promise<Record<string, unknown> | undefined> {
  const set = JSON.parse(await jwksDocument(env.DB)) as { keys: Array<Record<string, unknown>> };
  return set.keys.find((k) => k.kid === kid);
}

// ---------------------------------------------------------------------------------------------

describe("the first rotation makes a current and a next key", () => {
  test("an empty table gets exactly one of each, and the result says it bootstrapped", async () => {
    const r = await rotateSigningKeys(env, { actorId: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("bootstrapped");
    expect(rows()).toHaveLength(2);
    expect(countIn("current")).toBe(1);
    expect(countIn("next")).toBe(1);
    expect(countIn("retired")).toBe(0);
    expect(r.keys.map((k) => k.state).sort()).toEqual(["current", "next"]);
    for (const row of rows()) expect(isOidcKid(row.kid)).toBe(true);
    const current = rows().find((x) => x.state === "current");
    expect(current?.promoted_at).not.toBeNull();
    expect(rows().find((x) => x.state === "next")?.promoted_at).toBeNull();
  });

  test("each public key is an ES256 P-256 key whose kid is the row's", async () => {
    await bootstrap();
    for (const row of rows()) {
      const jwk = JSON.parse(row.public_jwk) as Record<string, string>;
      expect(Object.keys(jwk).sort()).toEqual(PUBLIC_MEMBERS);
      expect(jwk.kty).toBe("EC");
      expect(jwk.crv).toBe("P-256");
      expect(jwk.alg).toBe("ES256");
      expect(jwk.use).toBe("sig");
      expect(jwk.kid).toBe(row.kid);
      // A P-256 coordinate is 32 bytes.
      expect(b64urlToBytes(jwk.x as string)).toHaveLength(32);
      expect(b64urlToBytes(jwk.y as string)).toHaveLength(32);
    }
  });

  test("the keys are different", async () => {
    await bootstrap();
    const [a, b] = rows();
    expect(a?.kid).not.toBe(b?.kid);
    expect(a?.public_jwk).not.toBe(b?.public_jwk);
  });
});

describe("the private key is ciphertext, readable only under OIDC_SECRET", () => {
  test("the stored private key is not a JSON Web Key and holds none of its members", async () => {
    await bootstrap();
    for (const row of rows()) {
      expect(() => JSON.parse(row.private_jwk_encrypted)).toThrow();
      expect(row.private_jwk_encrypted).not.toContain("kty");
      expect(row.private_jwk_encrypted).not.toContain("P-256");
    }
  });

  test("under the right secret it decrypts to the private half of the published key", async () => {
    await bootstrap();
    for (const row of rows()) {
      const priv = JSON.parse(await decrypt(row.private_jwk_encrypted, SECRET)) as Record<
        string,
        string
      >;
      const pub = JSON.parse(row.public_jwk) as Record<string, string>;
      expect(priv.d).toBeTruthy();
      expect(priv.x).toBe(pub.x);
      expect(priv.y).toBe(pub.y);
    }
  });

  test("a wrong OIDC_SECRET cannot decrypt it", async () => {
    await bootstrap();
    for (const row of rows()) {
      await expect(decrypt(row.private_jwk_encrypted, OTHER_SECRET)).rejects.toBeInstanceOf(
        EncryptionError,
      );
    }
  });

  test("the service cannot sign under a wrong secret, cold or warm", async () => {
    await bootstrap();
    const wrong = makeEnv({ OIDC_SECRET: OTHER_SECRET });
    // Cold: nothing decrypted yet.
    await expect(signJwt(wrong, { sub: "x" })).rejects.toBeInstanceOf(EncryptionError);
    // Warm: a successful signature under the right secret has cached the decrypted key. A cache
    // keyed by the key id alone would now let the wrong secret sign.
    await signJwt(env, { sub: "x" });
    expect(__oidcDecryptedKeyCacheSize()).toBe(1);
    await expect(signJwt(wrong, { sub: "x" })).rejects.toBeInstanceOf(EncryptionError);
  });

  test("with no secret, a short one or one not in the nmsso- form, the service refuses to make or use a key", async () => {
    for (const [, secret] of BAD_OIDC_SECRETS) {
      const off = makeEnv({ OIDC_SECRET: secret as string });
      await expect(rotateSigningKeys(off, { actorId: 1 })).rejects.toThrow(/OIDC_SECRET/);
      await expect(signJwt(off, { sub: "x" })).rejects.toThrow(/OIDC_SECRET/);
    }
    expect(rows()).toHaveLength(0);
  });

  test("a decrypted key is cached after the first signature and the cache can be cleared", async () => {
    await bootstrap();
    expect(__oidcDecryptedKeyCacheSize()).toBe(0);
    await signJwt(env, { sub: "x" });
    await signJwt(env, { sub: "y" });
    expect(__oidcDecryptedKeyCacheSize()).toBe(1);
    __resetOidcKeyCachesForTests();
    expect(__oidcDecryptedKeyCacheSize()).toBe(0);
  });
});

describe("the published key set", () => {
  test("holds next and current, and no private member in any form", async () => {
    await bootstrap();
    const text = await jwksDocument(env.DB);
    const set = JSON.parse(text) as { keys: Array<Record<string, string>> };
    expect(set.keys).toHaveLength(2);
    expect(set.keys.map((k) => k.kid).sort()).toEqual([kidIn("current"), kidIn("next")].sort());
    for (const key of set.keys) expect(Object.keys(key).sort()).toEqual(PUBLIC_MEMBERS);
    for (const row of rows()) {
      const priv = JSON.parse(await decrypt(row.private_jwk_encrypted, SECRET)) as {
        d: string;
      };
      expect(text).not.toContain(priv.d);
      expect(text).not.toContain(row.private_jwk_encrypted);
    }
    expect(text).not.toContain('"d"');
  });

  test("the next key is published before it signs", async () => {
    await bootstrap();
    const next = kidIn("next");
    expect(await publishedKey(next)).toBeDefined();
    const jwt = await signJwt(env, { sub: "x" });
    expect(JSON.parse(b64urlToText(jwt.split(".")[0] as string)).kid).not.toBe(next);
  });

  test("a private member that reached the public column is still never emitted", async () => {
    await bootstrap();
    db.run(
      `INSERT INTO oidc_signing_keys (kid, alg, state, public_jwk, private_jwk_encrypted, promoted_at, retired_at)
       VALUES ('00000000000000aa', 'ES256', 'retired',
               '{"kty":"EC","crv":"P-256","x":"xx","y":"yy","d":"LEAKED-PRIVATE","p":"LEAKED-P","use":"sig","alg":"ES256","kid":"00000000000000aa","key_ops":["sign"]}',
               'ct', datetime('now', '-1 days'), datetime('now', '-1 hours'))`,
    );
    __resetOidcKeyCachesForTests();
    const text = await jwksDocument(env.DB);
    expect(text).not.toContain("LEAKED");
    const retired = (JSON.parse(text) as { keys: Array<Record<string, string>> }).keys.find(
      (k) => k.kid === "00000000000000aa",
    );
    expect(retired).toBeDefined();
    expect(Object.keys(retired ?? {}).sort()).toEqual(PUBLIC_MEMBERS);
  });

  test("a retired key is published for seven days and not longer", async () => {
    await bootstrap();
    const insertRetired = (kid: string, ago: string) =>
      db.run(
        `INSERT INTO oidc_signing_keys (kid, alg, state, public_jwk, private_jwk_encrypted, promoted_at, retired_at)
         VALUES ('${kid}', 'ES256', 'retired', '{"kty":"EC","crv":"P-256","x":"a","y":"b"}', 'ct',
                 datetime('now', '-30 days'), datetime('now', '${ago}'))`,
      );
    insertRetired("00000000000000b1", "-6 days");
    insertRetired("00000000000000b2", "-8 days");
    __resetOidcKeyCachesForTests();
    const kids = (
      JSON.parse(await jwksDocument(env.DB)) as { keys: Array<{ kid: string }> }
    ).keys.map((k) => k.kid);
    expect(kids).toContain("00000000000000b1");
    expect(kids).not.toContain("00000000000000b2");
    // The kid comes from the row even when the stored JSON lacks one.
  });

  test("an empty table publishes an empty set", async () => {
    expect(JSON.parse(await jwksDocument(env.DB))).toEqual({ keys: [] });
  });

  test("the set is kept for a short time per database, and a rotation clears it", async () => {
    await bootstrap();
    const t0 = 1_800_000_000_000;
    const first = await jwksDocument(env.DB, t0);
    // A key added behind the service's back is not seen inside the window...
    db.run(
      `INSERT INTO oidc_signing_keys (kid, alg, state, public_jwk, private_jwk_encrypted, promoted_at, retired_at)
       VALUES ('00000000000000c1', 'ES256', 'retired', '{"kty":"EC","crv":"P-256","x":"a","y":"b"}', 'ct',
               datetime('now', '-1 days'), datetime('now', '-1 hours'))`,
    );
    expect(await jwksDocument(env.DB, t0 + JWKS_MEMO_TTL_MS - 1)).toBe(first);
    // ...and is seen once the window has passed.
    expect(await jwksDocument(env.DB, t0 + JWKS_MEMO_TTL_MS + 1)).toContain("00000000000000c1");
    // A rotation through the service is seen at once, not after the window.
    const before = await jwksDocument(env.DB, t0);
    await rotateSigningKeys(env, { actorId: 1, force: true, emergency: true });
    const after = await jwksDocument(env.DB, t0 + 1);
    expect(after).not.toBe(before);
    expect(after).toContain(kidIn("next"));
  });

  test("a different database object is a different cache entry", async () => {
    await bootstrap();
    const other = freshDb();
    expect(JSON.parse(await jwksDocument(realD1(other)))).toEqual({ keys: [] });
    expect(JSON.parse(await jwksDocument(env.DB)).keys).toHaveLength(2);
  });
});

describe("signing", () => {
  test("a token the service signs verifies against the published key it names", async () => {
    await bootstrap();
    const claims = { iss: "https://api.nemar.org", sub: "nmu_0123", aud: "oc_x", iat: 1, exp: 2 };
    const jwt = await signJwt(env, claims);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(b64urlToText(parts[0] as string));
    expect(header).toEqual({ alg: "ES256", kid: kidIn("current"), typ: "JWT" });
    expect(JSON.parse(b64urlToText(parts[1] as string))).toEqual(claims);
    // WebCrypto's ECDSA output is already the JOSE r||s form: 64 bytes for P-256.
    expect(b64urlToBytes(parts[2] as string)).toHaveLength(64);
    const published = await publishedKey(header.kid);
    expect(published).toBeDefined();
    expect(await verifies(jwt, published as Record<string, unknown>)).toBe(true);
  });

  test("it does not verify against the next key, or after the payload is changed", async () => {
    await bootstrap();
    const jwt = await signJwt(env, { sub: "a" });
    const next = (await publishedKey(kidIn("next"))) as Record<string, unknown>;
    expect(await verifies(jwt, next)).toBe(false);
    const [h, , s] = jwt.split(".") as [string, string, string];
    const forgedPayload = btoa(JSON.stringify({ sub: "b" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const current = (await publishedKey(kidIn("current"))) as Record<string, unknown>;
    expect(await verifies(`${h}.${forgedPayload}.${s}`, current)).toBe(false);
  });

  test("with no current key there is nothing to sign with", async () => {
    await expect(signJwt(env, { sub: "x" })).rejects.toBeInstanceOf(NoSigningKeyError);
  });

  test("a token signed before a rotation still verifies after it, and the next key signs once promoted", async () => {
    await bootstrap();
    const oldCurrent = kidIn("current");
    const oldNext = kidIn("next");
    const before = await signJwt(env, { sub: "old" });
    const r = await rotateSigningKeys(env, { actorId: 1, force: true, emergency: true });
    expect(r.ok).toBe(true);
    expect(kidIn("current")).toBe(oldNext);
    const after = await signJwt(env, { sub: "new" });
    expect(JSON.parse(b64urlToText(after.split(".")[0] as string)).kid).toBe(oldNext);
    // The retired key is still published, so the older token verifies.
    const retired = (await publishedKey(oldCurrent)) as Record<string, unknown>;
    expect(retired).toBeDefined();
    expect(await verifies(before, retired)).toBe(true);
    expect(await verifies(after, (await publishedKey(oldNext)) as Record<string, unknown>)).toBe(
      true,
    );
  });
});

describe("rotation", () => {
  test("a rotation inside the first 24 hours is refused, says when it may happen, and changes nothing", async () => {
    await bootstrap();
    const before = JSON.stringify(rows());
    const auditBefore = db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    const r = await rotateSigningKeys(env, { actorId: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("too_early");
    if (r.code !== "too_early") return;
    // created_at plus 24 hours, in the table's own format.
    const created = rows().find((x) => x.state === "next")?.created_at as string;
    const expected = db
      .query<{ t: string }, [string]>("SELECT datetime(?, '+24 hours') AS t")
      .get(created)?.t;
    expect(r.promotable_at).toBe(expected as string);
    expect(JSON.stringify(rows())).toBe(before);
    const auditAfter = db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    expect(auditAfter.n).toBe(auditBefore.n);
  });

  test("forced, it promotes next, retires current and makes a new next", async () => {
    await bootstrap();
    const oldCurrent = kidIn("current");
    const oldNext = kidIn("next");
    const r = await rotateSigningKeys(env, { actorId: 1, force: true, emergency: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("rotated");
    expect(kidIn("current")).toBe(oldNext);
    expect(kidIn("next")).not.toBe(oldNext);
    expect(kidIn("next")).not.toBe(oldCurrent);
    const retired = rows().filter((x) => x.state === "retired");
    expect(retired.map((x) => x.kid)).toEqual([oldCurrent]);
    expect(retired[0]?.retired_at).not.toBeNull();
    expect(rows().find((x) => x.kid === oldNext)?.promoted_at).not.toBeNull();
    expect(rows()).toHaveLength(3);
  });

  test("a next key exactly 24 hours old is promoted without force; one a minute younger is not", async () => {
    await bootstrap();
    const oldNext = kidIn("next");
    db.run(
      "UPDATE oidc_signing_keys SET created_at = datetime('now', '-23 hours', '-59 minutes') WHERE state = 'next'",
    );
    const early = await rotateSigningKeys(env, { actorId: 1 });
    expect(early.ok).toBe(false);
    expect(kidIn("next")).toBe(oldNext);
    db.run(
      `UPDATE oidc_signing_keys SET created_at = datetime('now', '-${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours') WHERE state = 'next'`,
    );
    const ok = await rotateSigningKeys(env, { actorId: 1 });
    expect(ok.ok).toBe(true);
    expect(kidIn("current")).toBe(oldNext);
  });

  test("several rotations in a row keep one current, one next and every old key retired", async () => {
    await bootstrap();
    for (let i = 0; i < 4; i++) {
      expect((await rotateSigningKeys(env, { actorId: 1, force: true, emergency: true })).ok).toBe(
        true,
      );
    }
    expect(countIn("current")).toBe(1);
    expect(countIn("next")).toBe(1);
    expect(countIn("retired")).toBe(4);
    expect(new Set(rows().map((r) => r.kid)).size).toBe(6);
  });

  test("a table with a current key and no next makes a next and changes nothing else", async () => {
    await bootstrap();
    const current = kidIn("current");
    db.run("DELETE FROM oidc_signing_keys WHERE state = 'next'");
    const r = await rotateSigningKeys(env, { actorId: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("next_created");
    expect(kidIn("current")).toBe(current);
    expect(countIn("next")).toBe(1);
    expect(countIn("retired")).toBe(0);
  });

  test("a table with a next key and no current promotes it, retiring nothing", async () => {
    await bootstrap();
    const next = kidIn("next");
    db.run("DELETE FROM oidc_signing_keys WHERE state = 'current'");
    const r = await rotateSigningKeys(env, { actorId: 1, force: true, emergency: true });
    expect(r.ok).toBe(true);
    expect(kidIn("current")).toBe(next);
    expect(countIn("retired")).toBe(0);
    expect(countIn("next")).toBe(1);
  });

  test("two rotations at once make exactly one, and the other is told the keys changed", async () => {
    await bootstrap();
    const results = await Promise.all([
      rotateSigningKeys(env, { actorId: 1, force: true, emergency: true }),
      rotateSigningKeys(env, { actorId: 2, force: true, emergency: true }),
    ]);
    const ok = results.filter((r) => r.ok);
    const lost = results.filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toEqual({ ok: false, code: "conflict" });
    expect(countIn("current")).toBe(1);
    expect(countIn("next")).toBe(1);
    expect(countIn("retired")).toBe(1);
    const audits = db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'oidc.keys.rotate'")
      .get() as { n: number };
    // The bootstrap and the one rotation that won.
    expect(audits.n).toBe(2);
  });

  test("two first rotations at once make one pair of keys", async () => {
    const results = await Promise.all([
      rotateSigningKeys(env, { actorId: 1 }),
      rotateSigningKeys(env, { actorId: 2 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: "conflict" }]);
    expect(rows()).toHaveLength(2);
  });

  test("each rotation that happens leaves one audit row of its shape and no key material", async () => {
    await bootstrap();
    await rotateSigningKeys(env, { actorId: 7, force: true, emergency: true });
    const audits = db
      .query<{ user_id: number; action: string; resource_type: string; details: string }, []>(
        "SELECT user_id, action, resource_type, details FROM audit_log WHERE action = 'oidc.keys.rotate' ORDER BY id",
      )
      .all();
    expect(audits).toHaveLength(2);
    expect(audits[0]?.user_id).toBe(1);
    expect(audits[1]?.user_id).toBe(7);
    expect(JSON.parse(audits[0]?.details as string).action).toBe("bootstrapped");
    expect(JSON.parse(audits[1]?.details as string)).toMatchObject({
      action: "rotated",
      forced: true,
    });
    const everything = JSON.stringify(audits);
    for (const row of rows()) {
      expect(everything).not.toContain(row.private_jwk_encrypted);
    }
    expect(everything).not.toContain('"d"');
  });
});

describe("listing", () => {
  test("lists every key with its state and stamps, and never the private half", async () => {
    await bootstrap();
    await rotateSigningKeys(env, { actorId: 1, force: true, emergency: true });
    const keys = await listSigningKeys(env.DB);
    expect(keys).toHaveLength(3);
    const text = JSON.stringify(keys);
    for (const row of rows()) expect(text).not.toContain(row.private_jwk_encrypted);
    expect(text).not.toContain("private");
    const next = keys.find((k) => k.state === "next");
    expect(next?.promotable_at).toBeTruthy();
    expect(keys.find((k) => k.state === "current")?.promotable_at).toBeNull();
    expect(Object.keys(keys[0] ?? {}).sort()).toEqual(
      [
        "alg",
        "created_at",
        "kid",
        "promotable_at",
        "promoted_at",
        "retired_at",
        "revoked_at",
        "state",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Round-1 hardening (review of phase #2016)
// ---------------------------------------------------------------------------------------------

/** Make the next key as old as `interval` says, in SQLite's own date arithmetic. */
const ageNext = (interval: string) =>
  db.run(
    `UPDATE oidc_signing_keys SET created_at = datetime('now', '${interval}') WHERE state = 'next'`,
  );

const auditCount = (): number =>
  (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;

const forceRotate = (actorId = 1) =>
  rotateSigningKeys(env, { actorId, force: true, emergency: true });

describe("--force is not a way to promote a key that has just been published", () => {
  test(`a forced rotation is refused while the next key is under ${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes old, and changes nothing`, async () => {
    await bootstrap();
    const before = JSON.stringify(rows());
    const auditsBefore = auditCount();
    const r = await rotateSigningKeys(env, { actorId: 1, force: true });
    expect(r).toEqual({ ok: false, code: "forced_too_early" });
    expect(JSON.stringify(rows())).toBe(before);
    expect(auditCount()).toBe(auditsBefore);
  });

  test("a minute short of it is still refused; at it, and past it, the force works", async () => {
    await bootstrap();
    ageNext(`-${OIDC_FORCE_MIN_NEXT_AGE_MINUTES - 1} minutes', '-59 seconds`);
    expect((await rotateSigningKeys(env, { actorId: 1, force: true })).ok).toBe(false);
    ageNext(`-${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes`);
    expect((await rotateSigningKeys(env, { actorId: 1, force: true })).ok).toBe(true);
  });

  test("an emergency overrides it, and the audit row says so", async () => {
    await bootstrap();
    const r = await rotateSigningKeys(env, { actorId: 3, force: true, emergency: true });
    expect(r.ok).toBe(true);
    const row = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'oidc.keys.rotate' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(JSON.parse(row?.details as string)).toMatchObject({
      action: "rotated",
      forced: true,
      emergency: true,
    });
  });

  test("it does not apply to the first rotation, or to one that is not forced", async () => {
    // First rotation: there is no next key to be young.
    expect((await rotateSigningKeys(env, { actorId: 1, force: true })).ok).toBe(true);
    // Not forced and under 24 hours: the 24-hour rule answers, not this one.
    const early = await rotateSigningKeys(env, { actorId: 1 });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.code).toBe("too_early");
  });
});

describe("rotation proves the key can be read before it promotes it", () => {
  test("a rotation under another OIDC_SECRET is refused, forced or not, and changes nothing", async () => {
    await bootstrap();
    ageNext("-25 hours");
    const wrong = makeEnv({ OIDC_SECRET: OTHER_SECRET });
    const before = JSON.stringify(rows());
    const auditsBefore = auditCount();
    for (const options of [
      { actorId: 1 },
      { actorId: 1, force: true },
      { actorId: 1, force: true, emergency: true },
    ]) {
      const r = await rotateSigningKeys(wrong, options);
      expect(r, JSON.stringify(options)).toEqual({ ok: false, code: "key_unreadable" });
    }
    expect(JSON.stringify(rows())).toBe(before);
    expect(auditCount()).toBe(auditsBefore);
    // Under the right one it goes through, so the refusal was the secret and nothing else.
    expect((await rotateSigningKeys(env, { actorId: 1 })).ok).toBe(true);
  });

  test("the same check guards the current key when only a next key is to be made", async () => {
    await bootstrap();
    db.run("DELETE FROM oidc_signing_keys WHERE state = 'next'");
    const wrong = makeEnv({ OIDC_SECRET: OTHER_SECRET });
    expect(await rotateSigningKeys(wrong, { actorId: 1 })).toEqual({
      ok: false,
      code: "key_unreadable",
    });
    expect(countIn("next")).toBe(0);
    const right = await rotateSigningKeys(env, { actorId: 1 });
    expect(right.ok && right.action).toBe("next_created");
  });

  test("a ciphertext moved to another row cannot be used: it decrypts to a key the row does not publish", async () => {
    await bootstrap();
    ageNext("-25 hours");
    const current = rows().find((r) => r.state === "current") as KeyRow;
    const next = rows().find((r) => r.state === "next") as KeyRow;
    // Swap the two private halves between the rows. Each ciphertext is perfectly readable.
    db.run("UPDATE oidc_signing_keys SET private_jwk_encrypted = ? WHERE kid = ?", [
      next.private_jwk_encrypted,
      current.kid,
    ]);
    db.run("UPDATE oidc_signing_keys SET private_jwk_encrypted = ? WHERE kid = ?", [
      current.private_jwk_encrypted,
      next.kid,
    ]);
    __resetOidcKeyCachesForTests();
    // It will not sign: the key behind the current row is not the one the current row publishes.
    await expect(signJwt(env, { sub: "x" })).rejects.toThrow(/does not match/);
    // And rotation will not promote it.
    expect(await rotateSigningKeys(env, { actorId: 1 })).toEqual({
      ok: false,
      code: "key_unreadable",
    });
  });

  test("the state read names the private key and the public one it is checked against", () => {
    expect(ROTATION_STATE_SQL).toContain("private_jwk_encrypted");
    expect(ROTATION_STATE_SQL).toContain("public_jwk");
  });
});

describe("signJwt takes the token type, and defaults to JWT", () => {
  test("a logout token names its own type", async () => {
    await bootstrap();
    const logout = await signJwt(env, { events: {} }, { typ: "logout+jwt" });
    expect(JSON.parse(b64urlToText(logout.split(".")[0] as string)).typ).toBe("logout+jwt");
    const plain = await signJwt(env, { sub: "x" });
    expect(JSON.parse(b64urlToText(plain.split(".")[0] as string)).typ).toBe("JWT");
    const key = (await publishedKey(kidIn("current"))) as Record<string, unknown>;
    expect(await verifies(logout, key)).toBe(true);
  });
});

describe("only the keys' own unique violation is a conflict", () => {
  /** A database whose batches fail the way the platform says, with the message D1 gives. */
  const failingBatch = (message: string): D1Database => {
    const real = realD1(db);
    return {
      ...real,
      batch: async () => {
        throw new Error(message);
      },
    } as unknown as D1Database;
  };
  const emergency = { actorId: 1, force: true, emergency: true };

  test("a CHECK that fails during a rotation is thrown, not reported as a conflict", async () => {
    await bootstrap();
    const faulty = makeEnv({
      DB: failingBatch(
        "D1_ERROR: CHECK constraint failed: private_jwk_encrypted: SQLITE_CONSTRAINT",
      ),
    });
    await expect(rotateSigningKeys(faulty, emergency)).rejects.toThrow(/CHECK constraint failed/);
  });

  test("so is another table's unique violation, and another column's", async () => {
    await bootstrap();
    for (const message of [
      "D1_ERROR: UNIQUE constraint failed: audit_log.id: SQLITE_CONSTRAINT",
      "D1_ERROR: UNIQUE constraint failed: oidc_signing_keys.kid: SQLITE_CONSTRAINT",
    ]) {
      const faulty = makeEnv({ DB: failingBatch(message) });
      await expect(rotateSigningKeys(faulty, emergency)).rejects.toThrow(
        /UNIQUE constraint failed/,
      );
    }
  });

  test("the keys' state index, worded as D1 words it, is a conflict", async () => {
    await bootstrap();
    const faulty = makeEnv({
      DB: failingBatch(
        "D1_ERROR: UNIQUE constraint failed: oidc_signing_keys.state: SQLITE_CONSTRAINT",
      ),
    });
    expect(await rotateSigningKeys(faulty, emergency)).toEqual({ ok: false, code: "conflict" });
  });
});

describe("a rotation that read the state before another one finished is a conflict, whatever else changed", () => {
  /**
   * A database that, after the rotation state is read, lets `between` run (other rotations, a
   * revocation) and then hands the stale read back: the writer sees the state as it was, as a request
   * that was slow between its read and its write would.
   */
  function staleAfterRead(between: () => Promise<void>): Bindings {
    const real = realD1(db);
    const stale = {
      ...real,
      prepare(sql: string) {
        const stmt = real.prepare(sql) as unknown as {
          all(): Promise<unknown>;
          bind(...p: unknown[]): unknown;
        };
        if (sql !== ROTATION_STATE_SQL) return stmt;
        return {
          bind: () => stale.prepare(sql),
          all: async () => {
            const result = await stmt.all();
            await between();
            return result;
          },
        };
      },
    } as unknown as D1Database;
    return makeEnv({ DB: stale });
  }

  test("two rotations finished in between: the stale writer's promotion of a key that is no longer next is refused cleanly", async () => {
    await bootstrap();
    ageNext("-25 hours");
    const racer = staleAfterRead(async () => {
      expect((await forceRotate(2)).ok).toBe(true);
      expect((await forceRotate(2)).ok).toBe(true);
    });
    const r = await rotateSigningKeys(racer, { actorId: 1 });
    expect(r).toEqual({ ok: false, code: "conflict" });
    expect(countIn("current")).toBe(1);
    expect(countIn("next")).toBe(1);
    expect(countIn("retired")).toBe(2);
  });

  test("a rotation and a revocation finished in between: the stale writer cannot un-revoke the key it read as current", async () => {
    await bootstrap();
    ageNext("-25 hours");
    const oldCurrent = kidIn("current");
    const racer = staleAfterRead(async () => {
      expect((await forceRotate(2)).ok).toBe(true);
      expect((await revokeSigningKey(env, oldCurrent, 2)).ok).toBe(true);
    });
    const r = await rotateSigningKeys(racer, { actorId: 1 });
    expect(r).toEqual({ ok: false, code: "conflict" });
    expect(rows().find((x) => x.kid === oldCurrent)?.state).toBe("revoked");
  });
});

describe("the published key set fails loudly and is bounded", () => {
  const setPublicJwk = (state: string, jwk: string) =>
    db.run("UPDATE oidc_signing_keys SET public_jwk = ? WHERE state = ?", [jwk, state]);

  test("a current key whose public half is missing y is an error, not a quietly shorter set", async () => {
    await bootstrap();
    setPublicJwk("current", '{"kty":"EC","crv":"P-256","x":"abc"}');
    await expect(jwksDocument(env.DB)).rejects.toThrow(/current key/);
  });

  test("so is a next key", async () => {
    await bootstrap();
    setPublicJwk("next", '{"kty":"EC","crv":"P-256","y":"abc"}');
    await expect(jwksDocument(env.DB)).rejects.toThrow(/next key/);
  });

  test("a retired key with a broken public half is left out, and the rest is published", async () => {
    await bootstrap();
    db.run(
      `INSERT INTO oidc_signing_keys (kid, alg, state, public_jwk, private_jwk_encrypted, promoted_at, retired_at)
       VALUES ('00000000000000d1', 'ES256', 'retired', '{"kty":"EC"}', 'ct', datetime('now', '-2 days'), datetime('now', '-1 days'))`,
    );
    const kids = (
      JSON.parse(await jwksDocument(env.DB)) as { keys: Array<{ kid: string }> }
    ).keys.map((k) => k.kid);
    expect(kids).not.toContain("00000000000000d1");
    expect(kids).toHaveLength(2);
  });

  test(`at most ${OIDC_RETIRED_KEY_PUBLISH_MAX} retired keys are published, the most recently retired`, async () => {
    await bootstrap();
    const kidOf = (i: number) => `000000000000e${i.toString(16).padStart(3, "0")}`;
    for (let i = 1; i <= OIDC_RETIRED_KEY_PUBLISH_MAX + 2; i++) {
      db.run(
        `INSERT INTO oidc_signing_keys (kid, alg, state, public_jwk, private_jwk_encrypted, promoted_at, retired_at)
         VALUES (?, 'ES256', 'retired', '{"kty":"EC","crv":"P-256","x":"a","y":"b"}', 'ct', datetime('now', '-30 days'), datetime('now', ?))`,
        [kidOf(i), `-${i} hours`],
      );
    }
    const kids = (
      JSON.parse(await jwksDocument(env.DB)) as { keys: Array<{ kid: string }> }
    ).keys.map((k) => k.kid);
    // Retired 1 to 5 hours ago are the five newest; 6 and 7 hours ago are not published.
    expect(kids.filter((k) => k.startsWith("000000000000e")).sort()).toEqual(
      Array.from({ length: OIDC_RETIRED_KEY_PUBLISH_MAX }, (_, i) => kidOf(i + 1)).sort(),
    );
  });

  test("a failed read of the keys is an error and not an empty set", async () => {
    await bootstrap();
    const down = wrapD1(realD1(db), (sql) => {
      if (sql.includes("oidc_signing_keys")) throw new Error("the database is down");
    });
    await expect(jwksDocument(down)).rejects.toThrow(/database is down/);
  });
});

describe("revoking a retired key", () => {
  async function twoRetired(): Promise<{ first: string; second: string }> {
    await bootstrap();
    const first = kidIn("current");
    await forceRotate();
    const second = kidIn("current");
    await forceRotate();
    return { first, second };
  }

  test("a revoked key is no longer published and the table says when it was revoked", async () => {
    const { first, second } = await twoRetired();
    expect(await publishedKey(first)).toBeDefined();
    const r = await revokeSigningKey(env, first, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.key.state).toBe("revoked");
    expect(r.key.revoked_at).not.toBeNull();
    // At once, in the isolate that did it: the key set is not served from before.
    expect(await publishedKey(first)).toBeUndefined();
    expect(await publishedKey(second)).toBeDefined();
    expect(rows().find((x) => x.kid === first)?.state).toBe("revoked");
  });

  test("a token it signed no longer verifies against anything that is published", async () => {
    await bootstrap();
    const signedBy = kidIn("current");
    const jwt = await signJwt(env, { sub: "x" });
    await forceRotate();
    expect(await verifies(jwt, (await publishedKey(signedBy)) as Record<string, unknown>)).toBe(
      true,
    );
    await revokeSigningKey(env, signedBy, 1);
    expect(await publishedKey(signedBy)).toBeUndefined();
  });

  test("the current key and the next key cannot be revoked: rotate first", async () => {
    await bootstrap();
    for (const state of ["current", "next"]) {
      const kid = kidIn(state);
      expect(await revokeSigningKey(env, kid, 1)).toEqual({ ok: false, code: "key_not_revocable" });
      expect(rows().find((x) => x.kid === kid)?.state).toBe(state);
    }
  });

  test("an unknown key is not found, and revoking twice changes nothing the second time", async () => {
    const { first } = await twoRetired();
    expect(await revokeSigningKey(env, "00000000000000ff", 1)).toEqual({
      ok: false,
      code: "key_not_found",
    });
    expect((await revokeSigningKey(env, first, 1)).ok).toBe(true);
    const again = await revokeSigningKey(env, first, 1);
    expect(again.ok && again.changed).toBe(false);
    const audits = db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'oidc.keys.revoke'")
      .get() as { n: number };
    expect(audits.n).toBe(1);
  });

  test("the audit row names the key and holds no key material", async () => {
    const { first } = await twoRetired();
    await revokeSigningKey(env, first, 9);
    const row = db
      .query<{ user_id: number; resource_type: string; resource_id: string }, []>(
        "SELECT user_id, resource_type, resource_id, details FROM audit_log WHERE action = 'oidc.keys.revoke'",
      )
      .get();
    expect(row).toMatchObject({
      user_id: 9,
      resource_type: "oidc_signing_key",
      resource_id: first,
    });
    for (const k of rows()) expect(JSON.stringify(row)).not.toContain(k.private_jwk_encrypted);
    expect(JSON.stringify(row)).not.toContain('"d"');
  });

  test("it works on a key whose private half was wiped, and signing never uses a revoked key", async () => {
    const { first } = await twoRetired();
    db.run("UPDATE oidc_signing_keys SET private_jwk_encrypted = NULL WHERE kid = ?", [first]);
    expect((await revokeSigningKey(env, first, 1)).ok).toBe(true);
    const jwt = await signJwt(env, { sub: "x" });
    expect(JSON.parse(b64urlToText(jwt.split(".")[0] as string)).kid).toBe(kidIn("current"));
  });

  test("two revocations of one key that overlap: the second changes nothing and is not audited", async () => {
    const { first } = await twoRetired();
    const real = realD1(db);
    let injected = false;
    const stale = {
      ...real,
      prepare(sql: string) {
        const stmt = real.prepare(sql) as unknown as {
          first(): Promise<unknown>;
          bind(...p: unknown[]): unknown;
        };
        if (sql !== KEY_STATE_SQL) return stmt;
        const wrapper = {
          bind: (...p: unknown[]) => {
            stmt.bind(...p);
            return wrapper;
          },
          first: async () => {
            const result = await stmt.first();
            if (!injected) {
              injected = true;
              // Another request revokes the same key after this one read it as retired.
              expect((await revokeSigningKey(env, first, 8)).ok).toBe(true);
            }
            return result;
          },
        };
        return wrapper;
      },
    } as unknown as D1Database;
    const stamp = () =>
      (
        db.query("SELECT revoked_at FROM oidc_signing_keys WHERE kid = ?").get(first) as {
          revoked_at: string | null;
        }
      ).revoked_at;
    const r = await revokeSigningKey(makeEnv({ DB: stale }), first, 9);
    expect(r.ok).toBe(true);
    expect(r.ok && r.changed).toBe(false);
    expect(injected).toBe(true);
    const audits = db
      .query<{ user_id: number }, []>(
        "SELECT user_id FROM audit_log WHERE action = 'oidc.keys.revoke'",
      )
      .all();
    expect(audits.map((a) => a.user_id)).toEqual([8]);
    expect(stamp()).not.toBeNull();
  });

  test("a key id that is not one is refused before the database is asked", async () => {
    await expect(revokeSigningKey(env, "NOT-A-KID", 1)).rejects.toThrow(/key id/);
  });
});
