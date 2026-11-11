/**
 * The conformance run against the DEPLOYED development system (epic #2014 phase #2020, slice S7): what
 * can be checked without running the suite or touching that system.
 *
 * CI TIER: unit-pure. It holds none of the markers that route a file to the integration tier. It spawns
 * two small scripts as child processes (neither touches the network) and reads the workflow from disk.
 *
 * Held:
 *  - the target is checked, not trusted: only the development system's own two hosts are accepted, and a
 *    production address, a trailing slash, another host or a malformed client id is refused with nothing
 *    written;
 *  - the dev plan configuration points the suite at the real page's host, uses one client for the three
 *    the suite reads, holds a plainly fake secret, and scripts no sign-in;
 *  - the module selection is the 35 modules of the plan minus the one that signs in, and every module the
 *    expected-failures files name is in the list (a typo in a selection is silent in the suite);
 *  - the suite-results check passes only a stop that was exactly invalid_request to a request with no
 *    code_challenge, and fails on any other code, on a challenge, on an unreadable request, on a log it
 *    cannot parse and on too few stops; it reads zips and loose logs, and its entry point exits as the
 *    workflow needs;
 *  - the workflow takes the four inputs, skips the rig steps for dev, passes inputs only through the
 *    environment, runs the new check after the plans and before the upload, and uses no secret.
 *
 * Nothing here replaces NEMAR logic.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  DEV_AUTHORIZATION_BASE,
  DEV_ISSUER,
  resolveDevTarget,
} from "../scripts/oidc-conformance/dev-target";
import {
  BASIC_PLAN_MODULES,
  BASIC_PLAN_NAME,
  DEV_BASIC_PLAN_MODULES,
  DUMMY_CLIENT_SECRET,
  SIGN_IN_MODULE,
  buildDevBasicPlanConfig,
  devBasicPlanArgument,
} from "../scripts/oidc-conformance/plan-config";
import { type ModuleLog, checkSuiteResults } from "../scripts/oidc-conformance/suite-authz";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const scratch: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "nemar-conf-dev-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const CLIENT_ID = "oc_0123456789abcdef01234567";
const GOOD = { issuer: DEV_ISSUER, authorizationBase: DEV_AUTHORIZATION_BASE, clientId: CLIENT_ID };

describe("the target is checked, not trusted", () => {
  test("accepts exactly the development system's two hosts and a client id", () => {
    expect(resolveDevTarget(GOOD)).toEqual(GOOD);
    expect(DEV_ISSUER).toBe("https://api-test.nemar.org");
    expect(DEV_AUTHORIZATION_BASE).toBe("https://test.nemar.org");
  });

  test("refuses production, another host, a trailing slash and plain http", () => {
    for (const issuer of [
      "https://api.nemar.org",
      "https://api-test.nemar.org/",
      "http://api-test.nemar.org",
      "https://api-test.nemar.org.evil.example",
      "https://example.org",
      "",
    ]) {
      expect(() => resolveDevTarget({ ...GOOD, issuer }), issuer).toThrow(/issuer must be exactly/);
    }
    for (const authorizationBase of [
      "https://app.nemar.org",
      "https://nemar.org",
      "https://test.nemar.org/",
      "http://test.nemar.org",
      "",
    ]) {
      expect(() => resolveDevTarget({ ...GOOD, authorizationBase }), authorizationBase).toThrow(
        /authorization base must be exactly/,
      );
    }
  });

  test("refuses a client id that is not a NEMAR client id", () => {
    for (const clientId of [
      "",
      "oc_short",
      "client-one",
      "oc_0123456789ABCDEF01234567",
      "nmo_cs_x",
    ]) {
      expect(() => resolveDevTarget({ ...GOOD, clientId }), clientId).toThrow(/client id/);
    }
  });
});

describe("the dev plan configuration", () => {
  const addr = { issuer: DEV_ISSUER, authorizationBase: DEV_AUTHORIZATION_BASE, alias: "nemar" };
  const config = buildDevBasicPlanConfig(addr, CLIENT_ID) as {
    server: { discoveryUrl: string };
    client: { client_id: string; client_secret: string };
    client2: unknown;
    client_secret_post: unknown;
    browser: Array<{ match: string; tasks: Array<{ task: string }> }>;
    override: Record<
      string,
      { browser: Array<{ match: string; tasks: Array<{ match: string }> }> }
    >;
  };

  test("discovery is the development API's, the page is the website's", () => {
    expect(config.server.discoveryUrl).toBe(
      "https://api-test.nemar.org/.well-known/openid-configuration",
    );
    expect(config.browser[0]?.match).toBe("https://test.nemar.org/oauth/authorize*");
    for (const block of Object.values(config.override)) {
      expect(block.browser[0]?.match).toBe("https://test.nemar.org/oauth/authorize*");
      expect(block.browser[0]?.tasks[0]?.match).toBe("https://test.nemar.org/oauth/authorize*");
    }
  });

  test("one client stands for the three the suite reads, with a plainly fake secret", () => {
    expect(config.client).toEqual({ client_id: CLIENT_ID, client_secret: DUMMY_CLIENT_SECRET });
    expect(config.client2).toEqual(config.client);
    expect(config.client_secret_post).toEqual(config.client);
    expect(DUMMY_CLIENT_SECRET).toMatch(/^not-a-real-secret/);
    // It resembles no NEMAR token, no key and no scanner-friendly prefix.
    expect(DUMMY_CLIENT_SECRET).not.toMatch(/nm[a-z]{1,3}_|nmsso|sk-|ghp_|AKIA/);
  });

  test("scripts no sign-in: the browser block is the completion check alone", () => {
    expect(config.browser[0]?.tasks.map((t) => t.task)).toEqual(["Verify Complete"]);
    expect(JSON.stringify(config)).not.toMatch(/nemar\.test|signin|Login|Consent/);
    expect(Object.keys(config.override).sort()).toEqual([
      "oidcc-ensure-registered-redirect-uri",
      "oidcc-ensure-request-object-with-redirect-uri",
    ]);
  });
});

describe("the module selection", () => {
  test("is the plan's 35 modules, once each", () => {
    expect(BASIC_PLAN_MODULES).toHaveLength(35);
    expect(new Set(BASIC_PLAN_MODULES).size).toBe(35);
  });

  test("a dev run drops only the module that signs in", () => {
    expect(DEV_BASIC_PLAN_MODULES).toHaveLength(34);
    expect(DEV_BASIC_PLAN_MODULES).not.toContain(SIGN_IN_MODULE);
    expect(SIGN_IN_MODULE).toBe("oidcc-ensure-request-with-valid-pkce-succeeds");
    expect(BASIC_PLAN_MODULES.filter((m) => !DEV_BASIC_PLAN_MODULES.includes(m))).toEqual([
      SIGN_IN_MODULE,
    ]);
  });

  test("the command-line argument is the plan, its variants, a colon and the modules", () => {
    const arg = devBasicPlanArgument();
    expect(arg.startsWith(`${BASIC_PLAN_NAME}:`)).toBe(true);
    expect(arg.slice(BASIC_PLAN_NAME.length + 1).split(",")).toEqual([...DEV_BASIC_PLAN_MODULES]);
    // The suite's grammar: a module name is letters, digits, hyphens and underscores.
    for (const name of DEV_BASIC_PLAN_MODULES) expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(arg).not.toMatch(/\s/);
  });

  test("every module the expected files name is in the list (a typo is silent in the suite)", () => {
    const names = (file: string) =>
      (JSON.parse(read(`scripts/oidc-conformance/${file}`)) as Array<{ "test-name": string }>).map(
        (e) => e["test-name"],
      );
    for (const name of [...names("expected-failures.json"), ...names("expected-skips.json")]) {
      expect(BASIC_PLAN_MODULES as readonly string[]).toContain(name);
    }
  });

  test("the plan name is the one the rig run uses", () => {
    expect(read(".github/workflows/oidc-conformance.yml")).toContain(BASIC_PLAN_NAME);
  });
});

describe("dev-config.ts", () => {
  const script = join(ROOT, "scripts", "oidc-conformance", "dev-config.ts");
  const run = (env: Record<string, string | undefined>) =>
    spawnSync("bun", [script], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        ...env,
      } as Record<string, string>,
    });

  test("writes the two plan files and the plan argument, and prints no client id or secret", () => {
    const out = join(tmp(), "out");
    const result = run({
      RIG_OUT_DIR: out,
      DEV_ISSUER: DEV_ISSUER,
      DEV_AUTHORIZATION_BASE: DEV_AUTHORIZATION_BASE,
      DEV_CLIENT_ID: CLIENT_ID,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).not.toContain(CLIENT_ID);
    expect(result.stdout).not.toContain(DUMMY_CLIENT_SECRET);
    const basic = JSON.parse(readFileSync(join(out, "basic-plan.json"), "utf8"));
    expect(basic.client.client_id).toBe(CLIENT_ID);
    const config = JSON.parse(readFileSync(join(out, "config-plan.json"), "utf8"));
    expect(config.server.discoveryUrl).toBe(
      "https://api-test.nemar.org/.well-known/openid-configuration",
    );
    expect(Object.keys(config)).not.toContain("client");
    expect(readFileSync(join(out, "basic-plan-arg.txt"), "utf8")).toBe(devBasicPlanArgument());
  });

  test("refuses production, writes nothing and says why", () => {
    const out = join(tmp(), "out");
    const result = run({
      RIG_OUT_DIR: out,
      DEV_ISSUER: "https://api.nemar.org",
      DEV_AUTHORIZATION_BASE: DEV_AUTHORIZATION_BASE,
      DEV_CLIENT_ID: CLIENT_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::the issuer must be exactly");
    expect(existsSync(out)).toBe(false);
  });

  test("refuses a missing client id, and a missing output directory", () => {
    const out = join(tmp(), "out");
    const base = { DEV_ISSUER, DEV_AUTHORIZATION_BASE };
    expect(run({ ...base, RIG_OUT_DIR: out }).status).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(run({ ...base, DEV_CLIENT_ID: CLIENT_ID }).status).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The suite-results check
// ---------------------------------------------------------------------------------------------

/** A module log that stopped at the authorization endpoint with `error`, to a request with `params`. */
function stop(
  name: string,
  error: unknown,
  params: Record<string, string> | null = { client_id: "c", response_type: "code" },
  condition = "CheckIfAuthorizationEndpointError",
): ModuleLog {
  const field = condition === "CheckIfAuthorizationEndpointError" ? "error" : "actual";
  return {
    testInfo: { testName: name },
    results: [
      { src: "CreateRedirectUri", result: "SUCCESS" },
      ...(params === null
        ? []
        : [
            {
              src: "BuildPlainRedirectToAuthorizationEndpoint",
              result: "SUCCESS",
              auth_request: params,
            },
          ]),
      { src: condition, result: "FAILURE", [field]: error },
    ],
  };
}

