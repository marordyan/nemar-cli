/**
 * Back-channel logout delivery (epic #2014 phase #2019; ADR 0119 rule 15; OpenID Connect Back-Channel
 * Logout 1.0): what NEMAR sends to a client that registered a logout address when an account's grants
 * end, when, how often, to whom, and what it records.
 *
 * REAL WORKER, REAL PARTNER. Accounts end through the real routes; the sender makes a real HTTPS
 * request to a stand-in partner on the loopback interface (`helpers/oidc-logout-standin.ts`), which
 * records what it receives and answers as the test says. The stand-in is the PARTNER and nothing else:
 * the signing, the claims, the form, the timeout, the redirect rule, the fence, the claim of an
 * attempt, the retry schedule and what is recorded are all NEMAR's own code. Five tests (all in
 * `describe("the fence")`) give the sender a `fetchImpl`: it records the address the sender asked for and
 * forwards the request to the stand-in. Two run outside production (a fenced host, where it shows that
 * nothing was asked, and a listed host, where it shows that only that host was); three run in production,
 * which refuses a loopback address by design, so the stand-in is reachable only through the shim (one
 * sends to a named host, two refuse an address and assert the shim is never called).
 *
 * The delivery table is read for what the sender WRITES (a status, an attempt count, a time, a fixed
 * word); what a partner is sent is read off the stand-in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  OIDC_BACKCHANNEL_LOGOUT_EVENT,
  OIDC_LOGOUT_ERROR_CLASSES,
  OIDC_LOGOUT_LEASE_SECONDS,
  OIDC_LOGOUT_MAX_ATTEMPTS,
  OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS,
  OIDC_LOGOUT_RETRY_DELAYS_SECONDS,
  OIDC_LOGOUT_TIMEOUT_MS,
} from "../../shared/oidc";
import {
  attemptDueLogouts,
  logoutAddressVerdict,
  parseRetryAfter,
  postLogoutToken,
} from "../src/services/oidc-logout";
import { claimDelivery } from "../src/services/oidc-logout-store";
import {
  type DeliveryRow,
  deliveries,
  registerLogoutClient,
  signInAt,
  subjectOf,
} from "./helpers/oidc-cascade";
import { decodeJwt, registerClient, rotateKeys, seedAccount } from "./helpers/oidc-flow";
import { OWNER_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";
import {
  type LogoutStandin,
  refusedAddress,
  startLogoutStandin,
} from "./helpers/oidc-logout-standin";

let h: OidcHarness;
let partner: LogoutStandin;
const standins: LogoutStandin[] = [];

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  partner = startLogoutStandin();
  standins.push(partner);
});

afterEach(async () => {
  await h.settle();
  while (standins.length > 0) await standins.pop()?.stop();
});

/** A client whose logout address is `uri`, and an account signed in at it. */
async function signedIn(uri: string = partner.url, over: Record<string, unknown> = {}) {
  const client = await registerLogoutClient(h, { backchannel_logout_uri: uri, ...over });
  const userId = seedAccount(h);
  await signInAt(h, userId, client);
  return { client, userId };
}

/** End the account through the owner's real route; the first attempt is handed to `waitUntil`. */
async function endAccount(userId: number): Promise<void> {
  const res = await h.call("POST", `/admin/oidc/accounts/${userId}/end`, {
    key: OWNER_KEY,
    body: { reason: "revoked" },
  });
  expect(res.status).toBe(200);
}

/** Queue a delivery for each of an account's live grants, as the cascade does, without ending anything. */
function queue(userId: number, when = "datetime('now')"): void {
  h.db
    .query(
      `INSERT INTO oidc_logout_deliveries (client_id, sub, reason, next_attempt_at)
       SELECT g.client_id, u.oidc_subject, 'account_revoked', ${when}
         FROM oidc_grants g JOIN users u ON u.id = g.user_id WHERE g.user_id = ?`,
    )
    .run(userId);
}

function only(userId?: number): DeliveryRow {
  const rows = deliveries(h, userId);
  expect(rows.length).toBe(1);
  return rows[0] as DeliveryRow;
}

/** Make every pending delivery due now, as the passing of its wait would. */
function makeDue(): void {
  h.db
    .query(
      "UPDATE oidc_logout_deliveries SET next_attempt_at = datetime('now', '-1 seconds') WHERE status = 'pending'",
    )
    .run();
}

/** Seconds from now to a delivery's `next_attempt_at`, by the database's own clock. */
function secondsUntilNext(id: number): number {
  return (
    h.db
      .query<{ s: number }, [number]>(
        `SELECT CAST(strftime('%s', next_attempt_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER) AS s
           FROM oidc_logout_deliveries WHERE id = ?`,
      )
      .get(id)?.s ?? Number.NaN
  );
}

const within = (actual: number, expected: number, slack = 5) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(slack);

/** The published key set, read from the real endpoint. */
async function publishedKeys(): Promise<Array<Record<string, string>>> {
  const res = await h.call("GET", "/oauth/jwks");
  expect(res.status).toBe(200);
  return (res.json as { keys: Array<Record<string, string>> }).keys;
}

