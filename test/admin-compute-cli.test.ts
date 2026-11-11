/**
 * `nemar admin compute policy|pool` (epic #2005 phase A2, #2007; ADR 0118), driven through the real
 * entry point against the REAL routes: the Worker's admin router behind its real authentication and
 * admin middleware, over real SQLite carrying every migration, served on a loopback port and reached
 * through TEST_API_URL. Nothing is canned: what the command prints is what the routes answer, and
 * what a command changes is read back from the database.
 *
 * The properties, each with a test of its own:
 *  - `policy set` then `policy show` round trips the owner's policy, and `set` checks the file with
 *    the strict schema before anything is sent (a file that is not a policy sends no request);
 *  - `policy show` parses the answer with an OPEN schema: a response that carries unknown keys at the
 *    top level and nested is shown, not refused, so a released CLI survives the Worker adding a key
 *    (the answer is the real route's with keys added, as a newer Worker would add them);
 *  - `pool grant 12.5` moves 12500 milli-SU, an amount that is not a plain decimal of at most three
 *    places sends nothing, and each invocation sends one fresh Idempotency-Key;
 *  - a platform budget is the owner's, and an admin's attempt exits 1 and changes nothing;
 *  - a member's key exits 1 on every command, and so does no key at all;
 *  - `--json` keeps standard output pure JSON.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  computeEnv,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import { totalsDisagreements } from "../backend/test/helpers/compute-ledger";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { DEFAULT_COMPUTE_POLICY } from "../shared/contract/compute";
import { COMPUTE_IDEMPOTENCY_KEY_RE } from "../shared/contract/compute-admin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let db: Database;
let ids: Record<ComputeWho, number>;
let accountId: number;
let configDir: string;
let requests: Array<{ method: string; path: string; key: string | null }> = [];
/**
 * When set, every answer of the compute routes is the real route's with keys added, as a newer
 * Worker would add them: at the top level, inside the policy, and inside each pool and entry.
 */
let augment = false;

function withFutureKeys(path: string, body: Record<string, any>): Record<string, any> {
  body.future_top_level = { added: "by a newer worker" };
  if (body.policy) {
    body.policy.futureNested = 7;
    body.policy.pipelines.futureDeeper = { x: 1 };
  }
  for (const pool of [...(body.pools ?? []), ...(body.pool ? [body.pool] : [])]) {
    pool.future_pool_key = "p";
  }
  if (body.entry) body.entry.future_entry_key = ["e"];
  return body;
}

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    requests.push({
      method: req.method,
      path: url.pathname + url.search,
      key: req.headers.get("idempotency-key"),
    });
    const res = await handle(req, computeEnv(db));
    if (augment && res.ok && url.pathname.startsWith("/admin/compute/")) {
      const body = withFutureKeys(url.pathname, (await res.json()) as Record<string, any>);
      return Response.json(body, { status: res.status });
    }
    return res;
  },
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