describe("the suite-results check", () => {
  test("passes a stop that was exactly invalid_request to a request with no challenge", () => {
    expect(checkSuiteResults([stop("oidcc-server", "invalid_request")])).toEqual({
      checked: 1,
      byError: { invalid_request: 1 },
      violations: [],
    });
  });

  test("reads the user-interface condition's error from `actual`", () => {
    const log = stop(
      "oidcc-prompt-none-not-logged-in",
      "invalid_request",
      undefined,
      "CheckErrorFromAuthorizationEndpointIsOneThatRequiredAUserInterface",
    );
    expect(checkSuiteResults([log]).violations).toEqual([]);
    const wrong = stop(
      "m",
      "login_required",
      undefined,
      "CheckErrorFromAuthorizationEndpointIsOneThatRequiredAUserInterface",
    );
    expect(checkSuiteResults([wrong]).violations).toHaveLength(1);
  });

  test("fails any other error code, naming the module and the code", () => {
    for (const error of ["invalid_scope", "access_denied", "server_error", "login_required"]) {
      expect(checkSuiteResults([stop("oidcc-x", error)]).violations).toEqual([
        `oidcc-x: the authorization endpoint answered ${error}, which is not the PKCE deviation`,
      ]);
    }
  });

  test("fails an invalid_request that came to a request with a code_challenge", () => {
    const log = stop("oidcc-y", "invalid_request", { client_id: "c", code_challenge: "x" });
    expect(checkSuiteResults([log]).violations).toEqual([
      "oidcc-y: invalid_request answered a request that carried a code_challenge, so it is not the PKCE deviation",
    ]);
  });

  test("fails a stop whose request cannot be read", () => {
    expect(checkSuiteResults([stop("oidcc-z", "invalid_request", null)]).violations).toEqual([
      "oidcc-z: the request the suite sent cannot be read, so whether it carried a code_challenge is unknown",
    ]);
  });

  test("takes the request from the entry nearest before the stop", () => {
    const log: ModuleLog = {
      testInfo: { testName: "oidcc-two" },
      results: [
        { src: "A", result: "SUCCESS", auth_request: { code_challenge: "first" } },
        { src: "B", result: "SUCCESS", auth_request: { client_id: "second" } },
        { src: "CheckIfAuthorizationEndpointError", result: "FAILURE", error: "invalid_request" },
      ],
    };
    expect(checkSuiteResults([log]).violations).toEqual([]);
  });

  test("a malformed error value is a violation, not skipped", () => {
    for (const error of ["", "Invalid Request", undefined, 7, "a-b"]) {
      expect(checkSuiteResults([stop("oidcc-m", error)]).byError).toEqual({ malformed_error: 1 });
    }
  });

  test("ignores a passing condition and a failure of another condition", () => {
    const log: ModuleLog = {
      testInfo: { testName: "oidcc-ok" },
      results: [
        { src: "CheckIfAuthorizationEndpointError", result: "SUCCESS" },
        { src: "SomethingElse", result: "FAILURE", error: "invalid_scope" },
      ],
    };
    expect(checkSuiteResults([log], 0)).toEqual({ checked: 0, byError: {}, violations: [] });
  });

  test("fails when it found too little to check", () => {
    expect(checkSuiteResults([], 1).violations).toEqual([
      "0 modules stopped at the authorization endpoint, fewer than the 1 a run has, so there is too little to check",
    ]);
    expect(checkSuiteResults([stop("a", "invalid_request")], 2).violations).toHaveLength(1);
    expect(checkSuiteResults([stop("a", "invalid_request")], 1).violations).toEqual([]);
  });
});

