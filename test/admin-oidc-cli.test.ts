/**
 * `nemar admin oidc` (epic #2014 phase #2016; ADR 0119, decision 8), driven through the real entry
 * point against the REAL Worker: its middleware stack, its admin router behind real authentication,
 * and the OpenID Connect owner routes, over real SQLite carrying every migration, served on a
 * loopback port and reached through TEST_API_URL. Nothing is canned: what the command prints is what
 * `/admin/oidc/...` answered.
 *
 * The Worker's issuer is its own `API_BASE_URL`, set to the loopback origin the CLI calls, so the
 * owner routes' host rule is the production one and not bypassed.
 *
 * The properties, each with a test of its own:
 *  - an owner adds a client, lists it, shows it, rotates its secret and disables it; the secret is
 *    printed once, on `add` and `rotate-secret`, and never by `list` or `show`;
 *  - `--json` writes pure JSON to standard output and every sentence to standard error, on success
 *    and on failure;
 *  - signing keys list and rotate, the 24-hour rule refuses and `--force` overrides it, and no
 *    private member is ever printed;
 *  - every refusal exits 1 and prints only the failure: not signed in, not the owner, a bad
 *    argument, a refusal of the registry, and a Worker with the provider off (404, said plainly);
 *  - every command has a help block with "Exit codes:".
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import type { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import worker from "../backend/src/index";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import {
  ADMIN_KEY,
  MEMBER_KEY,
  OIDC_TEST_SECRET,
  OWNER_KEY,
  seedUser,
} from "../backend/test/helpers/oidc-harness";
import { fakeOidcSecret } from "../backend/test/helpers/oidc-secret";
import {
  OIDC_FORCE_MIN_NEXT_AGE_MINUTES,
  OIDC_GRANTS,
  OIDC_KEY_MIN_NEXT_AGE_HOURS,
  OIDC_MAX_REDIRECT_URIS,
  OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS,
  OIDC_RETIRED_KEY_PUBLISH_DAYS,
  OIDC_SCOPE_NAMES,
  OIDC_SECRET_GRACE_HOURS_DEFAULT,
  OIDC_SECRET_GRACE_HOURS_MAX,
  OIDC_SECRET_PREFIX,
} from "../shared/oidc";
import { endAccountQuestion } from "../src/commands/admin-oidc";
import { help } from "./help-output";

// Many of these tests spawn the CLI several times in one test (the "who may run it" walks make 28
// spawns); Bun's default of five seconds is not enough, and the sibling CLI suites raise it the same way.
setDefaultTimeout(30_000);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

let db: Database;
let configDir: string;
let extraEnv: Partial<Bindings> = {};
let requests: Array<{ method: string; path: string }> = [];
let dbHandle: D1Database;

const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/notices") requests.push({ method: req.method, path: url.pathname });
    const env = {
      DB: dbHandle,
      ENVIRONMENT: "development",
      API_BASE_URL: API,
      APP_BASE_URL: "https://app.nemar.org",
      OIDC_SECRET: OIDC_TEST_SECRET,
      ...extraEnv,
    } as unknown as Bindings;
    return worker.fetch(req, env, ctx);
  },
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

beforeEach(async () => {
  db = freshDb();
  dbHandle = realD1(db);
  extraEnv = {};
  requests = [];
  configDir = mkdtempSync(join(tmpdir(), "nemar-oidc-cli-"));
  await seedUser(db, "oidcowner", "owner", OWNER_KEY);
  await seedUser(db, "oidcadmin", "admin", ADMIN_KEY);
  await seedUser(db, "oidcmember", "member", MEMBER_KEY);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function signIn(key: string, account = "oidccliuser"): void {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ activeAccount: account, accounts: { [account]: { apiKey: key } } }),
  );
}

async function runCli(
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
    ...extra,
  };
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "oidc", ...args],
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

/** The flags that make a valid registration, with extras. */
function addArgs(extra: string[] = []): string[] {
  return [
    "clients",
    "add",
    "--name",
    "Example client",
    "--redirect-uri",
    "https://client.example.org/callback",
    "--scopes",
    "openid,profile,email",
    "--grants",
    "authorization_code",
    "--sign-in-rule",
    "active_account",
    "--audience",
    "https://api.example.org",
    ...extra,
  ];
}

interface AddJson {
  client: { client_id: string; name: string; first_party: boolean; status: string };
  client_secret: string;
}

async function addClient(extra: string[] = []): Promise<AddJson> {
  const r = await runCli([...addArgs(extra), "--json"]);
  expect(r.exitCode, r.stdout + r.stderr).toBe(0);
  return JSON.parse(r.stdout) as AddJson;
}

/**
 * Run a command that must fail, both ways: as typed (the sentence is printed, where the CLI prints
 * its failures) and with --json (standard output stays EMPTY, so a script reading it never reads a
 * sentence, and standard error holds the sentence). Returns the sentence of each.
 */
async function failsBothWays(args: string[]): Promise<{ plain: string; json: string }> {
  const typed = await runCli(args);
  expect(typed.exitCode, `${args.join(" ")} (as typed)`).toBe(1);
  const asJson = await runCli([...args, "--json"]);
  expect(asJson.exitCode, `${args.join(" ")} --json`).toBe(1);
  expect(asJson.stdout, `${args.join(" ")} --json: standard output`).toBe("");
  return { plain: typed.stdout + typed.stderr, json: asJson.stderr };
}

