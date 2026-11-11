/**
 * A database fault in the FIRST attempt of a logout is logged, as a count and a fixed word (epic #2014
 * phase #2019; ADR 0119 rule 15).
 *
 * The sender never throws: what went wrong is in the tally it returns (`errors`, `errorClass`). The
 * production tick logs that tally. Outside production there is no tick, so the first attempt (from
 * `waitUntil` after a commit, and the sweep's) is the only attempt a dev Worker makes, and a delivery hit
 * by a D1 fault stays `pending`, or is claimed and sent again when its claim lapses, with no trace of why
 * unless the first attempt says so. A `.catch` on a promise that cannot reject said nothing, and was the
 * bug: this file holds the line that replaces it.
 *
 * The fault is a real one, injected where D1 would raise it (`wrapD1`, before the claim statement), and
 * what is read is what the Worker writes to its log: exactly one line, the count and the class of the
 * error, and none of the error's text, an address, a token or a subject.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { firstAttemptLogLine } from "../src/services/oidc-logout";
import { sweepCiTestAccounts } from "../src/services/test-account-sweep";
import { wrapD1 } from "./helpers/d1";
import {
  deliveries,
  registerLogoutClient,
  seedProvenAccount,
  signInAt,
  subjectOf,
} from "./helpers/oidc-cascade";
import { rotateKeys } from "./helpers/oidc-flow";
import { OWNER_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;
let userId: number;
let logged: string[];
let error: ReturnType<typeof spyOn>;

/** A loopback address, so the verdict is to send and the attempt reaches the claim: it is never requested. */
const ADDRESS = "https://127.0.0.1:9/oidc/logout";

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  const client = await registerLogoutClient(h, { backchannel_logout_uri: ADDRESS });
  userId = seedProvenAccount(h);
  await signInAt(h, userId, client);
  await h.settle();
  logged = [];
  error = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  error.mockRestore();
});

const oidcLines = () => logged.filter((l) => l.includes("[oidc-logout]"));

const FAULT = "D1_ERROR with secret-text, https://127.0.0.1:9/oidc/logout and nmu_secret";

function faultOn(match: (sql: string) => boolean, make: () => Error): D1Database {
  return wrapD1(h.env.DB, (sql) => {
    if (match(sql)) throw make();
  });
}

describe("a first attempt that meets a database fault says so", () => {
  test("on the claim: one line, the count and the class, nothing of the error", async () => {
    const faulty = faultOn(
      (sql) => sql.startsWith("UPDATE oidc_logout_deliveries") && sql.includes("attempts + 1"),
      () => new TypeError(FAULT),
    );

    const res = await h.call("POST", `/admin/oidc/accounts/${userId}/end`, {
      key: OWNER_KEY,
      body: { reason: "revoked" },
      env: { DB: faulty },
    });
    await h.settle();

    // The revocation itself landed: a delivery that fails never undoes one.
    expect(res.status).toBe(200);
    expect(oidcLines()).toEqual(["[oidc-logout] first attempt errors=1 errorClass=TypeError"]);
    const line = oidcLines()[0] as string;
    for (const secret of ["secret-text", "127.0.0.1", "nmu_", subjectOf(h, userId), "eyJ"]) {
      expect(line).not.toContain(secret);
    }
    // Nothing was sent and nothing was claimed: the row waits for its next attempt.
    expect(deliveries(h, userId)[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("on the read of what is due: the same line, with that error's class", async () => {
    const faulty = faultOn(
      (sql) => sql.includes("FROM oidc_logout_deliveries d"),
      () => new RangeError(FAULT),
    );
    await h.call("POST", `/admin/oidc/accounts/${userId}/end`, {
      key: OWNER_KEY,
      body: { reason: "revoked" },
      env: { DB: faulty },
    });
    await h.settle();
    expect(oidcLines()).toEqual(["[oidc-logout] first attempt errors=1 errorClass=RangeError"]);
  });

  test("an attempt that meets no fault logs nothing", async () => {
    // Fenced (not loopback, not listed): finished without a request, and without a line.
    h.db
      .query(
        "UPDATE oidc_clients SET backchannel_logout_uri = 'https://partner.example.org/oidc/logout'",
      )
      .run();
    const res = await h.call("POST", `/admin/oidc/accounts/${userId}/end`, {
      key: OWNER_KEY,
      body: { reason: "revoked" },
    });
    await h.settle();
    expect(res.status).toBe(200);
    expect(oidcLines()).toEqual([]);
    expect(deliveries(h, userId)[0]?.status).toBe("fenced");
  });
});

describe("the sweep's attempt says so too", () => {
  test("a fault on the claim is logged by the sweep, which still reports what it swept", async () => {
    h.db
      .query(
        `UPDATE users SET email = 'dcli-oidc-fault-1760000000001-abc123@nemar.test',
                signup_source = 'web', created_at = datetime('now', '-30 days'),
                updated_at = datetime('now', '-30 days') WHERE id = ?`,
      )
      .run(userId);
    const faulty = faultOn(
      (sql) => sql.startsWith("UPDATE oidc_logout_deliveries") && sql.includes("attempts + 1"),
      () => new TypeError(FAULT),
    );

    const swept = await sweepCiTestAccounts({ ...h.env, DB: faulty });

    expect(swept.tombstoned).toBe(1);
    expect(oidcLines()).toEqual(["[oidc-logout] first attempt errors=1 errorClass=TypeError"]);
  });
});

describe("the line itself", () => {
  test("is null without a fault, counts and a class with one, and names an unknown class as such", () => {
    expect(firstAttemptLogLine({ errors: 0, errorClass: null })).toBeNull();
    expect(firstAttemptLogLine({ errors: 2, errorClass: "TypeError" })).toBe(
      "[oidc-logout] first attempt errors=2 errorClass=TypeError",
    );
    expect(firstAttemptLogLine({ errors: 1, errorClass: null })).toBe(
      "[oidc-logout] first attempt errors=1 errorClass=unknown",
    );
  });
});