/** Verify a compact ES256 token against the key set, exactly as a partner would. */
async function verifies(token: string): Promise<boolean> {
  const [head, body, sig] = token.split(".") as [string, string, string];
  const { header } = decodeJwt(token);
  const jwk = (await publishedKeys()).find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const raw = Uint8Array.from(
    atob(sig.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (sig.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    raw,
    new TextEncoder().encode(`${head}.${body}`),
  );
}

describe("the logout token", () => {
  test("is a signed logout+jwt with the required claims, and is the only thing sent", async () => {
    const { client, userId } = await signedIn();
    const before = Math.floor(Date.now() / 1000);

    await endAccount(userId);
    await h.settle();

    expect(partner.requests.length).toBe(1);
    const req = partner.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.path).toBe("/oidc/logout");
    expect(req?.headers["content-type"]).toMatch(/^application\/x-www-form-urlencoded/);
    // Nothing but the signed token goes to a partner's server: no credential, no cookie, no secret.
    for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key"]) {
      expect(req?.headers[name]).toBeUndefined();
    }
    expect([...(req?.form.keys() ?? [])]).toEqual(["logout_token"]);

    const token = req?.form.get("logout_token") as string;
    const { header, claims } = decodeJwt(token);
    expect(header.typ).toBe("logout+jwt");
    expect(header.alg).toBe("ES256");
    expect(await verifies(token)).toBe(true);

    expect(Object.keys(claims).sort()).toEqual([
      "aud",
      "events",
      "exp",
      "iat",
      "iss",
      "jti",
      "sub",
    ]);
    expect(claims.iss).toBe("https://api.nemar.org");
    expect(claims.aud).toBe(client.clientId);
    expect(claims.sub).toBe(subjectOf(h, userId));
    expect(claims.events).toEqual({ [OIDC_BACKCHANNEL_LOGOUT_EVENT]: {} });
    expect(claims.jti).toMatch(/^[0-9a-f]{32}$/);
    const iat = claims.iat as number;
    expect(iat).toBeGreaterThanOrEqual(before - 1);
    expect(iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
    // Two minutes, as the issue says: a literal, so a changed constant is a changed test.
    expect((claims.exp as number) - iat).toBe(120);
    // A logout token never carries a nonce (OpenID Connect Back-Channel Logout 1.0, 2.4), or a reason.
    expect("nonce" in claims).toBe(false);
    expect("sid" in claims).toBe(false);

    const row = only(userId);
    expect(row).toMatchObject({
      status: "sent",
      attempts: 1,
      last_status: 200,
      next_attempt_at: null,
    });
    expect(row.sent_at).not.toBeNull();
    expect(row.jti).toBe(claims.jti as string);
  });

  test("a 204 is as good as a 200", async () => {
    partner.respond(() => new Response(null, { status: 204 }));
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();
    expect(only(userId)).toMatchObject({ status: "sent", last_status: 204 });
  });

  test("every token has its own jti, across clients and across attempts", async () => {
    partner.respond(() => new Response(null, { status: 503 }));
    const other = startLogoutStandin();
    standins.push(other);
    other.respond(() => new Response(null, { status: 503 }));
    const a = await signedIn(partner.url);
    const clientB = await registerLogoutClient(h, { backchannel_logout_uri: other.url });
    await signInAt(h, a.userId, clientB);

    await endAccount(a.userId);
    await h.settle();
    makeDue();
    await attemptDueLogouts(h.env, {});

    const seen = [...partner.requests, ...other.requests].map(
      (r) => decodeJwt(r.form.get("logout_token") as string).claims.jti,
    );
    expect(seen.length).toBe(4);
    expect(new Set(seen).size).toBe(4);
  });

  test("a token is short-lived: the retry of a delivery is a NEW token, never the first one again", async () => {
    partner.respond((_req, n) => new Response(null, { status: n === 1 ? 503 : 200 }));
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();
    const first = partner.requests[0]?.form.get("logout_token");
    makeDue();
    await attemptDueLogouts(h.env, {});
    const second = partner.requests[1]?.form.get("logout_token");
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(only(userId)).toMatchObject({ status: "sent", attempts: 2 });
  });
});

describe("what the partner answers", () => {
  test("a 5xx is retried at 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, then failed", async () => {
    partner.respond(() => new Response("down", { status: 503 }));
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();

    for (let attempt = 1; attempt <= OIDC_LOGOUT_MAX_ATTEMPTS; attempt++) {
      const row = only(userId);
      expect(row.attempts).toBe(attempt);
      expect(row.last_status).toBe(503);
      expect(row.last_error_class).toBe("http_5xx");
      if (attempt < OIDC_LOGOUT_MAX_ATTEMPTS) {
        expect(row.status).toBe("pending");
        // The wait before the NEXT attempt is the schedule's, by the database's clock.
        within(secondsUntilNext(row.id), OIDC_LOGOUT_RETRY_DELAYS_SECONDS[attempt - 1] as number);
        makeDue();
        await attemptDueLogouts(h.env, {});
      }
    }

    const last = only(userId);
    expect(last).toMatchObject({
      status: "failed",
      attempts: OIDC_LOGOUT_MAX_ATTEMPTS,
      next_attempt_at: null,
      sent_at: null,
    });
    expect(partner.requests.length).toBe(OIDC_LOGOUT_MAX_ATTEMPTS);
    // A failed delivery is never taken up again.
    makeDue();
    const tally = await attemptDueLogouts(h.env, {});
    expect(tally.examined).toBe(0);
    expect(partner.requests.length).toBe(OIDC_LOGOUT_MAX_ATTEMPTS);
    // The schedule of the issue, as literals: a changed constant is a changed test.
    expect(OIDC_LOGOUT_RETRY_DELAYS_SECONDS).toEqual([60, 300, 1800, 7200, 43200]);
    expect(OIDC_LOGOUT_MAX_ATTEMPTS).toBe(6);
  });

  test("a 4xx is failed at once and not retried, whichever 4xx it is (408 and 429 are the exceptions)", async () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      h.db.query("DELETE FROM oidc_logout_deliveries").run();
      const before = partner.requests.length;
      partner.respond(() => new Response("no", { status }));
      const { userId } = await signedIn();
      await endAccount(userId);
      await h.settle();
      expect(only(userId), `status ${status}`).toMatchObject({
        status: "failed",
        attempts: 1,
        last_status: status,
        last_error_class: "http_4xx",
        next_attempt_at: null,
      });
      makeDue();
      await attemptDueLogouts(h.env, {});
      expect(partner.requests.length - before, `status ${status}`).toBe(1);
    }
  });

  test("a redirect is not followed, and is failed", async () => {
    const elsewhere = startLogoutStandin();
    standins.push(elsewhere);
    partner.respond(
      () => new Response(null, { status: 302, headers: { Location: elsewhere.url } }),
    );
    const { userId } = await signedIn();

    await endAccount(userId);
    await h.settle();

    expect(partner.requests.length).toBe(1);
    // THE point: the token was handed to the registered address and to no other.
    expect(elsewhere.requests.length).toBe(0);
    expect(only(userId)).toMatchObject({
      status: "failed",
      attempts: 1,
      last_status: 302,
      last_error_class: "redirect",
    });
  });

  test("every redirect status is refused, not only 302", async () => {
    for (const status of [301, 303, 307, 308]) {
      const elsewhere = startLogoutStandin();
      standins.push(elsewhere);
      partner.respond(() => new Response(null, { status, headers: { Location: elsewhere.url } }));
      const { userId } = await signedIn();
      await endAccount(userId);
      await h.settle();
      expect(elsewhere.requests.length, `status ${status}`).toBe(0);
      expect(only(userId).last_error_class, `status ${status}`).toBe("redirect");
      h.db.query("DELETE FROM oidc_logout_deliveries").run();
    }
  });

  test("an answer that is neither 200, 204, a redirect, a 4xx nor a 5xx is failed, not retried", async () => {
    partner.respond(() => new Response("accepted", { status: 202 }));
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();
    expect(only(userId)).toMatchObject({
      status: "failed",
      last_status: 202,
      last_error_class: "http_other",
    });
  });

  test("the answer's body is never read: an endless one does not hold the attempt", async () => {
    // 200 with a body that never ends. The sender stops at the status line and cancels the body, so
    // a partner cannot make NEMAR read without bound.
    partner.respond(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(65536)));
            },
          }),
          { status: 200 },
        ),
    );
    const { userId } = await signedIn();
    const started = Date.now();
    await endAccount(userId);
    await h.settle();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(only(userId)).toMatchObject({ status: "sent", last_status: 200 });
  });

  test("no answer inside the timeout is retried, with the class timeout", async () => {
    partner.respond(() => new Promise<Response>(() => {}));
    const { userId } = await signedIn();
    await endAccount(userId);
    // The shipped timeout is 5 seconds; this test waits for it, which is what proves the constant.
    expect(OIDC_LOGOUT_TIMEOUT_MS).toBe(5000);
    const started = Date.now();
    await h.settle();
    const waited = Date.now() - started;
    // Five seconds, with the slack of a loaded machine and no more: a constant moved to six fails.
    expect(waited).toBeGreaterThanOrEqual(4800);
    expect(waited).toBeLessThan(6500);
    const row = only(userId);
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      last_status: null,
      last_error_class: "timeout",
    });
    within(secondsUntilNext(row.id), 60);
  }, 20_000);

  test("a timeout can be shortened for a caller that has less time", async () => {
    partner.respond(() => new Promise<Response>(() => {}));
    const { userId } = await signedIn();
    queue(userId);
    const started = Date.now();
    const tally = await attemptDueLogouts(h.env, { timeoutMs: 250 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(tally.retried).toBe(1);
    expect(only(userId).last_error_class).toBe("timeout");
  });

  test("a connection that cannot be made is retried, with the class network", async () => {
    const { userId } = await signedIn(await refusedAddress());
    await endAccount(userId);
    await h.settle();
    const row = only(userId);
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      last_status: null,
      last_error_class: "network",
    });
    within(secondsUntilNext(row.id), 60);
  });

  test("what is recorded is a fixed word and a status, never the text of an error or an answer", async () => {
    partner.respond(() => new Response("secret-partner-text token=abc123", { status: 500 }));
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();
    const row = only(userId);
    expect(OIDC_LOGOUT_ERROR_CLASSES as readonly string[]).toContain(
      row.last_error_class as string,
    );
    expect(JSON.stringify(row)).not.toContain("secret-partner-text");
    expect(JSON.stringify(row)).not.toContain(partner.url);
  });
});

