/**
 * The back-channel logout retry tick (epic #2014 phase #2019; ADR 0119 rule 15): every half hour, in
 * production only, attempt the deliveries that are due, a bounded number at a time, each row in its
 * own try and catch, recording a status and a fixed word and nothing else, with one log line.
 *
 * The tick's own behaviour is driven for real (`runOidcLogoutRetryTick` against the real tables and a
 * real HTTPS partner stand-in). Two things are about WIRING and are read off the source, as
 * `cron-sweep-wiring.test.ts` does for the sweeps: that `scheduled()` calls it from the production-only
 * block of the 30-minute branch, and that it is not on `DEV_CRON_ALLOWLIST`. The tick also fences itself
 * (it returns null outside exact production before it reads anything), which is proven here by running
 * it, so the guarantee does not rest on the call site alone.
 *
 * A production Worker refuses a loopback address by design, so the stand-in is reached through a
 * `fetchImpl` that forwards the request to it; the registered address is a named host
 * (`partner.example.org`), which is what production sends to.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEV_CRON_ALLOWLIST } from "../src/index";
import {
  LOGOUT_ROWS_PER_RUN,
  attemptDueLogouts,
  logoutTickLogLine,
  runOidcLogoutRetryTick,
} from "../src/services/oidc-logout";
import { wrapD1 } from "./helpers/d1";
import {
  clientRowId,
  deliveries,
  registerLogoutClient,
  seedProvenAccount,
  signInAt,
  subjectOf,
} from "./helpers/oidc-cascade";
import { rotateKeys } from "./helpers/oidc-flow";
import { type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";
import { type LogoutStandin, startLogoutStandin } from "./helpers/oidc-logout-standin";
import { BAD_OIDC_SECRETS } from "./helpers/oidc-secret";

let h: OidcHarness;
let partner: LogoutStandin;
let userId: number;
let clientRow: number;
let sub: string;
let asked: string[];

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  partner = startLogoutStandin();
  asked = [];
  const client = await registerLogoutClient(h, {
    backchannel_logout_uri: "https://partner.example.org/oidc/logout",
  });
  userId = seedProvenAccount(h);
  await signInAt(h, userId, client);
  await h.settle();
  // The sign-in queued nothing; the first attempt of an ending is not what this file is about.
  h.db.query("DELETE FROM oidc_logout_deliveries").run();
  clientRow = clientRowId(h, client);
  sub = subjectOf(h, userId);
});

afterEach(async () => {
  await partner.stop();
});

const production = () => ({ ...h.env, ENVIRONMENT: "production" }) as never;

/** The transport of a production Worker, which the stand-in's loopback address cannot be reached by. */
const viaStandin = (): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(input));
    return fetch(
      String(input).replace(/^https:\/\/[^/]+/, `https://127.0.0.1:${partner.port}`),
      init,
    );
  }) as typeof fetch;

/** Queue `n` deliveries that are due now (`when` overrides the time). */
function queue(n: number, when = "datetime('now', '-1 minutes')"): void {
  for (let i = 0; i < n; i++) {
    h.db
      .query(
        `INSERT INTO oidc_logout_deliveries (client_id, sub, reason, next_attempt_at)
         VALUES (?, ?, 'account_revoked', ${when})`,
      )
      .run(clientRow, sub);
  }
}

const count = (status: string) =>
  h.db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM oidc_logout_deliveries WHERE status = ?",
    )
    .get(status)?.n ?? 0;

describe("the tick fences itself", () => {
  test("outside exactly production it returns null before it reads or writes anything", async () => {
    queue(3);
    for (const environment of [
      "development",
      "staging",
      "test",
      "",
      undefined,
      "Production",
      "prod",
    ]) {
      const result = await runOidcLogoutRetryTick({ ...h.env, ENVIRONMENT: environment } as never, {
        fetchImpl: viaStandin(),
      });
      expect({ environment, result }).toEqual({ environment, result: null });
    }
    expect(asked).toEqual([]);
    expect(partner.requests.length).toBe(0);
    expect(deliveries(h).map((d) => [d.status, d.attempts])).toEqual([
      ["pending", 0],
      ["pending", 0],
      ["pending", 0],
    ]);
  });
});