beforeEach(async () => {
  db = freshDb();
  ids = await seedComputeUsers(db);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, service_access, account_kind)
     VALUES ('cmp-holder', 'cmp-holder@example.org', 'x', 'verified', 'member', 'cli', 1, 0, 'person')`,
  );
  accountId = (
    db.query("SELECT id FROM users WHERE username = 'cmp-holder'").get() as { id: number }
  ).id;
  requests = [];
  augment = false;
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function signIn(who: ComputeWho | null): void {
  // No key means no config at all, whatever an earlier command of the test wrote.
  if (who === null) {
    rmSync(join(configDir, "config.json"), { force: true });
    return;
  }
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "computecli",
      accounts: { computecli: { apiKey: COMPUTE_KEYS[who] } },
    }),
  );
}

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(who: ComputeWho | null, args: string[]): Promise<Ran> {
  signIn(who);
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", ...args],
    cwd: REPO_ROOT,
    env: clean,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

const writes = () => requests.filter((r) => r.method !== "GET");
const rows = (sql: string, ...binds: unknown[]) =>
  db.query(sql).all(...(binds as never[])) as any[];
const pool = (word: string) =>
  rows(
    "SELECT * FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ? AND pool = ?",
    String(accountId),
    word,
  )[0];

function policyFile(over: Record<string, unknown> = {}): string {
  const path = join(configDir, `policy-${Math.random().toString(36).slice(2, 8)}.json`);
  const policy = {
    ...structuredClone(DEFAULT_COMPUTE_POLICY),
    defaultGrantMilli: { cpu: 25000, gpu: 2500 },
    maxLiveJobsPerPerson: 6,
    ...over,
  };
  writeFileSync(path, JSON.stringify(policy));
  return path;
}

describe("policy", () => {
  test("show answers the default while none is set, and says so", async () => {
    const r = await runCli("owner", ["policy", "show"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("default");
    expect(r.stdout).toContain('"maxLiveJobsPerPerson": 4');
    const j = await runCli("owner", ["policy", "show", "--json"]);
    const body = JSON.parse(j.stdout);
    expect(body).toMatchObject({ version: null, is_default: true });
    expect(body.policy).toEqual(JSON.parse(JSON.stringify(DEFAULT_COMPUTE_POLICY)));
  });

  test("set then show round trips the policy, and the note", async () => {
    const file = policyFile();
    const set = await runCli("owner", ["policy", "set", "--file", file, "--note", "first policy"]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("version 1");
    const show = await runCli("owner", ["policy", "show", "--json"]);
    const body = JSON.parse(show.stdout);
    expect(body).toMatchObject({
      version: 1,
      is_default: false,
      set_by: ids.owner,
      note: "first policy",
    });
    expect(body.policy.defaultGrantMilli).toEqual({ cpu: 25000, gpu: 2500 });
    expect(body.policy.maxLiveJobsPerPerson).toBe(6);
    const human = await runCli("owner", ["policy", "show"]);
    expect(human.stdout).toContain("version 1");
    expect(human.stdout).toContain("first policy");
    expect(human.stdout).toContain('"maxLiveJobsPerPerson": 6');
    // A second set is the next version, and the audit row names the owner.
    expect(
      (await runCli("owner", ["policy", "set", "--file", policyFile({ maxLiveJobsPerPerson: 2 })]))
        .exitCode,
    ).toBe(0);
    expect(JSON.parse((await runCli("owner", ["policy", "show", "--json"])).stdout).version).toBe(
      2,
    );
    expect(rows("SELECT user_id FROM audit_log WHERE action = 'compute.policy.set'")).toEqual([
      { user_id: ids.owner },
      { user_id: ids.owner },
    ]);
  });

  test("set checks the file before it sends anything", async () => {
    const bad = join(configDir, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({
        ...structuredClone(DEFAULT_COMPUTE_POLICY),
        maxLiveJobsPerPerson: -1,
        futureKey: 1,
      }),
    );
    const invalid = await runCli("owner", ["policy", "set", "--file", bad]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout + invalid.stderr).toContain("maxLiveJobsPerPerson");
    expect(invalid.stdout + invalid.stderr).toMatch(/futureKey|unrecognized/i);
    const notJson = join(configDir, "notjson.json");
    writeFileSync(notJson, "{not json");
    const garbled = await runCli("owner", ["policy", "set", "--file", notJson]);
    expect(garbled.exitCode).toBe(1);
    expect(garbled.stdout + garbled.stderr).toMatch(/not valid JSON/i);
    const missing = await runCli("owner", [
      "policy",
      "set",
      "--file",
      join(configDir, "nope.json"),
    ]);
    expect(missing.exitCode).toBe(1);
    expect((await runCli("owner", ["policy", "set"])).exitCode).not.toBe(0);
    const long = await runCli("owner", [
      "policy",
      "set",
      "--file",
      policyFile(),
      "--note",
      "n".repeat(501),
    ]);
    expect(long.exitCode).toBe(1);
    expect(writes()).toEqual([]);
    expect(rows("SELECT * FROM compute_policy")).toEqual([]);
  });

  test("show parses the answer with an open schema: unknown keys, top level and nested, are shown", async () => {
    await runCli("owner", ["policy", "set", "--file", policyFile()]);
    augment = true;
    const json = await runCli("owner", ["policy", "show", "--json"]);
    expect(json.exitCode).toBe(0);
    const body = JSON.parse(json.stdout);
    expect(body.future_top_level).toEqual({ added: "by a newer worker" });
    expect(body.policy.futureNested).toBe(7);
    expect(body.policy.pipelines.futureDeeper).toEqual({ x: 1 });
    expect(body.version).toBe(1);
    const human = await runCli("owner", ["policy", "show"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("futureNested");
    expect(human.stdout).toContain("futureDeeper");
  });

  test("an admin is refused with exit 1, and nothing is written", async () => {
    const show = await runCli("admin", ["policy", "show"]);
    expect(show.exitCode).toBe(1);
    expect(show.stdout + show.stderr).toMatch(/owner/i);
    const set = await runCli("admin", ["policy", "set", "--file", policyFile()]);
    expect(set.exitCode).toBe(1);
    expect(rows("SELECT * FROM compute_policy")).toEqual([]);
  });

  test("a member's key and no key at all exit 1", async () => {
    expect((await runCli("member", ["policy", "show"])).exitCode).toBe(1);
    expect((await runCli("member", ["policy", "set", "--file", policyFile()])).exitCode).toBe(1);
    const none = await runCli(null, ["policy", "show"]);
    expect(none.exitCode).toBe(1);
    expect(none.stdout + none.stderr).toMatch(/not authenticated/i);
    expect(rows("SELECT * FROM compute_policy")).toEqual([]);
    // Signed out is answered before anything is sent, by every command.
    requests = [];
    for (const args of [
      ["policy", "set", "--file", policyFile()],
      ["pool", "show"],
      ["pool", "show", "--account", String(accountId)],
      ["pool", "grant", "1", "--account", String(accountId), "--pool", "cpu"],
      [
        "pool",
        "adjust",
        "1",
        "--account",
        String(accountId),
        "--pool",
        "cpu",
        "--target",
        "granted",
        "--reason",
        "correction",
      ],
    ]) {
      const r = await runCli(null, args);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
      expect(r.stdout + r.stderr).toMatch(/not authenticated/i);
    }
    expect(requests).toEqual([]);
  });

  test("--json keeps standard output pure JSON, and a failure goes to standard error", async () => {
    const ok = await runCli("owner", ["policy", "show", "--json"]);
    expect(() => JSON.parse(ok.stdout)).not.toThrow();
    const refused = await runCli("admin", ["policy", "show", "--json"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).not.toBe("");
  });
});

describe("pool grant", () => {
  const grantArgs = (amount: string, extra: string[] = []) => [
    "pool",
    "grant",
    amount,
    "--account",
    String(accountId),
    "--pool",
    "cpu",
    ...extra,
  ];

  test("12.5 moves 12500 milli-SU, and says what it did", async () => {
    const r = await runCli("admin", grantArgs("12.5"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("12.5");
    expect(pool("cpu")).toMatchObject({ granted_milli: 12500, held_milli: 0, charged_milli: 0 });
    const entry = rows("SELECT * FROM compute_ledger")[0];
    expect(entry).toMatchObject({
      kind: "grant",
      granted_delta_milli: 12500,
      actor_user_id: ids.admin,
    });
    expect(rows("SELECT * FROM audit_log WHERE action = 'compute.pool.grant'")).toHaveLength(1);
    expect(await totalsDisagreements(realD1(db))).toEqual([]);
  });

  test("a reason and the other word are passed on, and --json prints the answer", async () => {
    const r = await runCli("admin", [
      "pool",
      "grant",
      "3",
      "--account",
      String(accountId),
      "--pool",
      "gpu",
      "--reason",
      "top_up",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.pool).toMatchObject({ pool: "gpu", granted_milli: 3000, available_milli: 3000 });
    expect(body.entry).toMatchObject({
      kind: "grant",
      reason: "top_up",
      granted_delta_milli: 3000,
    });
    expect(body.replayed).toBe(false);
  });

  test("each invocation sends its own fresh Idempotency-Key, so two grants are two", async () => {
    await runCli("admin", grantArgs("1"));
    await runCli("admin", grantArgs("1"));
    const keys = requests.filter((r) => r.method === "POST").map((r) => r.key);
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(COMPUTE_IDEMPOTENCY_KEY_RE.test(k ?? "")).toBe(true);
    expect(new Set(keys).size).toBe(2);
    expect(pool("cpu")?.granted_milli).toBe(2000);
  });

  test("an amount that is not a plain decimal of at most three places sends nothing", async () => {
    for (const amount of [
      "0",
      "0.000",
      "-1",
      "1.5555",
      "abc",
      "1e3",
      "12,5",
      "",
      " 5",
      "5 ",
      "0x10",
      "99999999999999999999",
    ]) {
      const r = await runCli("admin", grantArgs(amount));
      expect([amount, r.exitCode]).toEqual([amount, 1]);
    }
    expect(writes()).toEqual([]);
    expect(rows("SELECT * FROM compute_ledger")).toEqual([]);
  });

  test("needs exactly one of --account and --platform, a pool word, and a numeric account", async () => {
    for (const args of [
      ["pool", "grant", "1", "--pool", "cpu"],
      [
        "pool",
        "grant",
        "1",
        "--account",
        String(accountId),
        "--platform",
        "people",
        "--pool",
        "cpu",
      ],
      ["pool", "grant", "1", "--account", String(accountId)],
      ["pool", "grant", "1", "--account", String(accountId), "--pool", "tpu"],
      ["pool", "grant", "1", "--account", "abc", "--pool", "cpu"],
      ["pool", "grant", "1", "--platform", "Bad Key", "--pool", "cpu"],
      ["pool", "grant", "1", "--platform", "a/b", "--pool", "cpu"],
      // Charset-valid, and not one of the platform's two budgets: refused here, not at the Worker.
      ["pool", "grant", "1", "--platform", "nonesuch", "--pool", "cpu"],
      ["pool", "grant", "1", "--platform", "People", "--pool", "cpu"],
      ["pool", "grant", "1", "--account", "0", "--pool", "cpu"],
      [
        "pool",
        "grant",
        "1",
        "--account",
        String(accountId),
        "--pool",
        "cpu",
        "--reason",
        "Not A Word",
      ],
    ]) {
      const r = await runCli("admin", args);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
    }
    expect(writes()).toEqual([]);
  });

  test("an account that does not exist exits 1", async () => {
    const r = await runCli("admin", ["pool", "grant", "1", "--account", "999999", "--pool", "cpu"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/no such account/i);
  });

  test("a member's key exits 1, and nothing is written", async () => {
    const r = await runCli("member", grantArgs("5"));
    expect(r.exitCode).toBe(1);
    expect(rows("SELECT * FROM compute_ledger")).toEqual([]);
    expect((await runCli(null, grantArgs("5"))).exitCode).toBe(1);
  });

  test("a platform budget is the owner's: an admin exits 1 and changes nothing, an owner grants", async () => {
    const platform = ["pool", "grant", "100", "--platform", "people", "--pool", "cpu"];
    const refused = await runCli("admin", platform);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout + refused.stderr).toMatch(/owner/i);
    expect(rows("SELECT * FROM compute_ledger")).toEqual([]);
    const ok = await runCli("owner", platform);
    expect(ok.exitCode).toBe(0);
    expect(
      rows(
        "SELECT granted_milli FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
      ),
    ).toEqual([{ granted_milli: 100000 }]);
  });
});

describe("pool adjust", () => {
  const adjustArgs = (amount: string, extra: string[] = []) => [
    "pool",
    "adjust",
    amount,
    "--account",
    String(accountId),
    "--pool",
    "cpu",
    "--reason",
    "correction",
    ...extra,
  ];

  test("corrects the grant or the charge, up or down", async () => {
    await runCli("owner", ["pool", "grant", "50", "--platform", "people", "--pool", "cpu"]);
    await runCli("admin", ["pool", "grant", "10", "--account", String(accountId), "--pool", "cpu"]);
    expect(
      (await runCli("admin", adjustArgs("2.5", ["--target", "granted", "--decrease"]))).exitCode,
    ).toBe(0);
    expect(pool("cpu")?.granted_milli).toBe(7500);
    expect((await runCli("owner", adjustArgs("1", ["--target", "charged"]))).exitCode).toBe(0);
    expect(pool("cpu")).toMatchObject({ granted_milli: 7500, charged_milli: 1000 });
    expect(
      rows(
        "SELECT charged_milli FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
      ),
    ).toEqual([{ charged_milli: 1000 }]);
    expect(
      (await runCli("owner", adjustArgs("0.25", ["--target", "charged", "--decrease"]))).exitCode,
    ).toBe(0);
    expect(pool("cpu")?.charged_milli).toBe(750);
    // The platform budget records consumption only: raising the charge raised it, lowering did not.
    expect(
      rows(
        "SELECT charged_milli FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
      ),
    ).toEqual([{ charged_milli: 1000 }]);
    expect(await totalsDisagreements(realD1(db))).toEqual([]);
  });

  test("correcting an account's charge is the owner's for now: an administrator exits 1 and changes nothing", async () => {
    await runCli("owner", ["pool", "grant", "50", "--platform", "people", "--pool", "cpu"]);
    await runCli("admin", ["pool", "grant", "10", "--account", String(accountId), "--pool", "cpu"]);
    const before = rows("SELECT COUNT(*) AS n FROM compute_ledger")[0].n;
    const refused = await runCli("admin", adjustArgs("1", ["--target", "charged"]));
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout + refused.stderr).toMatch(/owner/i);
    expect(rows("SELECT COUNT(*) AS n FROM compute_ledger")[0].n).toBe(before);
    expect(pool("cpu")?.charged_milli).toBe(0);
  });

  test("one that would make a total negative exits 1 and writes nothing", async () => {
    await runCli("admin", ["pool", "grant", "1", "--account", String(accountId), "--pool", "cpu"]);
    const before = rows("SELECT COUNT(*) AS n FROM compute_ledger")[0].n;
    const r = await runCli("admin", adjustArgs("2", ["--target", "granted", "--decrease"]));
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/negative/i);
    expect(rows("SELECT COUNT(*) AS n FROM compute_ledger")[0].n).toBe(before);
  });

  test("needs a target, a reason and a plain decimal, and sends nothing without them", async () => {
    await runCli("admin", ["pool", "grant", "1", "--account", String(accountId), "--pool", "cpu"]);
    const sent = requests.length;
    for (const args of [
      adjustArgs("1"),
      adjustArgs("1", ["--target", "held"]),
      adjustArgs("0", ["--target", "granted"]),
      adjustArgs("-1", ["--target", "granted"]),
      adjustArgs("1.2345", ["--target", "granted"]),
      [
        "pool",
        "adjust",
        "1",
        "--account",
        String(accountId),
        "--pool",
        "cpu",
        "--target",
        "granted",
      ],
    ]) {
      const r = await runCli("admin", args);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
    }
    expect(requests.length).toBe(sent);
  });
});

describe("the answers of the pool commands are read with open schemas too", () => {
  test("pool show, pool show --account and pool grant show and keep keys the Worker added", async () => {
    await runCli("admin", ["pool", "grant", "5", "--account", String(accountId), "--pool", "cpu"]);
    augment = true;
    const list = await runCli("admin", ["pool", "show", "--json"]);
    expect(list.exitCode).toBe(0);
    const listed = JSON.parse(list.stdout);
    expect(listed.future_top_level).toEqual({ added: "by a newer worker" });
    expect(listed.pools.every((p: Record<string, unknown>) => p.future_pool_key === "p")).toBe(
      true,
    );
    const one = JSON.parse(
      (await runCli("admin", ["pool", "show", "--account", String(accountId), "--json"])).stdout,
    );
    expect(one.pools[0].future_pool_key).toBe("p");
    const human = await runCli("admin", ["pool", "show", "--account", String(accountId)]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain("5");
    const granted = await runCli("admin", [
      "pool",
      "grant",
      "1",
      "--account",
      String(accountId),
      "--pool",
      "cpu",
      "--json",
    ]);
    expect(granted.exitCode).toBe(0);
    const body = JSON.parse(granted.stdout);
    expect(body.entry.future_entry_key).toEqual(["e"]);
    expect(body.pool.future_pool_key).toBe("p");
    expect(pool("cpu")?.granted_milli).toBe(6000);
  });
});

describe("pool show", () => {
  test("lists the platform budgets and an account's pools in SU", async () => {
    await runCli("owner", ["pool", "grant", "40", "--platform", "people", "--pool", "cpu"]);
    await runCli("admin", [
      "pool",
      "grant",
      "12.5",
      "--account",
      String(accountId),
      "--pool",
      "cpu",
    ]);
    const all = await runCli("admin", ["pool", "show"]);
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain("platform");
    expect(all.stdout).toContain("people");
    expect(all.stdout).toContain("12.5");
    const one = await runCli("admin", ["pool", "show", "--account", String(accountId)]);
    expect(one.exitCode).toBe(0);
    expect(one.stdout).toContain("cpu");
    expect(one.stdout).toContain("12.5");
    const platform = await runCli("admin", ["pool", "show", "--platform"]);
    expect(platform.stdout).toContain("pipelines");
    expect(platform.stdout).not.toContain(`account ${accountId}`);
    const json = JSON.parse(
      (await runCli("admin", ["pool", "show", "--account", String(accountId), "--json"])).stdout,
    );
    expect(json.pools[0]).toMatchObject({
      pool: "cpu",
      granted_milli: 12500,
      available_milli: 12500,
    });
  });

  test("an account with no pool says so, and a negative available is printed as it is", async () => {
    const none = await runCli("admin", ["pool", "show", "--account", String(accountId)]);
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toMatch(/no pool/i);
    await runCli("admin", ["pool", "grant", "1", "--account", String(accountId), "--pool", "cpu"]);
    db.run(
      "INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, charged_delta_milli, job_id, idempotency_key) VALUES ('overrun', ?, (SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'), 2500, 'job_000000000000000000000003', 'seed-3')",
      [pool("cpu").id],
    );
    const r = await runCli("admin", ["pool", "show", "--account", String(accountId)]);
    expect(r.stdout).toContain("-1.5");
  });

  test("pages with --limit and --after, and refuses what is not a page", async () => {
    const first = JSON.parse(
      (await runCli("admin", ["pool", "show", "--limit", "2", "--json"])).stdout,
    );
    expect(first.pools).toHaveLength(2);
    expect(first.next_after).toBe(first.pools[1].id);
    const next = JSON.parse(
      (
        await runCli("admin", [
          "pool",
          "show",
          "--limit",
          "2",
          "--after",
          String(first.next_after),
          "--json",
        ])
      ).stdout,
    );
    expect(next.pools.map((p: { id: number }) => p.id)).toEqual([3, 4]);
    for (const args of [
      ["--limit", "0"],
      ["--limit", "201"],
      ["--limit", "x"],
      ["--after", "-1"],
      ["--account", "x"],
    ]) {
      const r = await runCli("admin", ["pool", "show", ...args]);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 1]);
    }
  });

  test("a member's key exits 1", async () => {
    expect((await runCli("member", ["pool", "show"])).exitCode).toBe(1);
    expect(
      (await runCli("member", ["pool", "show", "--account", String(accountId)])).exitCode,
    ).toBe(1);
  });
});

describe("a lost answer", () => {
  test("a re-run is a NEW request and grants again, so the help says to look first", async () => {
    await runCli("admin", ["pool", "grant", "1", "--account", String(accountId), "--pool", "cpu"]);
    await runCli("admin", ["pool", "grant", "1", "--account", String(accountId), "--pool", "cpu"]);
    expect(pool("cpu")?.granted_milli).toBe(2000);
    for (const group of [
      ["pool", "grant"],
      ["pool", "adjust"],
    ]) {
      const help = await runCli(null, [...group, "--help-all"]);
      expect(help.stdout).toMatch(/new request/i);
      expect(help.stdout).toContain("pool show");
    }
  });
});

describe("help", () => {
  test("lists the two groups, and each command documents its exit codes", async () => {
    const top = await runCli(null, ["--help"]);
    expect(top.exitCode).toBe(0);
    expect(top.stdout).toContain("policy");
    expect(top.stdout).toContain("pool");
    for (const args of [
      ["policy", "show"],
      ["policy", "set"],
      ["pool", "show"],
      ["pool", "grant"],
      ["pool", "adjust"],
    ]) {
      const r = await runCli(null, [...args, "--help-all"]);
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 0]);
      expect(r.stdout).toContain("Exit codes:");
    }
  });

  test("pool adjust says what a correction does to the platform budget: raising counts, lowering does not", async () => {
    const r = await runCli(null, ["pool", "adjust", "--help-all"]);
    const text = r.stdout.replace(/\s+/g, " ");
    expect(text).toMatch(/consumption only/);
    expect(text).toMatch(/lowering it leaves that budget as it was/);
    // What lowers the budget is said exactly: the final settlement and the owner's own correction.
    expect(text).toMatch(
      /only entries that lower it are a job's final settlement and the owner's own correction of the platform budget/,
    );
    expect(text).toMatch(
      /raise made by mistake is undone against the budget only by the owner's correction of the platform `people` pool/,
    );
    expect(text).not.toMatch(/the one thing that lowers it/);
    // The text that said the budget "follows" a correction, in either direction, is gone.
    expect(text).not.toMatch(/budget of the same word follow/i);
  });
});