describe("which answers are retried, which are final, and which are sent", () => {
  // The facts the words rest on. The help of `nemar admin oidc logout-deliveries` and ADR 0119 rule 15 say
  // this table in words, and `test/admin-oidc-cli.test.ts` and `test/adr-0119-wording.unit.test.ts` pin the
  // words; a change to what the sender retries is a change to THIS test first, and then to those words.
  test("every status from 200 to 599, through the real function and a real HTTPS partner", async () => {
    const server = startLogoutStandin((req) => {
      return new Response(null, { status: Number(req.path.split("/").pop()) });
    });
    standins.push(server);
    const base = server.url.replace(/\/oidc\/logout$/, "/status");
    const groups = new Map<string, number[]>();
    for (let status = 200; status <= 599; status++) {
      const out = await postLogoutToken(`${base}/${status}`, "token");
      const key = out.kind === "sent" ? "sent" : `${out.kind}:${out.errorClass}`;
      groups.set(key, [...(groups.get(key) ?? []), status]);
    }
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const without = (xs: number[], drop: number[]) => xs.filter((x) => !drop.includes(x));
    expect(Object.fromEntries(groups)).toEqual({
      // Sent: exactly these two.
      sent: [200, 204],
      // Final, never retried: any other 2xx, every redirect, and a 4xx other than 408 and 429.
      "failed:http_other": without(range(201, 299), [204]),
      "failed:redirect": range(300, 399),
      "failed:http_4xx": without(range(400, 499), [408, 429]),
      // Retried, on the schedule: a 408, a 429 and every 5xx.
      "retry:http_throttled": [408, 429],
      "retry:http_5xx": range(500, 599),
    });
  }, 60_000);

  test("no answer in time and a connection that cannot be made are retried too", async () => {
    const hang = startLogoutStandin(() => new Promise<Response>(() => {}));
    standins.push(hang);
    expect(await postLogoutToken(hang.url, "token", { timeoutMs: 200 })).toEqual({
      kind: "retry",
      status: null,
      errorClass: "timeout",
    });
    expect(await postLogoutToken(await refusedAddress(), "token", { timeoutMs: 2000 })).toEqual({
      kind: "retry",
      status: null,
      errorClass: "network",
    });
  });

  test("a token NEMAR could not sign is retried as well (sign_failed), and a spent schedule is failed", async () => {
    // With no signing key nothing is requested and the attempt is a retry: NEMAR's fault, not the partner's.
    const fresh = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
    const client = await registerClient(fresh, { backchannel_logout_uri: partner.url });
    const userId = seedAccount(fresh);
    fresh.db
      .query(
        "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) SELECT ?, id, '[\"openid\"]', 'user' FROM oidc_clients WHERE client_id = ?",
      )
      .run(userId, client.clientId);
    fresh.db
      .query(
        `INSERT INTO oidc_logout_deliveries (client_id, sub, reason, next_attempt_at)
         SELECT g.client_id, u.oidc_subject, 'account_revoked', datetime('now')
           FROM oidc_grants g JOIN users u ON u.id = g.user_id WHERE g.user_id = ?`,
      )
      .run(userId);
    const tally = await attemptDueLogouts(fresh.env, {});
    expect(tally).toMatchObject({ examined: 1, retried: 1, failed: 0 });
    expect(partner.requests.length).toBe(0);
    expect(
      fresh.db.query("SELECT status, last_error_class FROM oidc_logout_deliveries").get(),
    ).toEqual({ status: "pending", last_error_class: "sign_failed" });
  });
});