/** A store-only zip holding the given files, built by hand so the test needs no `zip` program. */
function zipOf(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => new Uint8Array([n & 255, (n >> 8) & 255]);
  const u32 = (n: number) =>
    new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]);
  const cat = (...chunks: Uint8Array[]) => {
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const data = new TextEncoder().encode(text);
    const crc = Bun.hash.crc32(data) >>> 0;
    const local = cat(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(33),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      data,
    );
    central.push(
      cat(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(33),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ),
    );
    parts.push(local);
    offset += local.length;
  }
  const directory = cat(...central);
  return cat(
    ...parts,
    directory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length),
    u16(central.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  );
}

describe("check-suite-authz.ts", () => {
  const entry = join(ROOT, "scripts", "oidc-conformance", "check-suite-authz.ts");
  const run = (...args: string[]) =>
    spawnSync("bun", [entry, ...args], { cwd: ROOT, encoding: "utf8" });
  const json = (log: ModuleLog) => JSON.stringify(log);

  test("exits 0 for a zip of clean logs, and counts them", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "plan.zip"),
      zipOf({
        "test-log-oidcc-server-abc.json": json(stop("oidcc-server", "invalid_request")),
        "test-log-oidcc-userinfo-get-def.json": json(stop("oidcc-userinfo-get", "invalid_request")),
        "test-log-oidcc-server-abc.sig": "not json",
      }),
    );
    const result = run(dir, "2");
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain("module logs read: 2");
    expect(result.stdout).toContain("invalid_request: 2");
  });

  test("exits 0 for loose logs too", () => {
    const dir = tmp();
    writeFileSync(join(dir, "test-log-a-1.json"), json(stop("a", "invalid_request")));
    expect(run(dir).status).toBe(0);
  });

  test("exits 1 for a violation inside a zip, with an ::error:: line", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "plan.zip"),
      zipOf({ "test-log-a-1.json": json(stop("a", "invalid_scope")) }),
    );
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "::error::a: the authorization endpoint answered invalid_scope",
    );
  });

  test("exits 1 for fewer stops than the minimum, for an empty directory and for a missing one", () => {
    const dir = tmp();
    writeFileSync(join(dir, "test-log-a-1.json"), json(stop("a", "invalid_request")));
    expect(run(dir, "27").status).toBe(1);
    expect(run(tmp()).status).toBe(1);
    const missing = run(join(dir, "nope"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("::error::cannot read the results directory");
    expect(missing.stderr).not.toContain("    at ");
  });

  test("exits 1 for a log that is not JSON, and 2 for a bad call", () => {
    const dir = tmp();
    writeFileSync(join(dir, "test-log-a-1.json"), "{ not json");
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not JSON");
    expect(run().status).toBe(2);
    expect(run(dir, "many").status).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------------------------

describe("the workflow's dev mode", () => {
  const text = read(".github/workflows/oidc-conformance.yml");
  interface Step {
    name?: string;
    if?: string;
    env?: Record<string, string>;
    run?: string;
  }
  const workflow = parse(text) as {
    on: {
      workflow_dispatch: {
        inputs: Record<
          string,
          { type: string; options?: string[]; default?: string; required?: boolean }
        >;
      };
    };
    env: Record<string, string>;
    jobs: { conformance: { steps: Step[] } };
  };
  const steps = workflow.jobs.conformance.steps;
  const named = (name: string) => steps.find((s) => s.name === name) as Step;
  const index = (name: string) => steps.findIndex((s) => s.name === name);

  test("takes exactly the four inputs, with the development system's addresses as defaults", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual([
      "target",
      "dev_client_id",
      "dev_issuer",
      "dev_authorization_base",
    ]);
    expect(inputs.target).toMatchObject({
      type: "choice",
      options: ["rig", "dev"],
      default: "rig",
    });
    expect(inputs.dev_client_id).toMatchObject({ required: false, default: "" });
    expect(inputs.dev_issuer?.default).toBe(DEV_ISSUER);
    expect(inputs.dev_authorization_base?.default).toBe(DEV_AUTHORIZATION_BASE);
  });

  test("a dispatch with no target is a rig run", () => {
    expect(workflow.env.TARGET).toBe("${{ inputs.target || 'rig' }}");
  });

  test("the rig, its pre-flight and its log are skipped for dev, and the dev configuration is dev only", () => {
    expect(named("Start the rig").if).toBe("${{ env.TARGET == 'rig' }}");
    expect(named("Wait for the rig, then walk a sign-in").if).toBe("${{ env.TARGET == 'rig' }}");
    expect(named("Check the authorization errors").if).toBe(
      "${{ always() && env.TARGET == 'rig' }}",
    );
    expect(named("Write the dev plan configurations").if).toBe("${{ env.TARGET == 'dev' }}");
    expect(index("Write the dev plan configurations")).toBeLessThan(index("Start the suite"));
  });

  test("inputs reach scripts only through the environment, never inside script text", () => {
    for (const step of steps) expect(String(step.run ?? ""), step.name).not.toContain("inputs.");
    const dev = named("Write the dev plan configurations");
    expect(dev.env).toEqual({
      DEV_ISSUER: "${{ inputs.dev_issuer }}",
      DEV_AUTHORIZATION_BASE: "${{ inputs.dev_authorization_base }}",
      DEV_CLIENT_ID: "${{ inputs.dev_client_id }}",
    });
    expect(dev.run).toBe("bun run scripts/oidc-conformance/dev-config.ts");
  });

  test("the Basic plan takes the selected modules for dev and the whole plan for the rig", () => {
    const run = String(named("Basic plan").run);
    expect(run).toContain('if [ "$TARGET" = "dev" ]; then');
    expect(run).toContain('PLAN="$(cat "$RIG_OUT_DIR/basic-plan-arg.txt")"');
    expect(run).toContain(`PLAN="${BASIC_PLAN_NAME}"`);
    expect(run).toContain('"$PLAN" "$RIG_OUT_DIR/basic-plan.json"');
  });

  test("the suite-results check runs in both targets, after the plans and before the upload", () => {
    const step = named("Check the suite's authorization stops");
    expect(step.if).toBe("${{ always() }}");
    expect(step.run).toBe(
      "bun run scripts/oidc-conformance/check-suite-authz.ts conformance-artifacts/results 27",
    );
    expect(index("Check the suite's authorization stops")).toBeGreaterThan(index("Basic plan"));
    expect(index("Check the suite's authorization stops")).toBeLessThan(
      index("Upload results and logs"),
    );
    expect("continue-on-error" in step).toBe(false);
    expect(String(step.run)).not.toMatch(/\|\||;|true/);
  });

  test("still uses no secret, and says so", () => {
    expect(text).not.toMatch(/secrets\./);
    expect(text).toContain("The workflow still holds no secret");
    expect(text).toContain("scripts/oidc-conformance/dev-target.ts");
  });
});