describe("a production tick", () => {
  test("attempts what is due, to the registered address, and leaves what is not due", async () => {
    queue(2);
    queue(1, "datetime('now', '+1 hour')");

    const tally = await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });

    expect(tally).toMatchObject({ examined: 2, sent: 2, retried: 0, failed: 0, errors: 0 });
    expect(asked).toEqual([
      "https://partner.example.org/oidc/logout",
      "https://partner.example.org/oidc/logout",
    ]);
    expect(count("sent")).toBe(2);
    expect(count("pending")).toBe(1);
    expect(logoutTickLogLine(tally as never)).toEqual({
      level: "info",
      line: "[oidc-logout] examined=2 sent=2 retried=0 failed=0 fenced=0 lost=0 errors=0 pruned=0",
    });
  });

  test("takes at most 20 a tick, and the next tick takes the rest", async () => {
    expect(LOGOUT_ROWS_PER_RUN).toBe(20);
    queue(25);
    const first = await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });
    expect(first?.examined).toBe(20);
    expect(count("sent")).toBe(20);
    expect(count("pending")).toBe(5);
    const second = await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });
    expect(second?.examined).toBe(5);
    expect(count("sent")).toBe(25);
    expect(partner.requests.length).toBe(25);
  });

  test("a tick with nothing due says nothing", async () => {
    const tally = await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });
    expect(tally).toMatchObject({ examined: 0, errors: 0 });
    expect(logoutTickLogLine(tally as never)).toBeNull();
  });

  test("a finished delivery is never taken up again", async () => {
    queue(1);
    partner.respond(() => new Response("no", { status: 400 }));
    await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });
    expect(count("failed")).toBe(1);
    h.db.query("UPDATE oidc_logout_deliveries SET sent_at = NULL").run();
    const again = await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });
    expect(again?.examined).toBe(0);
    expect(partner.requests.length).toBe(1);
  });

  test("a failing partner makes the line an error, with counts and no text of the partner's", async () => {
    queue(1);
    partner.respond(() => new Response("secret-partner-text", { status: 503 }));
    const tally = await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });
    expect(tally).toMatchObject({ examined: 1, retried: 1 });
    // A retry is routine; a delivery that FAILED for good is what the log raises.
    expect(logoutTickLogLine(tally as never)?.level).toBe("info");
    queue(1);
    partner.respond(() => new Response("secret-partner-text", { status: 400 }));
    const failed = await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });
    const line = logoutTickLogLine(failed as never);
    expect(line?.level).toBe("error");
    expect(line?.line).not.toContain("secret-partner-text");
    expect(line?.line).not.toContain("partner.example.org");
  });
});

describe("one row that cannot be attempted does not stop the others", () => {
  test("a database fault on one delivery is counted by its class, the row is left as it was, and the rest go out", async () => {
    queue(3);
    const [bad] = deliveries(h);
    const faulty = wrapD1(h.env.DB, (sql, binds) => {
      // The claim of the first delivery fails, as a database does under a fault.
      if (
        sql.startsWith("UPDATE oidc_logout_deliveries") &&
        sql.includes("attempts + 1") &&
        binds[2] === bad?.id
      ) {
        throw new TypeError(
          "D1_ERROR with secret-text and https://partner.example.org/oidc/logout",
        );
      }
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const tally = await runOidcLogoutRetryTick(
        { ...h.env, DB: faulty, ENVIRONMENT: "production" } as never,
        { fetchImpl: viaStandin() },
      );
      expect(tally).toMatchObject({ examined: 3, sent: 2, errors: 1, errorClass: "TypeError" });
      const line = logoutTickLogLine(tally as never);
      expect(line?.level).toBe("error");
      expect(line?.line).toContain("errorClass=TypeError");
      expect(line?.line).not.toContain("secret-text");
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining("secret-text"));
    } finally {
      error.mockRestore();
    }
    expect(
      h.db
        .query("SELECT status, attempts FROM oidc_logout_deliveries WHERE id = ?")
        .get(bad?.id as number),
    ).toEqual({
      status: "pending",
      attempts: 0,
    });
    expect(count("sent")).toBe(2);
  });

  test("a failed read of the due rows is an error of the tick, never a throw", async () => {
    const faulty = wrapD1(h.env.DB, (sql) => {
      if (sql.includes("FROM oidc_logout_deliveries d")) throw new RangeError("boom");
    });
    const tally = await runOidcLogoutRetryTick(
      { ...h.env, DB: faulty, ENVIRONMENT: "production" } as never,
      {
        fetchImpl: viaStandin(),
      },
    );
    expect(tally).toMatchObject({ examined: 0, errors: 1, errorClass: "RangeError" });
  });
});