describe("a partner that is throttling", () => {
  /** End an account at a partner that answers `status` with `headers`, and say what was recorded. */
  async function throttled(status: number, headers: Record<string, string> = {}) {
    h.db.query("DELETE FROM oidc_logout_deliveries").run();
    partner.respond(() => new Response("slow down", { status, headers }));
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();
    const row = only(userId);
    return { row, wait: secondsUntilNext(row.id) };
  }

  test("a 408 and a 429 are retried on the schedule, with their own class", async () => {
    for (const status of [408, 429]) {
      const { row, wait } = await throttled(status);
      expect(row, `status ${status}`).toMatchObject({
        status: "pending",
        attempts: 1,
        last_status: status,
        last_error_class: "http_throttled",
      });
      within(wait, 60);
    }
  });

  test("a Retry-After is a LOWER bound for the wait, and only a lower bound", async () => {
    // Longer than the schedule's 60 seconds: the partner's word.
    within((await throttled(429, { "Retry-After": "600" })).wait, 600);
    // Shorter: the schedule's wait stays, and the partner cannot make NEMAR retry sooner.
    within((await throttled(429, { "Retry-After": "5" })).wait, 60);
    within((await throttled(429, { "Retry-After": "0" })).wait, 60);
  });

  test("a Retry-After date is read as seconds from now", async () => {
    const inHalfAnHour = new Date(Date.now() + 1800_000).toUTCString();
    within((await throttled(429, { "Retry-After": inHalfAnHour })).wait, 1800);
    const past = new Date(Date.now() - 3600_000).toUTCString();
    within((await throttled(429, { "Retry-After": past })).wait, 60);
  });

  test("a huge Retry-After is capped at 12 hours, however many digits it has", async () => {
    // Just over the cap, then 9, 12 and 25 digits, then one too long to be a finite number: a partner
    // that asks for the longest wait gets the longest wait, and is never read as having asked for none.
    for (const value of [
      "43201",
      "999999999",
      "9".repeat(12),
      "9".repeat(25),
      "9".repeat(400),
      `${"0".repeat(30)}86400`,
    ]) {
      const { wait } = await throttled(429, { "Retry-After": value });
      expect(Math.abs(wait - 43200), `${value.length} characters`).toBeLessThanOrEqual(5);
    }
    const farFuture = new Date(Date.now() + 90 * 86400_000).toUTCString();
    within((await throttled(429, { "Retry-After": farFuture })).wait, 43200);
  });

  test("a Retry-After just under the cap is kept as it is", async () => {
    within((await throttled(429, { "Retry-After": "43199" })).wait, 43199);
    within((await throttled(429, { "Retry-After": "43200" })).wait, 43200);
  });

  test("a Retry-After that is not one is ignored", async () => {
    for (const value of [
      "soon",
      "-5",
      "",
      "1e3",
      "60 seconds",
      "12.5",
      "0x10",
      // An ISO date parses as a date to JavaScript and is not an HTTP-date.
      "2099-01-01T00:00:00Z",
    ]) {
      within((await throttled(429, { "Retry-After": value })).wait, 60);
    }
  });

  test("it never adds an attempt: a partner that throttles forever gets six requests, then failed", async () => {
    partner.respond(
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }),
    );
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();
    for (let attempt = 1; attempt < OIDC_LOGOUT_MAX_ATTEMPTS; attempt++) {
      makeDue();
      await attemptDueLogouts(h.env, {});
    }
    expect(only(userId)).toMatchObject({
      status: "failed",
      attempts: 6,
      last_status: 429,
      last_error_class: "http_throttled",
      next_attempt_at: null,
    });
    makeDue();
    await attemptDueLogouts(h.env, {});
    expect(partner.requests.length).toBe(6);
  });

  test("a later attempt waits its own scheduled time, or the partner's if that is longer", async () => {
    partner.respond(() => new Response(null, { status: 429, headers: { "Retry-After": "100" } }));
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();
    makeDue();
    await attemptDueLogouts(h.env, {});
    // Attempt 2 waits the schedule's 300 seconds, not the partner's 100.
    within(secondsUntilNext(only(userId).id), 300);
  });

  test("Retry-After is read from a throttled answer only: a 503 keeps the schedule", async () => {
    within((await throttled(503, { "Retry-After": "600" })).wait, 60);
  });
});