const clientRows = () =>
  db.query("SELECT * FROM oidc_clients").all() as Array<Record<string, unknown>>;

// ---------------------------------------------------------------------------------------------

describe("nemar admin oidc clients add", () => {
  test("registers the client, prints its id and its secret once, and the database holds the hash", async () => {
    signIn(OWNER_KEY);
    const r = await runCli(addArgs());
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const id = /oc_[0-9a-f]{24}/.exec(r.stdout)?.[0];
    expect(id).toBeDefined();
    expect(r.stdout).toContain("Example client");
    const secret = /secret[^\n]*:\s*(nmo_cs_[A-Za-z0-9_-]{43})\b/i.exec(r.stdout)?.[1];
    expect(secret, r.stdout).toBeDefined();
    expect(r.stdout).toMatch(/shown (this )?once/i);
    expect(clientRows()).toHaveLength(1);
    const row = clientRows()[0] as Record<string, unknown>;
    expect(row.client_id).toBe(id);
    expect(row.secret_hash).not.toBe(secret);
    expect(JSON.stringify(row)).not.toContain(secret as string);
  });

  test("--json: standard output is the answer and nothing else, standard error holds the sentences", async () => {
    signIn(OWNER_KEY);
    // A first-party client needs NEMAR redirect addresses, so this one is refused...
    const refused = await failsBothWays(addArgs(["--first-party"]));
    expect(refused.json).toContain("first_party");
    expect(refused.plain).toContain("first_party");
    // ...and a valid one prints pure JSON.
    const ok = await runCli([...addArgs(), "--json"]);
    expect(ok.exitCode, ok.stderr).toBe(0);
    const parsed = JSON.parse(ok.stdout) as AddJson;
    expect(parsed.client.status).toBe("active");
    expect(parsed.client_secret).toMatch(/^nmo_cs_[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(JSON.parse(ok.stdout)).sort()).toEqual(["client", "client_secret"]);
  });

  test("every flag reaches the registry", async () => {
    signIn(OWNER_KEY);
    const r = await runCli([
      "clients",
      "add",
      "--name",
      "First party",
      "--redirect-uri",
      "https://app.nemar.org/oauth/callback",
      "--redirect-uri",
      "https://nemar.org/other",
      "--scopes",
      "openid,profile,compute.read",
      "--grants",
      "authorization_code",
      "--sign-in-rule",
      "person_proven_orcid",
      "--audience",
      "https://api.nemar.org",
      "--consent-mode",
      "always",
      "--first-party",
      "--logout-uri",
      "https://app.nemar.org/logout",
      "--introspection-audiences",
      "https://rs.example.org,https://rs2.example.org",
      "--cap-open-reservations",
      "4",
      "--cap-su-per-day",
      "1000",
      "--json",
    ]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const row = clientRows().find((x) => x.name === "First party") as Record<string, unknown>;
    expect(row).toMatchObject({
      first_party: 1,
      consent_mode: "always",
      sign_in_rule: "person_proven_orcid",
      backchannel_logout_uri: "https://app.nemar.org/logout",
      audience: "https://api.nemar.org",
      cap_open_reservations: 4,
      cap_su_per_day: 1000,
    });
    expect(JSON.parse(row.redirect_uris as string)).toEqual([
      "https://app.nemar.org/oauth/callback",
      "https://nemar.org/other",
    ]);
    expect(JSON.parse(row.allowed_scopes as string)).toEqual(["openid", "profile", "compute.read"]);
    expect(JSON.parse(row.introspection_audiences as string)).toEqual([
      "https://rs.example.org",
      "https://rs2.example.org",
    ]);
  });

  test("the registry's refusal is printed as the Worker said it, exits 1, and writes nothing", async () => {
    signIn(OWNER_KEY);
    const refused = await failsBothWays(addArgs(["--redirect-uri", "http://example.org/cb"]));
    expect(refused.plain).toContain("redirect_uris");
    expect(refused.json).toContain("redirect_uris");
    expect(clientRows()).toHaveLength(0);
  });

  test("a missing required flag exits 1 and sends nothing", async () => {
    signIn(OWNER_KEY);
    for (const drop of ["--name", "--scopes", "--grants", "--sign-in-rule", "--audience"]) {
      const args = addArgs();
      const i = args.indexOf(drop);
      args.splice(i, 2);
      const r = await runCli(args);
      expect(r.exitCode, drop).toBe(1);
      expect(r.stderr, drop).toContain(drop);
    }
    const noRedirect = addArgs();
    noRedirect.splice(noRedirect.indexOf("--redirect-uri"), 2);
    const refused = await failsBothWays(noRedirect);
    expect(refused.plain).toMatch(/redirect-uri/);
    expect(refused.json).toMatch(/redirect-uri/);
    expect(requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  test("a word that is not one is refused before anything is sent", async () => {
    signIn(OWNER_KEY);
    const r = await runCli(addArgs(["--consent-mode", "never"]));
    expect(r.exitCode).toBe(1);
    const bad = await runCli(addArgs(["--cap-su-per-day", "-3"]));
    expect(bad.exitCode).toBe(1);
    const alpha = await runCli(addArgs(["--cap-open-reservations", "many"]));
    expect(alpha.exitCode).toBe(1);
    expect(requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });
});

describe("nemar admin oidc clients list and show", () => {
  test("list shows every client, without a secret, and --json is the contract's list", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const b = await addClient(["--name", "Second client"]);
    const text = await runCli(["clients", "list"]);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain(a.client.client_id);
    expect(text.stdout).toContain(b.client.client_id);
    expect(text.stdout).not.toContain(a.client_secret);
    expect(text.stdout).not.toContain(b.client_secret);
    const json = await runCli(["clients", "list", "--json"]);
    const parsed = JSON.parse(json.stdout) as { clients: Array<{ client_id: string }> };
    expect(parsed.clients.map((c) => c.client_id)).toEqual([
      a.client.client_id,
      b.client.client_id,
    ]);
    expect(json.stdout).not.toContain("client_secret");
    expect(json.stdout).not.toContain("secret_hash");
    expect(json.stdout).not.toContain(a.client_secret);
  });

  test("an empty registry says so", async () => {
    signIn(OWNER_KEY);
    const r = await runCli(["clients", "list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no clients/i);
  });

  test("show prints one client in full, with no secret, and an unknown or malformed id exits 1", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli(["clients", "show", a.client.client_id]);
    expect(r.exitCode, r.stderr).toBe(0);
    for (const word of [
      "Example client",
      "https://client.example.org/callback",
      "openid",
      "authorization_code",
      "active_account",
      "https://api.example.org",
    ]) {
      expect(r.stdout).toContain(word);
    }
    expect(r.stdout).not.toContain(a.client_secret);
    expect(r.stdout).not.toContain("secret_hash");
    const json = await runCli(["clients", "show", a.client.client_id, "--json"]);
    expect((JSON.parse(json.stdout) as { client: { client_id: string } }).client.client_id).toBe(
      a.client.client_id,
    );
    const missing = await failsBothWays(["clients", "show", "oc_000000000000000000000000"]);
    expect(missing.plain).toMatch(/no client/i);
    const malformed = await failsBothWays(["clients", "show", "nope"]);
    expect(malformed.plain).toMatch(/not a client id/i);
  });
});

describe("nemar admin oidc clients rotate-secret", () => {
  test("prints the new secret once, keeps the old one for the grace, and show reports the grace", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli(["clients", "rotate-secret", a.client.client_id, "--grace-hours", "2"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const fresh = /(nmo_cs_[A-Za-z0-9_-]{43})\b/.exec(
      r.stdout.replace(a.client.client_id, ""),
    )?.[1];
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(a.client_secret);
    expect(r.stdout).toMatch(/shown (this )?once/i);
    expect(r.stdout).toMatch(/2 hours?/);
    expect(r.stdout).not.toContain(a.client_secret);
    const row = clientRows()[0] as Record<string, unknown>;
    expect(row.previous_secret_hash).not.toBeNull();
    const shown = await runCli(["clients", "show", a.client.client_id]);
    expect(shown.stdout).toMatch(/previous secret/i);
    expect(shown.stdout).not.toContain(fresh as string);
  });

  test("--json prints the contract's rotate answer; --grace-hours 0 leaves no previous secret", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli([
      "clients",
      "rotate-secret",
      a.client.client_id,
      "--grace-hours",
      "0",
      "--json",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as { client_secret: string; grace_hours: number };
    expect(parsed.grace_hours).toBe(0);
    expect(parsed.client_secret).toMatch(/^nmo_cs_[A-Za-z0-9_-]{43}$/);
    expect((clientRows()[0] as Record<string, unknown>).previous_secret_hash).toBeNull();
  });

  test("a grace the Worker refuses, an unknown client and a disabled one exit 1", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    expect(
      (await runCli(["clients", "rotate-secret", a.client.client_id, "--grace-hours", "999"]))
        .exitCode,
    ).toBe(1);
    expect(
      (await runCli(["clients", "rotate-secret", a.client.client_id, "--grace-hours", "x"]))
        .exitCode,
    ).toBe(1);
    expect(
      (await runCli(["clients", "rotate-secret", "oc_000000000000000000000000"])).exitCode,
    ).toBe(1);
    await runCli(["clients", "disable", a.client.client_id, "--yes"]);
    const disabled = await runCli(["clients", "rotate-secret", a.client.client_id]);
    expect(disabled.exitCode).toBe(1);
    expect(disabled.stderr + disabled.stdout).toMatch(/disabled/);
  });
});

describe("nemar admin oidc clients disable", () => {
  test("with --yes it disables, says so, and a second run says it already was", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli(["clients", "disable", a.client.client_id, "--yes"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/disabled/i);
    expect((clientRows()[0] as Record<string, unknown>).status).toBe("disabled");
    const again = await runCli(["clients", "disable", a.client.client_id, "--yes", "--json"]);
    expect(again.exitCode).toBe(0);
    expect((JSON.parse(again.stdout) as { changed: boolean }).changed).toBe(false);
  });

  test("without --yes and with no terminal it asks, cannot, and disables nothing", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    const r = await runCli(["clients", "disable", a.client.client_id]);
    expect(r.exitCode).toBe(1);
    expect((clientRows()[0] as Record<string, unknown>).status).toBe("active");
    expect(requests.filter((q) => q.path.endsWith("/disable"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("nemar admin oidc keys", () => {
  test("list on an empty table says there are no keys; the first rotate makes a current and a next", async () => {
    signIn(OWNER_KEY);
    const empty = await runCli(["keys", "list"]);
    expect(empty.exitCode, empty.stderr).toBe(0);
    expect(empty.stdout).toMatch(/no signing keys/i);
    const first = await runCli(["keys", "rotate"]);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toMatch(/current/);
    expect(first.stdout).toMatch(/next/);
    const list = await runCli(["keys", "list", "--json"]);
    const keys = (JSON.parse(list.stdout) as { keys: Array<{ kid: string; state: string }> }).keys;
    expect(keys.map((k) => k.state).sort()).toEqual(["current", "next"]);
    const text = await runCli(["keys", "list"]);
    for (const k of keys) expect(text.stdout).toContain(k.kid);
  });

  test("a second rotate inside 24 hours is refused with the time, and --force rotates", async () => {
    signIn(OWNER_KEY);
    await runCli(["keys", "rotate"]);
    const early = await failsBothWays(["keys", "rotate"]);
    expect(early.plain).toMatch(/24 hours/);
    expect(early.plain).toMatch(/--force/);
    expect(early.json).toMatch(/24 hours/);
    // A key published seconds ago is not forced without --emergency; age it past the floor.
    db.run(
      "UPDATE oidc_signing_keys SET created_at = datetime('now', '-10 minutes') WHERE state = 'next'",
    );
    const forced = await runCli(["keys", "rotate", "--force", "--json"]);
    expect(forced.exitCode, forced.stderr).toBe(0);
    const parsed = JSON.parse(forced.stdout) as { action: string; keys: unknown[] };
    expect(parsed.action).toBe("rotated");
    expect(parsed.keys).toHaveLength(3);
  });

  test("nothing the command prints holds a private member", async () => {
    signIn(OWNER_KEY);
    const rotated = await runCli(["keys", "rotate", "--json"]);
    const listed = await runCli(["keys", "list", "--json"]);
    const rows = db
      .query<{ private_jwk_encrypted: string }, []>(
        "SELECT private_jwk_encrypted FROM oidc_signing_keys",
      )
      .all();
    for (const out of [rotated.stdout, rotated.stderr, listed.stdout, listed.stderr]) {
      for (const row of rows) expect(out).not.toContain(row.private_jwk_encrypted);
      expect(out).not.toContain('"d"');
      expect(out).not.toContain(OIDC_TEST_SECRET);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("who may run it", () => {
  const COMMANDS: string[][] = [
    ["clients", "list"],
    ["clients", "show", "oc_000000000000000000000000"],
    ["clients", "rotate-secret", "oc_000000000000000000000000"],
    ["clients", "disable", "oc_000000000000000000000000", "--yes"],
    ["keys", "list"],
    ["keys", "rotate"],
    ["end-account", "1", "--reason", "merged", "--yes"],
    ["logout-deliveries"],
    addArgs(),
  ];

  test("not signed in: exit 1, nothing sent", async () => {
    for (const args of COMMANDS) {
      const refused = await failsBothWays(args);
      expect(refused.plain).toContain("Not authenticated");
      expect(refused.json).toContain("Not authenticated");
    }
    expect(requests).toHaveLength(0);
  });

  test("an administrator who is not the owner and a member: exit 1, the owner role named", async () => {
    for (const key of [ADMIN_KEY, MEMBER_KEY]) {
      signIn(key);
      for (const args of COMMANDS) {
        const refused = await failsBothWays(args);
        expect(refused.plain).toMatch(/owner/i);
        expect(refused.json).toMatch(/owner/i);
      }
    }
    expect(clientRows()).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
  });

  test("a Worker with the provider off answers 404, and the command says why instead of calling it a bug", async () => {
    signIn(OWNER_KEY);
    extraEnv = { OIDC_SECRET: undefined };
    for (const args of [["keys", "list"], ["clients", "list"], addArgs()]) {
      const refused = await failsBothWays(args);
      expect(refused.plain).toMatch(/OIDC_SECRET/);
      expect(refused.json).toMatch(/OIDC_SECRET/);
      // Not the "this backend does not support this command yet" of a server that predates it.
      expect(refused.plain).toMatch(/provider is off/);
    }
    expect(clientRows()).toHaveLength(0);
  });

  test("the command says unset or malformed, a fixed word, and never echoes the value", async () => {
    signIn(OWNER_KEY);
    const bad = "rig-oidc-secret-0123456789abcdef0123456789abcdef";
    for (const [secret, word] of [
      [undefined, "unset"],
      ["", "unset"],
      [bad, "malformed"],
      [`NMSSO-${"0".repeat(64)}`, "malformed"],
    ] as const) {
      extraEnv = { OIDC_SECRET: secret };
      for (const args of [
        ["keys", "list"],
        ["clients", "list"],
      ]) {
        const refused = await failsBothWays(args);
        for (const out of [refused.plain, refused.json]) {
          expect(out).toContain(
            word === "unset" ? "is unset" : `not in the ${OIDC_SECRET_PREFIX} form`,
          );
          expect(out).not.toContain(word === "unset" ? "not in the" : "is unset");
          if (secret) expect(out).not.toContain(secret);
        }
      }
    }
    // A Worker that predates the word still gets the general explanation.
    extraEnv = { OIDC_SECRET: undefined };
  });
});

describe("help", () => {
  test("every command has an Exit codes block, shown with --help-all", async () => {
    for (const path of [
      ["admin", "oidc", "clients", "add"],
      ["admin", "oidc", "clients", "list"],
      ["admin", "oidc", "clients", "show"],
      ["admin", "oidc", "clients", "rotate-secret"],
      ["admin", "oidc", "clients", "disable"],
      ["admin", "oidc", "keys", "list"],
      ["admin", "oidc", "keys", "rotate"],
      ["admin", "oidc", "end-account"],
      ["admin", "oidc", "logout-deliveries"],
    ]) {
      const out = await help([...path, "--help-all"]);
      expect(out, path.join(" ")).toContain("Exit codes:");
      expect(out).toContain("--json");
    }
  });

  test("the group lists its subgroups, and admin lists the group", async () => {
    const group = await help(["admin", "oidc", "--help"]);
    expect(group).toContain("clients");
    expect(group).toContain("keys");
    const admin = await help(["admin", "--help-all"]);
    expect(admin).toContain("oidc");
  });
});

// ---------------------------------------------------------------------------------------------
// Phase #2019: revocation cascades and back-channel logout
// ---------------------------------------------------------------------------------------------

/**
 * What an account holds at a client, written straight into the tables: this suite is about what the
 * COMMAND prints and asks of the Worker, and the flow that makes these rows is proven through the real
 * routes in `backend/test/oidc-cascade.test.ts`. The columns are the ones migrations 0122 and 0123 name.
 */
function giveHoldings(clientId: string, userId: number): void {
  const client = db
    .query<{ id: number }, [string]>("SELECT id FROM oidc_clients WHERE client_id = ?")
    .get(clientId);
  if (!client) throw new Error("no such client");
  db.run(
    "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, '[\"openid\"]', 'user')",
    [userId, client.id],
  );
  const grant = db
    .query<{ id: number }, [number]>("SELECT id FROM oidc_grants WHERE user_id = ?")
    .get(userId);
  db.run(
    `INSERT INTO oidc_codes (code_hash, client_id, user_id, grant_id, redirect_uri, scopes, code_challenge,
       auth_time, expires_at) VALUES (?, ?, ?, ?, 'https://client.example.org/callback', '["openid"]', ?,
       datetime('now'), datetime('now', '+60 seconds'))`,
    [
      "c".repeat(64),
      client.id,
      userId,
      grant?.id as number,
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    ],
  );
  for (const [i, kind] of (["access", "refresh"] as const).entries()) {
    db.run(
      `INSERT INTO oidc_tokens (token_hash, kind, client_id, user_id, grant_id, code_id, family_id, audience,
         scopes, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, 1, ?, 'https://api.example.org',
         '["openid"]', datetime('now', '+10 minutes'),
         CASE WHEN ? = 'refresh' THEN datetime('now', '+90 days') END)`,
      [String(i).repeat(64), kind, client.id, userId, grant?.id as number, "f".repeat(32), kind],
    );
  }
}

const memberId = () =>
  (
    db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'oidcmember'").get() as {
      id: number;
    }
  ).id;

describe("nemar admin oidc end-account", () => {
  test("with --yes it ends the account's grants, counts what it did, and a second run finds nothing", async () => {
    signIn(OWNER_KEY);
    const a = await addClient(["--logout-uri", "https://partner.example.org/logout"]);
    giveHoldings(a.client.client_id, memberId());

    const r = await runCli(["end-account", String(memberId()), "--reason", "merged", "--yes"]);

    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "Tokens revoked 2, grants ended 1, unused codes deleted 1, logouts queued 1.",
    );
    expect(
      db.query("SELECT COUNT(*) AS n FROM oidc_grants WHERE revoked_at IS NULL").get(),
    ).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM oidc_logout_deliveries").get()).toEqual({ n: 1 });
    const again = await runCli([
      "end-account",
      String(memberId()),
      "--reason",
      "merged",
      "--yes",
      "--json",
    ]);
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({
      reason: "account_merged",
      tokens_ended: 0,
      grants_ended: 0,
      codes_deleted: 0,
      logouts_queued: 0,
    });
  });

  test("--reason revoked is the other word, and --json writes only the answer to standard output", async () => {
    signIn(OWNER_KEY);
    const r = await runCli([
      "end-account",
      String(memberId()),
      "--reason",
      "revoked",
      "--yes",
      "--json",
    ]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ user_id: memberId(), reason: "account_revoked" });
    expect(r.stderr).toBe("");
  });

  test("without --yes and with no terminal it asks, cannot, and ends nothing", async () => {
    signIn(OWNER_KEY);
    const a = await addClient();
    giveHoldings(a.client.client_id, memberId());
    const r = await runCli(["end-account", String(memberId()), "--reason", "merged"]);
    expect(r.exitCode).toBe(1);
    expect(
      db.query("SELECT COUNT(*) AS n FROM oidc_grants WHERE revoked_at IS NULL").get(),
    ).toEqual({ n: 1 });
    expect(requests.filter((q) => q.path.includes("/accounts/"))).toHaveLength(0);
  });

  test("the question is true of every kind of client, and the help says what to pair the command with", async () => {
    const question = endAccountQuestion(7);
    // A first-party client skips the consent screen, so only a third-party client "asks again".
    expect(question).toContain("a third-party client asks the person for consent again");
    expect(question).toContain("(a first-party client does not ask)");
    expect(question).not.toMatch(/the person is asked again/);
    expect(question).toContain("account 7");
    // The help is read as a person reads it: whitespace and line breaks are one space.
    const out = (await help(["admin", "oidc", "end-account", "--help-all"])).replace(/\s+/g, " ");
    expect(out).toMatch(/a first-party client does not ask/);
    expect(out).toMatch(/does not stop the account signing in again/);
    expect(out).not.toMatch(/asks the person again\)/);
    // A merge loser is ended with this command and then revoked or deleted, in that order and for that
    // reason; a change of its kind is NOT a way to cut it off (it ends the person_proven_orcid grants only).
    expect(out).toContain("run this command and then revoke or delete that account");
    expect(out).toContain(
      "revoking and deleting end every grant the account holds and leave it unable to sign in",
    );
    expect(out).toContain(
      "running this command first is what makes the revoked tokens and the queued logouts record the merge",
    );
    expect(out).toContain("Changing the account's kind away from person is no substitute");
    expect(out).toContain(
      "it ends only the grants of the clients that sign people in by person_proven_orcid",
    );
    expect(out).toContain("a non-person account still meets the active_account rule");
    expect(out).not.toMatch(/changing its kind away from person/);
    expect(out).not.toMatch(/those paths end the grants themselves/);
  });

  test("a bad id, a missing reason, an unknown reason and an unknown account exit 1", async () => {
    signIn(OWNER_KEY);
    for (const args of [
      ["end-account", "abc", "--reason", "merged", "--yes"],
      ["end-account", "0", "--reason", "merged", "--yes"],
      ["end-account", "1", "--yes"],
      ["end-account", "1", "--reason", "account_merged", "--yes"],
    ]) {
      const refused = await failsBothWays(args);
      expect(refused.plain.length, args.join(" ")).toBeGreaterThan(0);
    }
    const missing = await failsBothWays(["end-account", "987654", "--reason", "merged", "--yes"]);
    expect(missing.plain).toMatch(/no account/i);
    expect(requests.filter((q) => q.path.includes("/accounts/987654"))).toHaveLength(2);
    expect(requests.filter((q) => /\/accounts\/(abc|0|1)\//.test(q.path))).toHaveLength(0);
  });
});

describe("nemar admin oidc logout-deliveries", () => {
  function put(status: "pending" | "sent" | "failed", n = 1): void {
    const client = db.query<{ id: number }, []>("SELECT id FROM oidc_clients LIMIT 1").get();
    for (let i = 0; i < n; i++) {
      db.run(
        `INSERT INTO oidc_logout_deliveries (client_id, sub, reason, status, attempts, next_attempt_at, sent_at,
           last_status, last_error_class)
         VALUES (?, ?, 'account_revoked', ?, 1, ${status === "pending" ? "datetime('now', '+1 hour')" : "NULL"},
           ${status === "sent" ? "datetime('now')" : "NULL"}, ?, ?)`,
        [
          client?.id as number,
          `nmu_${"a".repeat(32)}`,
          status,
          status === "pending" ? 503 : status === "failed" ? 400 : 200,
          status === "pending" ? "http_5xx" : status === "failed" ? "http_4xx" : null,
        ],
      );
    }
  }

  test("prints the counts of every status and a table, and --status narrows only the table", async () => {
    signIn(OWNER_KEY);
    await addClient();
    put("sent", 2);
    put("failed");
    put("pending");

    const all = await runCli(["logout-deliveries"]);
    expect(all.exitCode, all.stderr).toBe(0);
    expect(all.stdout).toContain("All deliveries: pending 1, sent 2, failed 1, fenced 0.");
    expect(all.stdout).toMatch(/http_4xx/);
    expect(all.stdout).toMatch(/http_5xx/);

    const failed = await runCli(["logout-deliveries", "--status", "failed"]);
    expect(failed.stdout).toContain("All deliveries: pending 1, sent 2, failed 1, fenced 0.");
    expect(failed.stdout).toMatch(/http_4xx/);
    expect(failed.stdout).not.toMatch(/http_5xx/);
  });

  test("--json is the answer and nothing else, and an empty list is not a failure", async () => {
    signIn(OWNER_KEY);
    const empty = await runCli(["logout-deliveries", "--json"]);
    expect(empty.exitCode, empty.stderr).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({
      deliveries: [],
      counts: { pending: 0, sent: 0, failed: 0, fenced: 0 },
    });
    const text = await runCli(["logout-deliveries"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toMatch(/no deliveries/i);
  });

  test("the help says which answers are final and which are retried, as the sender does", async () => {
    // The facts are pinned in `backend/test/oidc-logout-sender.test.ts` ("which answers are retried...").
    const out = (await help(["admin", "oidc", "logout-deliveries", "--help-all"])).replace(
      /\s+/g,
      " ",
    );
    expect(out).toContain(
      "failed not to be tried again: the client answered with a redirect, a 4xx other than 408 and 429, or any answer that is not a 200, a 204, a 408, a 429 or a 5xx",
    );
    expect(out).toContain(
      "or all 6 attempts were used on answers that are retried (a 5xx, a 408, a 429, no answer in time, a connection that failed, a token NEMAR could not sign)",
    );
    expect(out).toContain(
      "or it was never sent because its client was disabled or its address is no longer one NEMAR sends to",
    );
    // The line it replaces called every 4xx final and left out what is retried.
    expect(out).not.toContain("the client refused it (a 4xx, a redirect, any other answer)");
  });

  test("--limit bounds the list; a limit the server refuses and an unknown status exit 1", async () => {
    signIn(OWNER_KEY);
    await addClient();
    put("sent", 3);
    const one = await runCli(["logout-deliveries", "--limit", "1", "--json"]);
    expect((JSON.parse(one.stdout) as { deliveries: unknown[] }).deliveries).toHaveLength(1);
    await failsBothWays(["logout-deliveries", "--limit", "501"]);
    await failsBothWays(["logout-deliveries", "--status", "queued"]);
  });
});

describe("nemar admin oidc clients disable, and what the client holds", () => {
  test("says how many tokens, grants and codes went, and that no logout was sent", async () => {
    signIn(OWNER_KEY);
    const a = await addClient(["--logout-uri", "https://partner.example.org/logout"]);
    giveHoldings(a.client.client_id, memberId());

    const r = await runCli(["clients", "disable", a.client.client_id, "--yes"]);

    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      "Revoked 2 tokens, 1 grant and deleted 1 unused code. No logout was sent.",
    );
    expect(
      db.query("SELECT COUNT(*) AS n FROM oidc_tokens WHERE revoked_at IS NULL").get(),
    ).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM oidc_logout_deliveries").get()).toEqual({ n: 0 });
    const again = await runCli(["clients", "disable", a.client.client_id, "--yes"]);
    expect(again.stdout).toContain("already disabled");
    expect(again.stdout).toContain("Revoked 0 tokens, 0 grants and deleted 0 unused codes.");
  });
});

// ---------------------------------------------------------------------------------------------
// Round-1 additions (review of phase #2016)
// ---------------------------------------------------------------------------------------------

const ageNext = (minutes: number) =>
  db.run(
    `UPDATE oidc_signing_keys SET created_at = datetime('now', '-${minutes} minutes') WHERE state = 'next'`,
  );

describe("nemar admin oidc keys rotate --force", () => {
  test("is refused while the next key is under 6 minutes old, and says what --emergency means", async () => {
    signIn(OWNER_KEY);
    await runCli(["keys", "rotate"]);
    const before = JSON.stringify(
      db.query("SELECT kid, state FROM oidc_signing_keys ORDER BY kid").all(),
    );
    const refused = await failsBothWays(["keys", "rotate", "--force"]);
    expect(refused.plain).toMatch(/6 minutes/);
    expect(refused.plain).toMatch(/emergency/i);
    expect(refused.plain).toMatch(/--force --emergency/);
    // --yes answers a question; it is not the emergency, and the hint does not suggest it.
    expect(refused.plain).not.toMatch(/--yes/);
    expect(
      JSON.stringify(db.query("SELECT kid, state FROM oidc_signing_keys ORDER BY kid").all()),
    ).toBe(before);
  });

  test("--force --emergency overrides the floor, and rotates a key published seconds ago", async () => {
    signIn(OWNER_KEY);
    await runCli(["keys", "rotate"]);
    const r = await runCli(["keys", "rotate", "--force", "--emergency", "--json"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { action: string }).action).toBe("rotated");
    const audit = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'oidc.keys.rotate' ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(JSON.parse(audit?.details as string)).toMatchObject({ forced: true, emergency: true });
  });

  test("--emergency without --force changes nothing about the 24-hour rule", async () => {
    signIn(OWNER_KEY);
    await runCli(["keys", "rotate"]);
    const early = await failsBothWays(["keys", "rotate", "--emergency"]);
    expect(early.plain).toMatch(/24 hours/);
  });

  test("--yes is not an emergency: a script that always passes it is refused like anyone", async () => {
    signIn(OWNER_KEY);
    await runCli(["keys", "rotate"]);
    // `keys rotate` asks nothing, so it has no --yes to give; the option is not there to misuse.
    const r = await runCli(["keys", "rotate", "--force", "--yes"]);
    expect(r.exitCode).toBe(1);
    expect(
      JSON.stringify(db.query("SELECT state FROM oidc_signing_keys ORDER BY kid").all()),
    ).not.toContain("retired");
    expect(db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 2 });
  });

  test("a rotation under another OIDC_SECRET says which secret was wrong and changes nothing", async () => {
    signIn(OWNER_KEY);
    await runCli(["keys", "rotate"]);
    ageNext(25 * 60);
    extraEnv = { OIDC_SECRET: fakeOidcSecret("another-oidc-secret") };
    const refused = await failsBothWays(["keys", "rotate"]);
    expect(refused.plain).toMatch(/different OIDC_SECRET/);
    expect(refused.json).toMatch(/different OIDC_SECRET/);
    extraEnv = {};
    expect(db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 2 });
  });
});

describe("nemar admin oidc keys revoke", () => {
  /** Two rotations in, the first key is retired. Returns its id and the other states' ids. */
  async function retiredKid(): Promise<string> {
    signIn(OWNER_KEY);
    await runCli(["keys", "rotate"]);
    const first = (
      db.query("SELECT kid FROM oidc_signing_keys WHERE state = 'current'").get() as { kid: string }
    ).kid;
    await runCli(["keys", "rotate", "--force", "--emergency"]);
    return first;
  }
  const stateOf = (kid: string) =>
    (db.query("SELECT state FROM oidc_signing_keys WHERE kid = ?").get(kid) as { state: string })
      .state;

  test("revokes a retired key with --yes, and a second run says it already was", async () => {
    const kid = await retiredKid();
    const r = await runCli(["keys", "revoke", kid, "--yes"]);
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/revoked/i);
    expect(stateOf(kid)).toBe("revoked");
    const again = await runCli(["keys", "revoke", kid, "--yes", "--json"]);
    expect(again.exitCode).toBe(0);
    const parsed = JSON.parse(again.stdout) as { changed: boolean; key: { state: string } };
    expect(parsed.changed).toBe(false);
    expect(parsed.key.state).toBe("revoked");
  });

  test("keys list then shows the key as revoked, with when", async () => {
    const kid = await retiredKid();
    await runCli(["keys", "revoke", kid, "--yes"]);
    const list = await runCli(["keys", "list"]);
    const line = list.stdout.split("\n").find((l) => l.includes(kid)) ?? "";
    expect(line).toMatch(/revoked/);
    // The REVOKED column carries a time; the same line has its created, promoted and retired times too.
    expect(line.match(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/g)?.length).toBe(4);
    expect(list.stdout).toMatch(/REVOKED/);
  });

  test("without --yes and with no terminal it asks, cannot, and revokes nothing", async () => {
    const kid = await retiredKid();
    const refused = await failsBothWays(["keys", "revoke", kid]);
    expect(refused.plain).toMatch(/--yes/);
    expect(stateOf(kid)).toBe("retired");
  });

  test("the current key, the next key, an unknown key and a malformed id are refused, with the reason", async () => {
    await retiredKid();
    for (const state of ["current", "next"]) {
      const kid = (
        db.query("SELECT kid FROM oidc_signing_keys WHERE state = ?").get(state) as { kid: string }
      ).kid;
      const refused = await failsBothWays(["keys", "revoke", kid, "--yes"]);
      expect(refused.plain).toMatch(/rotate/i);
      expect(stateOf(kid)).toBe(state);
    }
    const missing = await failsBothWays(["keys", "revoke", "00000000000000ff", "--yes"]);
    expect(missing.plain).toMatch(/no signing key/i);
    const malformed = await failsBothWays(["keys", "revoke", "nope", "--yes"]);
    expect(malformed.plain).toMatch(/not a key id/i);
  });

  test("it is for the owner, and for a signed-in one", async () => {
    const refused = await failsBothWays(["keys", "revoke", "0123456789abcdef", "--yes"]);
    expect(refused.plain).toContain("Not authenticated");
    signIn(ADMIN_KEY);
    const admin = await failsBothWays(["keys", "revoke", "0123456789abcdef", "--yes"]);
    expect(admin.plain).toMatch(/owner/i);
  });
});

describe("a network failure on a write says to look before trying again", () => {
  test("clients add suggests clients list, because the request may have been registered", async () => {
    signIn(OWNER_KEY);
    const dead = { TEST_API_URL: "http://127.0.0.1:1" };
    const typed = await runCli(addArgs(), dead);
    expect(typed.exitCode).toBe(1);
    const text = typed.stdout + typed.stderr;
    expect(text).toMatch(/clients list/);
    expect(text).toMatch(/secret/i);
    const asJson = await runCli([...addArgs(), "--json"], dead);
    expect(asJson.exitCode).toBe(1);
    expect(asJson.stdout).toBe("");
    expect(asJson.stderr).toMatch(/clients list/);
  });

  test("rotate-secret and keys rotate say the same", async () => {
    signIn(OWNER_KEY);
    const dead = { TEST_API_URL: "http://127.0.0.1:1" };
    const rotate = await runCli(["clients", "rotate-secret", "oc_000000000000000000000000"], dead);
    expect(rotate.stdout + rotate.stderr).toMatch(/clients show/);
    const keys = await runCli(["keys", "rotate"], dead);
    expect(keys.stdout + keys.stderr).toMatch(/keys list/);
  });
});

describe("help says what the constants say", () => {
  test("clients add: the catalogue, the grants, the redirect limit, and what third-party means", async () => {
    const out = await help(["admin", "oidc", "clients", "add", "--help-all"]);
    for (const scope of OIDC_SCOPE_NAMES) expect(out).toContain(scope);
    for (const grant of OIDC_GRANTS) expect(out).toContain(grant);
    expect(out).toContain(`one to ${OIDC_MAX_REDIRECT_URIS}`);
    // A third-party client never skips consent and follows its mode; it does not "always" show it.
    expect(out).toMatch(/never skips/);
    expect(out).not.toMatch(/always shows/i);
    expect(out).toMatch(/offline_access/);
  });

  test("rotate-secret: the grace default and its maximum", async () => {
    const out = await help(["admin", "oidc", "clients", "rotate-secret", "--help-all"]);
    expect(out).toContain(`default ${OIDC_SECRET_GRACE_HOURS_DEFAULT}`);
    expect(out).toContain(`at most ${OIDC_SECRET_GRACE_HOURS_MAX}`);
  });

  test("keys rotate: the 24-hour rule, the retired window, the force floor and what forcing risks", async () => {
    const out = await help(["admin", "oidc", "keys", "rotate", "--help-all"]);
    expect(out).toContain(`${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours old`);
    expect(out).toContain(`${OIDC_RETIRED_KEY_PUBLISH_DAYS} days`);
    expect(out).toContain(`${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes`);
    expect(out).toMatch(/fail verification/);
    expect(out).toContain(`${OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS / 60} minutes`);
    expect(out).toMatch(/--emergency/);
    expect(out).not.toMatch(/--yes/);
    expect(out).toMatch(/OIDC_SECRET/);
    expect(out).toContain(OIDC_SECRET_PREFIX);
    expect(out).toContain("openssl rand -hex 32");
    expect(out).toMatch(/"unset" or "malformed"/);
  });

  test("keys revoke: what it does and does not do", async () => {
    const out = await help(["admin", "oidc", "keys", "revoke", "--help-all"]);
    expect(out).toContain("Exit codes:");
    expect(out).toMatch(/retired/);
    expect(out).toMatch(/rotate first/i);
    expect(out).toContain(`${OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS / 60} minutes`);
  });
});