describe("the wiring", () => {
  const INDEX = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8").split("\n");
  const code = INDEX.filter((l) => {
    const t = l.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });

  /** The lines of the block that opens with `opener`, delimited by indentation, searching from `from`. */
  function block(lines: string[], opener: string, from = 0): string[] {
    const start = lines.findIndex((l, i) => i >= from && l.trim() === opener);
    if (start === -1) throw new Error(`block "${opener}" not found`);
    const indent = " ".repeat(lines[start].length - lines[start].trimStart().length);
    const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
    return lines.slice(start + 1, end);
  }

  test("scheduled() calls it from the production-only block of the 30-minute branch, under waitUntil", () => {
    const branch = block(code, "if (event.cron === AUTO_IMPORT_CRON) {");
    const guarded = block(branch, "if (!isNonProductionEnv(env)) {").join("\n");
    expect(guarded).toMatch(/ctx\.waitUntil\(\s*runOidcLogoutRetryTick\(env\)/);
    // And nowhere else in the file: not on the daily tick, not outside the guard.
    expect(code.join("\n").match(/runOidcLogoutRetryTick\(/g)?.length).toBe(1);
  });

  test("it is not on DEV_CRON_ALLOWLIST", () => {
    expect(DEV_CRON_ALLOWLIST as readonly string[]).not.toContain("runOidcLogoutRetryTick");
  });

  test("the name does not carry the word sweep, which would ask cron-sweep-wiring for an entry", () => {
    expect("runOidcLogoutRetryTick".toLowerCase()).not.toContain("sweep");
  });
});

describe("with no usable OIDC_SECRET the tick claims nothing", () => {
  // A claim costs an attempt and signing fails without a secret, so five ticks would end a pending
  // delivery for good. The early return is in `attemptDueLogouts`, which the tick, the first attempt
  // and the test-account sweep all pass through.
  const bad = BAD_OIDC_SECRETS.filter(([what]) =>
    [
      "unset",
      "empty",
      "null",
      "long but no prefix",
      "an uppercase prefix",
      "a trailing newline",
    ].includes(what),
  );

  test.each(bad.map(([what, value]) => [what, value] as const))(
    "%s: attempts stay 0 across ticks, nothing is sent, nothing is pruned, a fixed-word warning each tick only when the secret is malformed",
    async (_what, value) => {
      queue(3);
      // A finished delivery past its retention window: the prune would delete it.
      h.db
        .query(
          `INSERT INTO oidc_logout_deliveries (client_id, sub, reason, status, attempts, next_attempt_at, sent_at, created_at)
           VALUES (?, ?, 'account_revoked', 'sent', 1, NULL, datetime('now', '-400 days'), datetime('now', '-400 days'))`,
        )
        .run(clientRow, sub);
      const before = deliveries(h).map((d) => [d.id, d.status, d.attempts]);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (let tick = 0; tick < 7; tick++) {
          const tally = await runOidcLogoutRetryTick(
            { ...production(), OIDC_SECRET: value } as never,
            { fetchImpl: viaStandin() },
          );
          expect(tally?.skipped).toMatch(/^oidc_secret_(unset|malformed)$/);
          expect(tally).toMatchObject({ examined: 0, sent: 0, retried: 0, failed: 0, pruned: 0 });
          expect(logoutTickLogLine(tally as never)).toBeNull();
        }
        const lines = warn.mock.calls.map((c) => String(c[0]));
        // An absent secret is the provider dark by design and logs nothing; a secret in the wrong
        // form warns once per tick.
        const absent = value === undefined || value === null || value === "";
        expect(lines).toHaveLength(absent ? 0 : 7);
        for (const line of lines) {
          expect(line).toMatch(/^\[oidc-logout\] skipped reason=oidc_secret_(unset|malformed)$/);
          if (typeof value === "string" && value !== "") expect(line).not.toContain(value);
        }
      } finally {
        warn.mockRestore();
      }
      expect(deliveries(h).map((d) => [d.id, d.status, d.attempts])).toEqual(before);
      expect(asked).toEqual([]);
      expect(partner.requests.length).toBe(0);
    },
  );

  test("the first attempt after an ending is skipped the same way, and the word names the state", async () => {
    queue(1);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unset = await attemptDueLogouts({ ...h.env, OIDC_SECRET: undefined } as never, {
        fetchImpl: viaStandin(),
      });
      const malformed = await attemptDueLogouts(
        { ...h.env, OIDC_SECRET: "x".repeat(70) } as never,
        {
          fetchImpl: viaStandin(),
        },
      );
      expect(unset.skipped).toBe("oidc_secret_unset");
      expect(malformed.skipped).toBe("oidc_secret_malformed");
      // Only the malformed one is heard: the unset one is silent.
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        "[oidc-logout] skipped reason=oidc_secret_malformed",
      ]);
    } finally {
      warn.mockRestore();
    }
    expect(deliveries(h).map((d) => d.attempts)).toEqual([0]);
  });

  test("once the secret is valid again the pending delivery is sent, with all five attempts still unspent", async () => {
    queue(1);
    await runOidcLogoutRetryTick({ ...production(), OIDC_SECRET: undefined } as never, {
      fetchImpl: viaStandin(),
    });
    expect(deliveries(h).map((d) => d.attempts)).toEqual([0]);
    const tally = await runOidcLogoutRetryTick(production(), { fetchImpl: viaStandin() });
    expect(tally).toMatchObject({ examined: 1, sent: 1 });
    expect(tally?.skipped).toBeUndefined();
    expect(count("sent")).toBe(1);
  });
});