describe("parseRetryAfter, the one place a partner's Retry-After is read", () => {
  const NOW = Date.UTC(2030, 0, 1, 12, 0, 0);
  const CAP = OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS;

  test("the cap is twelve hours", () => {
    expect(CAP).toBe(43200);
  });

  test("a run of digits of ANY length is a number of seconds, and is never more than the cap", () => {
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter("60", NOW)).toBe(60);
    expect(parseRetryAfter("007", NOW)).toBe(7);
    expect(parseRetryAfter(" 60 ", NOW)).toBe(60);
    expect(parseRetryAfter("43200", NOW)).toBe(CAP);
    expect(parseRetryAfter("43201", NOW)).toBe(CAP);
    for (const digits of [10, 11, 12, 18, 25, 100, 400, 5000]) {
      // 11 digits and more were once read as no header at all, which gave the partner that asked for
      // the longest wait the shortest one; 400 digits is not a finite number and is still the cap.
      expect(parseRetryAfter("9".repeat(digits), NOW), `${digits} digits`).toBe(CAP);
    }
    expect(parseRetryAfter("0".repeat(5000), NOW)).toBe(0);
    expect(parseRetryAfter(`${"0".repeat(5000)}60`, NOW)).toBe(60);
  });

  test("an HTTP date is seconds from now, never negative and never more than the cap", () => {
    const at = (ms: number) => new Date(NOW + ms).toUTCString();
    expect(parseRetryAfter(at(90_000), NOW)).toBe(90);
    // An HTTP date has a resolution of one second, so a date is read to the second.
    expect(parseRetryAfter(at(1_000), NOW)).toBe(1);
    expect(parseRetryAfter(at(-3_600_000), NOW)).toBe(0);
    expect(parseRetryAfter(at(30 * 86400_000), NOW)).toBe(CAP);
    expect(parseRetryAfter(at(CAP * 1000), NOW)).toBe(CAP);
  });

  test("anything else is no Retry-After at all", () => {
    for (const value of [
      null,
      "",
      " ",
      "-5",
      "+60",
      "1e3",
      "12.5",
      "0x10",
      "60 seconds",
      "soon",
      "NaN",
      "Infinity",
      "\u0666\u0660",
      "2099-01-01T00:00:00Z",
      "Tue, not a date",
    ]) {
      expect(parseRetryAfter(value, NOW), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("the claim of an attempt", () => {
  test("two runners at once send one request, and the delivery is attempted once", async () => {
    const { userId } = await signedIn();
    // Queue without sending: the harness's first attempt is not started by a direct statement.
    queue(userId);
    partner.respond(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return new Response(null, { status: 200 });
    });

    const [a, b] = await Promise.all([attemptDueLogouts(h.env, {}), attemptDueLogouts(h.env, {})]);

    expect(partner.requests.length).toBe(1);
    expect(a.sent + b.sent).toBe(1);
    expect(only(userId)).toMatchObject({ status: "sent", attempts: 1 });
  });

  test("the claim holds the row for two minutes, by the database's clock, and a run in the meantime finds nothing due", async () => {
    // Deterministic: the claim is made directly and nothing is sent, so what is read is the lease the
    // claim statement wrote, not how long an attempt happened to take.
    const { userId } = await signedIn();
    queue(userId);
    const row = only(userId);
    expect(await claimDelivery(h.env.DB, row.id, 0, "1".repeat(32))).toBe(true);

    expect(OIDC_LOGOUT_LEASE_SECONDS).toBe(120);
    within(secondsUntilNext(row.id), 120);
    // A lease shorter than the timeout would let a second runner send while the first still waits.
    expect(OIDC_LOGOUT_LEASE_SECONDS * 1000).toBeGreaterThan(OIDC_LOGOUT_TIMEOUT_MS);

    const second = await attemptDueLogouts(h.env, {});
    expect(second.examined).toBe(0);
    expect(partner.requests.length).toBe(0);
    expect(only(userId)).toMatchObject({ status: "pending", attempts: 1, jti: "1".repeat(32) });
  });

  test("an attempt that was claimed and never recorded is taken up again when its claim lapses", async () => {
    // The isolate was evicted between the claim and the record: nothing was sent, nothing was recorded,
    // and the row is due again when the lease ends (here, the lease moved into the past in SQL).
    const { userId } = await signedIn();
    queue(userId);
    const row = only(userId);
    expect(await claimDelivery(h.env.DB, row.id, 0, "2".repeat(32))).toBe(true);
    makeDue();

    const tally = await attemptDueLogouts(h.env, {});

    expect(tally).toMatchObject({ examined: 1, sent: 1 });
    expect(partner.requests.length).toBe(1);
    // It counted: the lapsed claim was attempt 1 and this one is attempt 2, so the bound still holds.
    expect(only(userId)).toMatchObject({ status: "sent", attempts: 2 });
    expect(only(userId).jti).not.toBe("2".repeat(32));
  });

  test("the sixth attempt is still made after five claims that never recorded", async () => {
    const { userId } = await signedIn();
    queue(userId);
    const id = only(userId).id;
    for (let attempt = 0; attempt < OIDC_LOGOUT_MAX_ATTEMPTS - 1; attempt++) {
      expect(await claimDelivery(h.env.DB, id, attempt, `${attempt}`.repeat(32))).toBe(true);
      makeDue();
    }
    expect(only(userId).attempts).toBe(OIDC_LOGOUT_MAX_ATTEMPTS - 1);

    await attemptDueLogouts(h.env, {});

    expect(partner.requests.length).toBe(1);
    expect(only(userId)).toMatchObject({ status: "sent", attempts: OIDC_LOGOUT_MAX_ATTEMPTS });
  });

  test("with every attempt claimed and none recorded the delivery is failed as unreported, and nothing is sent", async () => {
    const { userId } = await signedIn();
    queue(userId);
    const id = only(userId).id;
    for (let attempt = 0; attempt < OIDC_LOGOUT_MAX_ATTEMPTS; attempt++) {
      expect(await claimDelivery(h.env.DB, id, attempt, `${attempt}`.repeat(32))).toBe(true);
      makeDue();
    }
    expect(only(userId)).toMatchObject({ status: "pending", attempts: OIDC_LOGOUT_MAX_ATTEMPTS });

    const tally = await attemptDueLogouts(h.env, {});

    // Retrying would break the six-request bound, and the partner may already hold a token.
    expect(partner.requests.length).toBe(0);
    expect(tally).toMatchObject({ examined: 1, failed: 1 });
    expect(only(userId)).toMatchObject({
      status: "failed",
      attempts: OIDC_LOGOUT_MAX_ATTEMPTS,
      last_error_class: "unreported",
      next_attempt_at: null,
    });
    // And it is never taken up again.
    makeDue();
    expect((await attemptDueLogouts(h.env, {})).examined).toBe(0);
  });
});

describe("the fence", () => {
  /** A fetch that records what it was asked for and forwards to the stand-in, so "sends nothing" is seen. */
  function recordingFetch(asked: string[]): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      asked.push(String(input));
      return fetch(
        String(input).replace(/^https:\/\/[^/]+/, `https://127.0.0.1:${partner.port}`),
        init,
      );
    }) as typeof fetch;
  }

  test("a dev worker sends to a loopback address", async () => {
    const { userId } = await signedIn();
    await endAccount(userId);
    await h.settle();
    expect(only(userId).status).toBe("sent");
    expect(partner.requests.length).toBe(1);
  });

  test("a dev worker records an unlisted host as fenced and sends nothing", async () => {
    const asked: string[] = [];
    const { userId } = await signedIn("https://partner.example.org/oidc/logout");
    // Direct, with a fetch that would have forwarded the request to the stand-in: it is never called.
    h.db.query("DELETE FROM oidc_logout_deliveries").run();
    queue(userId);
    const tally = await attemptDueLogouts({ ...h.env, ENVIRONMENT: "development" } as never, {
      fetchImpl: recordingFetch(asked),
    });
    expect(tally.fenced).toBe(1);
    expect(asked).toEqual([]);
    expect(partner.requests.length).toBe(0);
    expect(only(userId)).toMatchObject({
      status: "fenced",
      attempts: 0,
      next_attempt_at: null,
      last_error_class: "fenced",
    });
  });

  test("a host listed in OIDC_LOGOUT_DEV_HOSTS is sent to, and only that host", async () => {
    const asked: string[] = [];
    const env = {
      ...h.env,
      OIDC_LOGOUT_DEV_HOSTS: "other.example.net, PARTNER.example.org ",
    } as never;
    const listed = await signedIn("https://partner.example.org/oidc/logout");
    const sibling = await signedIn("https://sub.partner.example.org/oidc/logout");
    const lookalike = await signedIn("https://evilpartner.example.org/oidc/logout");
    h.db.query("DELETE FROM oidc_logout_deliveries").run();
    for (const userId of [listed.userId, sibling.userId, lookalike.userId]) {
      queue(userId);
    }

    await attemptDueLogouts(env, { fetchImpl: recordingFetch(asked) });

    expect(asked).toEqual(["https://partner.example.org/oidc/logout"]);
    expect(only(listed.userId).status).toBe("sent");
    expect(only(sibling.userId).status).toBe("fenced");
    expect(only(lookalike.userId).status).toBe("fenced");
  });

  test("in production a named https host is sent to", async () => {
    const asked: string[] = [];
    const env = {
      ...h.env,
      ENVIRONMENT: "production",
    } as never;
    const { userId } = await signedIn("https://partner.example.org/oidc/logout");
    h.db.query("DELETE FROM oidc_logout_deliveries").run();
    queue(userId);

    // The production Worker has no route to a loopback stand-in; the shim forwards the request there.
    await attemptDueLogouts(env, { fetchImpl: recordingFetch(asked) });

    expect(asked).toEqual(["https://partner.example.org/oidc/logout"]);
    expect(only(userId).status).toBe("sent");
  });

  /** Point a client's stored address at `uri`, as a row that was read at send time and not at registration. */
  function restore(userId: number, uri: string | null): void {
    h.db
      .query(
        "UPDATE oidc_clients SET backchannel_logout_uri = ? WHERE id IN (SELECT client_id FROM oidc_grants WHERE user_id = ?)",
      )
      .run(uri, userId);
  }

  test("in production the list is IGNORED: a loopback or literal host it names is still refused, and nothing is requested", async () => {
    // Both local-or-literal AND listed: the case the list could wrongly admit. A named host would be sent
    // to either way, so it would prove nothing; this one is sent to only if production honours the list.
    const listed = "127.0.0.1,localhost,[::1],10.0.0.5,app.localhost";
    const env = { ...h.env, ENVIRONMENT: "production", OIDC_LOGOUT_DEV_HOSTS: listed } as never;
    for (const uri of [
      "https://127.0.0.1/oidc/logout",
      "https://localhost/oidc/logout",
      "https://[::1]/oidc/logout",
      "https://10.0.0.5/oidc/logout",
      "https://app.localhost/oidc/logout",
    ]) {
      const asked: string[] = [];
      h.db.query("DELETE FROM oidc_logout_deliveries").run();
      const { userId } = await signedIn();
      restore(userId, uri);
      queue(userId);

      const tally = await attemptDueLogouts(env, { fetchImpl: recordingFetch(asked) });

      expect(asked, uri).toEqual([]);
      expect(tally.failed, uri).toBe(1);
      expect(only(userId), uri).toMatchObject({
        status: "failed",
        attempts: 0,
        last_error_class: "address_refused",
        next_attempt_at: null,
      });
    }
    expect(partner.requests.length).toBe(0);
  });

  test("a stored address that is no longer one NEMAR will send to is recorded address_refused, with no request", async () => {
    // Through `attemptDueLogouts`, not the pure verdict: the record of a refusal is what the owner reads.
    const env = { ...h.env, ENVIRONMENT: "production" } as never;
    for (const uri of ["https://localhost/oidc/logout", "https://127.0.0.1:8443/x", null]) {
      const asked: string[] = [];
      h.db.query("DELETE FROM oidc_logout_deliveries").run();
      const { userId } = await signedIn();
      restore(userId, uri);
      queue(userId);
      await attemptDueLogouts(env, { fetchImpl: recordingFetch(asked) });
      expect(asked, String(uri)).toEqual([]);
      expect(only(userId), String(uri)).toMatchObject({
        status: "failed",
        attempts: 0,
        last_error_class: "address_refused",
      });
    }
  });

  test("an environment that is not exactly production is fenced, whatever it is called", async () => {
    // Fail closed the other way from `isNonProductionEnv`: the harm here is a real call, so an unset,
    // mistyped or differently cased value is treated as a dev Worker and sends to nobody.
    for (const environment of [undefined, "", "Production", "production ", "prod", "live"]) {
      const verdict = logoutAddressVerdict(
        { ENVIRONMENT: environment } as never,
        "https://partner.example.org/oidc/logout",
      );
      expect({ environment, verdict }).toEqual({
        environment,
        verdict: { send: false, status: "fenced", errorClass: "fenced" },
      });
    }
  });
});

describe("the address", () => {
  const prod = { ENVIRONMENT: "production" } as never;
  const dev = { ENVIRONMENT: "development" } as never;

  test("production sends to a named https host and refuses every other kind of address", () => {
    expect(logoutAddressVerdict(prod, "https://partner.example.org/oidc/logout")).toEqual({
      send: true,
    });
    expect(logoutAddressVerdict(prod, "https://partner.example.org:8443/logout")).toEqual({
      send: true,
    });
    const refused = { send: false, status: "failed", errorClass: "address_refused" };
    for (const uri of [
      "http://partner.example.org/logout",
      "https://127.0.0.1/logout",
      "https://127.0.0.1:8443/logout",
      "https://localhost/logout",
      "https://localhost./logout",
      "https://app.localhost/logout",
      "https://app.localhost./logout",
      "https://127.1/logout",
      "https://0/logout",
      "https://[::ffff:127.0.0.1]/logout",
      "https://[::1]/logout",
      "https://10.0.0.5/logout",
      "https://169.254.169.254/latest/meta-data",
      "https://[fd00::1]/logout",
      "https://user:pw@partner.example.org/logout",
      "ftp://partner.example.org/logout",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) {
      expect({ uri, verdict: logoutAddressVerdict(prod, uri) }).toEqual({ uri, verdict: refused });
    }
  });

  test("production ignores OIDC_LOGOUT_DEV_HOSTS: it can neither admit a local host nor refuse a named one", () => {
    const listed = "127.0.0.1,localhost,[::1],10.0.0.5,app.localhost,partner.example.org";
    const env = { ENVIRONMENT: "production", OIDC_LOGOUT_DEV_HOSTS: listed } as never;
    for (const uri of [
      "https://127.0.0.1/logout",
      "https://localhost/logout",
      "https://[::1]/logout",
      "https://10.0.0.5/logout",
      "https://app.localhost/logout",
    ]) {
      expect(logoutAddressVerdict(env, uri), uri).toEqual({
        send: false,
        status: "failed",
        errorClass: "address_refused",
      });
    }
    expect(logoutAddressVerdict(env, "https://partner.example.org/logout")).toEqual({ send: true });
    expect(logoutAddressVerdict(env, "https://other.example.org/logout")).toEqual({ send: true });
  });

  test("a trailing dot names the same host, in production and in dev", () => {
    const prod = { ENVIRONMENT: "production" } as never;
    const refused = { send: false, status: "failed", errorClass: "address_refused" };
    for (const uri of [
      "https://localhost./logout",
      "https://localhost../logout",
      "https://app.localhost./logout",
      "https://127.0.0.1./logout",
    ]) {
      expect({ uri, verdict: logoutAddressVerdict(prod, uri) }).toEqual({ uri, verdict: refused });
    }
    const dev = {
      ENVIRONMENT: "development",
      OIDC_LOGOUT_DEV_HOSTS: "partner.example.org",
    } as never;
    // A loopback host, and a listed one, are the same host with their dot.
    expect(logoutAddressVerdict(dev, "https://localhost.:9443/logout")).toEqual({ send: true });
    expect(logoutAddressVerdict(dev, "https://partner.example.org./logout")).toEqual({
      send: true,
    });
    expect(logoutAddressVerdict(dev, "https://other.example.org./logout")).toEqual({
      send: false,
      status: "fenced",
      errorClass: "fenced",
    });
  });

  test("a dev worker's loopback is localhost, 127.0.0.1 and [::1] and nothing like them", () => {
    for (const uri of [
      "https://localhost:9443/logout",
      "https://127.0.0.1:9443/logout",
      "https://[::1]:9443/logout",
    ]) {
      expect({ uri, verdict: logoutAddressVerdict(dev, uri) }).toEqual({
        uri,
        verdict: { send: true },
      });
    }
    for (const uri of [
      "https://127.0.0.2/logout",
      "https://localhost.example.org/logout",
      "https://10.0.0.5/logout",
      "https://169.254.169.254/logout",
      "https://[fd00::1]/logout",
    ]) {
      expect(logoutAddressVerdict(dev, uri)).toEqual({
        send: false,
        status: "fenced",
        errorClass: "fenced",
      });
    }
  });

  test("a dev worker refuses an address that is not https, listed host or not", () => {
    const env = {
      ENVIRONMENT: "development",
      OIDC_LOGOUT_DEV_HOSTS: "partner.example.org,localhost",
    } as never;
    for (const uri of [
      "http://localhost/logout",
      "http://partner.example.org/logout",
      "gopher://localhost/",
    ]) {
      expect(logoutAddressVerdict(env, uri)).toEqual({
        send: false,
        status: "failed",
        errorClass: "address_refused",
      });
    }
  });
});

describe("what is not sent", () => {
  test("a client disabled before the attempt is not told: failed, client_disabled, nothing sent", async () => {
    const { userId, client } = await signedIn();
    h.db.query("DELETE FROM oidc_logout_deliveries").run();
    queue(userId);
    const disabled = await h.call("POST", `/admin/oidc/clients/${client.clientId}/disable`, {
      key: OWNER_KEY,
    });
    expect(disabled.status).toBe(200);

    await attemptDueLogouts(h.env, {});

    expect(partner.requests.length).toBe(0);
    expect(only(userId)).toMatchObject({
      status: "failed",
      attempts: 0,
      last_error_class: "client_disabled",
      next_attempt_at: null,
    });
  });

  test("a delivery whose client row is gone is failed, not an error", async () => {
    h.db
      .query(
        "INSERT INTO oidc_logout_deliveries (client_id, sub, reason, next_attempt_at) VALUES (987654, ?, 'account_revoked', datetime('now'))",
      )
      .run(subjectOf(h, seedAccount(h)));
    const tally = await attemptDueLogouts(h.env, {});
    expect(tally.failed).toBe(1);
    expect(tally.errors).toBe(0);
    expect(only().last_error_class).toBe("client_disabled");
  });

  test("a delivery that is not yet due is left alone", async () => {
    const { userId } = await signedIn();
    queue(userId, "datetime('now', '+1 hour')");
    const tally = await attemptDueLogouts(h.env, {});
    expect(tally.examined).toBe(0);
    expect(partner.requests.length).toBe(0);
    expect(only(userId).attempts).toBe(0);
  });

  test("with no signing key nothing is sent and the delivery waits for the next attempt", async () => {
    // A key that cannot be read is NEMAR's fault and not the partner's: retried, and not failed.
    const fresh = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
    const client = await registerClient(fresh, { backchannel_logout_uri: partner.url });
    const userId = seedAccount(fresh);
    fresh.db
      .query(
        "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) SELECT ?, id, '[\"openid\"]', 'user' FROM oidc_clients WHERE client_id = ?",
      )
      .run(userId, client.clientId);
    fresh.db
      .query(
        "INSERT INTO oidc_logout_deliveries (client_id, sub, reason, next_attempt_at) SELECT g.client_id, u.oidc_subject, 'account_revoked', datetime('now') FROM oidc_grants g JOIN users u ON u.id = g.user_id WHERE g.user_id = ?",
      )
      .run(userId);

    await attemptDueLogouts(fresh.env, {});

    expect(partner.requests.length).toBe(0);
    const row = fresh.db
      .query<DeliveryRow, []>("SELECT * FROM oidc_logout_deliveries")
      .get() as DeliveryRow;
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_error_class: "sign_failed" });
  });
});

describe("the revoking request does not wait for the partner, and a delivery never undoes a revocation", () => {
  test("the owner's route answers while the partner is still silent", async () => {
    partner.respond(() => new Promise<Response>(() => {}));
    const { userId } = await signedIn();
    const started = Date.now();
    await endAccount(userId);
    const answered = Date.now() - started;
    // The call to the partner is handed to waitUntil: the answer does not wait its 5 seconds.
    expect(answered).toBeLessThan(4000);
    expect(deliveries(h, userId).length).toBe(1);
    await h.settle();
  }, 20_000);

  test("admin revoke: a partner that fails leaves the account revoked and its tokens gone", async () => {
    partner.respond(() => new Response("down", { status: 500 }));
    const { userId } = await signedIn();
    const res = await h.call("POST", `/admin/revoke/by-id/${userId}`, { key: OWNER_KEY });
    expect(res.status).toBe(200);
    await h.settle();
    expect(
      h.db.query<{ status: string }, [number]>("SELECT status FROM users WHERE id = ?").get(userId)
        ?.status,
    ).toBe("revoked");
    expect(
      h.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM oidc_tokens WHERE user_id = ? AND revoked_at IS NULL",
        )
        .get(userId)?.n,
    ).toBe(0);
    expect(only(userId)).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error_class: "http_5xx",
    });
  });

  test("owner soft delete, ORCID-free: the logout goes out after the commit", async () => {
    const { userId } = await signedIn();
    const res = await h.call("DELETE", `/admin/users/by-id/${userId}`, { key: OWNER_KEY });
    expect(res.status).toBe(200);
    await h.settle();
    expect(partner.requests.length).toBe(1);
    expect(only(userId)).toMatchObject({ status: "sent", reason: "account_deleted" });
  });
});
