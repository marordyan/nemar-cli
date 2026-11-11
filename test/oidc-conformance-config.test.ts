/**
 * The conformance run's own configuration (epic #2014 phase #2020): what can be checked without
 * running the suite. The run needs Docker and takes half an hour, so the things that make it
 * trustworthy are pinned here where `bun test` sees them:
 *
 *  - the plan configurations point the suite at the rig's pages and callback, carry two clients, and
 *    the configuration plan carries no client at all;
 *  - every image the run pulls is pinned by digest, and the tags in the override and in the workflow
 *    agree;
 *  - the workflow uses no secret, has read-only permissions, uploads only the results and logs (never
 *    the plan configurations, which hold the throwaway clients' secrets), runs the Basic plan with the
 *    variants the phase approved, and is started by hand only (no push or schedule trigger).
 *
 * Nothing here replaces NEMAR logic; the rig and the suite are exercised by the run.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  ALLOWED_AUTHORIZATION_ERRORS,
  answerError,
  authorizationLogLine,
  carriesChallenge,
  checkAuthorizationLog,
} from "../scripts/oidc-conformance/authz-log";
import {
  RIG_ACCOUNT_EMAIL,
  RIG_TEXT,
  buildBasicPlanConfig,
  buildConfigPlanConfig,
  callbackAddress,
} from "../scripts/oidc-conformance/plan-config";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const ADDR = { issuer: "https://rig.example.org:9443", alias: "nemar" };
const CLIENTS = {
  client: { client_id: "client-one", client_secret: "secret-one" },
  client2: { client_id: "client-two", client_secret: "secret-two" },
  clientPost: { client_id: "client-post", client_secret: "secret-post" },
};

describe("the plan configurations", () => {
  test("the callback address is the suite's alias path", () => {
    expect(callbackAddress("https://localhost.emobix.co.uk:8443/", "nemar")).toBe(
      "https://localhost.emobix.co.uk:8443/test/a/nemar/callback",
    );
  });

  test("the configuration plan reads discovery and holds no client", () => {
    const config = buildConfigPlanConfig(ADDR);
    expect(config.server).toEqual({
      discoveryUrl: "https://rig.example.org:9443/.well-known/openid-configuration",
    });
    expect(Object.keys(config).sort()).toEqual(["alias", "description", "server"]);
  });

  test("the Basic plan has the clients, the sign-in and consent tasks, and the overrides", () => {
    const config = buildBasicPlanConfig(ADDR, CLIENTS) as {
      client: unknown;
      client2: unknown;
      browser: Array<{
        match: string;
        tasks: Array<{ task: string; match?: string; optional?: boolean }>;
      }>;
      override: Record<string, { browser: unknown[] }>;
    };
    expect(config.client).toEqual(CLIENTS.client);
    expect(config.client2).toEqual(CLIENTS.client2);
    // The suite's client_secret_post module reads this client; without it the module stops on the
    // configuration instead of on what NEMAR does.
    expect((config as { client_secret_post?: unknown }).client_secret_post).toEqual(
      CLIENTS.clientPost,
    );
    const block = config.browser[0];
    expect(block?.match).toBe("https://rig.example.org:9443/oauth/authorize*");
    expect(block?.tasks.map((t) => t.task)).toEqual(["Login", "Consent", "Verify Complete"]);
    // Sign-in and consent are optional (a prompt=none request shows neither); completion is not.
    expect(block?.tasks.map((t) => t.optional === true)).toEqual([true, true, false]);
    expect(Object.keys(config.override).sort()).toEqual([
      "oidcc-ensure-registered-redirect-uri",
      "oidcc-ensure-request-object-with-redirect-uri",
      "oidcc-max-age-1",
      "oidcc-prompt-login",
    ]);
    // Both redirect-address tests expect the same error page.
    expect(config.override["oidcc-ensure-request-object-with-redirect-uri"]).toEqual(
      config.override["oidcc-ensure-registered-redirect-uri"],
    );
  });

  test("the browser signs in with the rig's account and chooses Allow by its value", () => {
    const text = JSON.stringify(buildBasicPlanConfig(ADDR, CLIENTS));
    expect(text).toContain(RIG_ACCOUNT_EMAIL);
    expect(text).toContain("//button[@value='allow']");
    expect(text).toContain(RIG_TEXT.redirectNotRegistered);
  });
});

describe("the expected-failures and expected-skips files", () => {
  interface Entry {
    "test-name": string;
    "configuration-filename": string;
    "expected-result"?: string;
    condition?: string;
    comment: string;
  }
  const failures = JSON.parse(read("scripts/oidc-conformance/expected-failures.json")) as Entry[];
  const skips = JSON.parse(read("scripts/oidc-conformance/expected-skips.json")) as Entry[];
  const configFailures = JSON.parse(
    read("scripts/oidc-conformance/expected-failures-config.json"),
  ) as Entry[];

  test("none is empty, so the workflow's claim that deviations are recorded is true", () => {
    expect(failures.length).toBeGreaterThan(0);
    expect(skips.length).toBeGreaterThan(0);
    expect(configFailures.length).toBeGreaterThan(0);
  });

  test("every entry names the decision that approved it", () => {
    for (const entry of [...failures, ...skips, ...configFailures]) {
      expect({
        test: entry["test-name"],
        named: /\bDecisions? \d[a-z]?\b/.test(entry.comment),
      }).toEqual({ test: entry["test-name"], named: true });
    }
  });

  test("covers the three deviations: RS256, client_secret_post and mandatory PKCE", () => {
    expect(configFailures.map((f) => f.condition)).toEqual([
      "OIDCCCheckDiscEndpointIdTokenSigningAlgValuesSupported",
    ]);
    expect(configFailures[0]?.comment).toMatch(/Decision 3c/);
    const post = failures.filter((f) => f["test-name"] === "oidcc-server-client-secret-post");
    expect(post.map((f) => f.condition).sort()).toEqual([
      "CheckIfAuthorizationEndpointError",
      "EnsureServerConfigurationSupportsClientSecretPost",
    ]);
    for (const f of post) expect(f.comment).toMatch(/Decisions? 3b/);
    // The suite records the module's failure and goes on; no comment says it stops there.
    for (const f of post) expect(f.comment).not.toMatch(/before it sends any request/);
    expect(post[0]?.comment).toMatch(/records this failure and goes on/);
    const pkce = failures.filter((f) => f.condition === "CheckIfAuthorizationEndpointError");
    expect(pkce.length).toBeGreaterThan(20);
    for (const f of pkce) expect(f.comment).toMatch(/\b3a\b/);
  });

  test("the skips are the scope tests the discovery document rules out and the request object", () => {
    expect(skips.map((s) => s["test-name"]).sort()).toEqual([
      "oidcc-scope-address",
      "oidcc-scope-all",
      "oidcc-scope-phone",
      "oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported",
    ]);
  });

  test("each entry names its plan's configuration by pattern, never a runner path", () => {
    for (const entry of [...failures, ...skips]) {
      expect(entry["configuration-filename"]).toBe("*basic-plan.json");
    }
    for (const entry of configFailures)
      expect(entry["configuration-filename"]).toBe("*config-plan.json");
  });
});

/** The rig's request line for each authorization line, as a run's log has them (one request, one line). */
const withRequests = (...lines: string[]) =>
  lines
    .flatMap((l) => (l.includes("[rig] authz") ? ["[rig] GET /oauth/authorize 302", l] : [l]))
    .join("\n");

describe("the authorization log and its check", () => {
  test("the allowed set is the three codes the approved deviations and the REVIEW modules produce", () => {
    expect([...ALLOWED_AUTHORIZATION_ERRORS]).toEqual([
      "invalid_request",
      "request_not_supported",
      "page:invalid_redirect_uri",
    ]);
    // And the workflow writes the same set down.
    const header = read(".github/workflows/oidc-conformance.yml").split("\n\nname:")[0] ?? "";
    for (const code of ALLOWED_AUTHORIZATION_ERRORS) expect(header).toContain(code);
  });

  test("the module's header states the residual risk of a global allowed set", () => {
    const header = read("scripts/oidc-conformance/authz-log.ts").split("*/")[0] ?? "";
    expect(header).toContain("RESIDUAL RISK");
    expect(header).toContain("not per module");
  });

  test("a line holds a kind, an error and a yes or no, and reads back", () => {
    const line = authorizationLogLine("redirect", "invalid_request", false);
    expect(line).toBe("[rig] authz kind=redirect error=invalid_request pkce=no");
    expect(checkAuthorizationLog(withRequests(line))).toEqual({
      responses: 1,
      authorizationLines: 1,
      requests: 1,
      byError: { invalid_request: 1 },
      violations: [],
    });
    expect(carriesChallenge("a=b&code_challenge=x")).toBe(true);
    expect(carriesChallenge("a=b&code_challenge_method=S256")).toBe(false);
  });

  test("passes a run made of the allowed answers", () => {
    const log = withRequests(
      authorizationLogLine("redirect", "invalid_request", false),
      authorizationLogLine("redirect", "request_not_supported", false),
      authorizationLogLine("error_page", "page:invalid_redirect_uri", false),
      authorizationLogLine("consent", null, true),
      authorizationLogLine("redirect", null, true),
    );
    expect(checkAuthorizationLog(log).violations).toEqual([]);
  });

  test("fails a different error that the expected failure would have hidden", () => {
    const log = authorizationLogLine("redirect", "invalid_scope", true);
    expect(checkAuthorizationLog(withRequests(log)).violations).toEqual([
      "an authorization response (redirect) carried the error invalid_scope, which no approved deviation produces",
    ]);
  });

  test("fails an invalid_request that came to a request with a challenge", () => {
    const log = authorizationLogLine("redirect", "invalid_request", true);
    expect(checkAuthorizationLog(withRequests(log)).violations).toEqual([
      "invalid_request answered a request that carried a code_challenge, so it is not the PKCE deviation",
    ]);
  });

  test("a malformed authorization line is a violation, never skipped", () => {
    const shapes: Record<string, string> = {
      "an empty value": "[rig] authz kind=redirect error= pkce=no",
      "a value with a space": "[rig] authz kind=redirect error=a b pkce=no",
      "a trailing field": "[rig] authz kind=redirect error=invalid_request pkce=no extra=1",
      "an unknown kind": "[rig] authz kind=somewhere error=none pkce=no",
      "no challenge field": "[rig] authz kind=redirect error=invalid_request",
      "an upper-case value": "[rig] authz kind=redirect error=Invalid pkce=no",
    };
    for (const [shape, line] of Object.entries(shapes)) {
      const report = checkAuthorizationLog(
        withRequests(authorizationLogLine("login", null, true), line),
      );
      expect({ shape, violations: report.violations }).toEqual({
        shape,
        // request, login line, request, then the malformed one.
        violations: ["unparseable authorization line 4"],
      });
    }
  });

  test("a newline inside a value splits the line, and the first half is a violation", () => {
    const log = "[rig] authz kind=redirect error=bad\nvalue pkce=no\n";
    expect(checkAuthorizationLog(log).violations).toContain("unparseable authorization line 1");
  });

  test("answerError names a well-formed error word and flags every other spelling", () => {
    const redirect = (query: string) => ({
      kind: "redirect" as const,
      location: `https://client.example.org/cb?${query}`,
    });
    expect(answerError(redirect("code=abc&state=s&iss=x"))).toBeNull();
    expect(answerError(redirect("error=invalid_request&state=s"))).toBe("invalid_request");
    for (const query of [
      "error=",
      "error=a%20b",
      "error=a%0Ab",
      "error=A",
      "error=a&error=b",
      "error=a-b",
    ]) {
      expect({ query, error: answerError(redirect(query)) }).toEqual({
        query,
        error: "malformed_error",
      });
    }
    expect(answerError({ kind: "redirect", location: "not an address" })).toBe("malformed_error");
    expect(answerError({ kind: "error_page", code: "invalid_redirect_uri" })).toBe(
      "page:invalid_redirect_uri",
    );
    expect(answerError({ kind: "error_page", code: "Bad Code" })).toBe("malformed_error");
    expect(answerError({ kind: "login" })).toBeNull();
    // A malformed error is not in the allowed set, so the check fails the run.
    const line = authorizationLogLine("redirect", answerError(redirect("error=")), false);
    expect(checkAuthorizationLog(withRequests(line)).violations).toEqual([
      "an authorization response (redirect) carried the error malformed_error, which no approved deviation produces",
    ]);
  });

  test("matches strictly: surrounding whitespace is a violation, not trimmed away", () => {
    const line = authorizationLogLine("login", null, true);
    for (const padded of [` ${line}`, `${line} `, `${line}\r`]) {
      expect(checkAuthorizationLog(withRequests(padded)).violations).toContain(
        "unparseable authorization line 2",
      );
    }
  });

  test("an error in the fragment is seen, and so is one in both places", () => {
    const back = "https://client.example.org/cb";
    expect(
      answerError({ kind: "redirect", location: `${back}#error=invalid_request&state=s` }),
    ).toBe("invalid_request");
    expect(answerError({ kind: "redirect", location: `${back}#error=` })).toBe("malformed_error");
    expect(answerError({ kind: "redirect", location: `${back}?error=a#error=b` })).toBe(
      "malformed_error",
    );
    expect(answerError({ kind: "redirect", location: `${back}#code=abc` })).toBeNull();
    const line = authorizationLogLine(
      "redirect",
      answerError({ kind: "redirect", location: `${back}#error=server_error` }),
      true,
    );
    expect(checkAuthorizationLog(withRequests(line)).violations).toEqual([
      "an authorization response (redirect) carried the error server_error, which no approved deviation produces",
    ]);
  });

  test("a rule refusal logs access_denied, which the check then flags", () => {
    const back = "https://client.example.org/cb";
    expect(
      answerError({ kind: "rule_refused", location: `${back}?error=access_denied&state=s` }),
    ).toBe("access_denied");
    // Even a location that names no error is a refusal.
    expect(answerError({ kind: "rule_refused", location: `${back}?state=s` })).toBe(
      "access_denied",
    );
    // A malformed one stays malformed.
    expect(answerError({ kind: "rule_refused", location: `${back}?error=` })).toBe(
      "malformed_error",
    );
    const line = authorizationLogLine("rule_refused", "access_denied", true);
    expect(line).toBe("[rig] authz kind=rule_refused error=access_denied pkce=yes");
    expect(checkAuthorizationLog(withRequests(line)).violations).toEqual([
      "an authorization response (rule_refused) carried the error access_denied, which no approved deviation produces",
    ]);
  });

  test("fails when a request has no authorization line, and when a line has no request", () => {
    const line = authorizationLogLine("redirect", "invalid_request", false);
    const request = "[rig] GET /oauth/authorize 302";
    // A request whose response was never logged: the check never saw it.
    expect(checkAuthorizationLog([request, line, request].join("\n")).violations).toEqual([
      "2 authorization requests but 1 authorization lines",
    ]);
    // A consent POST counts the same way.
    expect(
      checkAuthorizationLog([line, request, "[rig] POST /oauth/consent 302"].join("\n")).violations,
    ).toEqual(["2 authorization requests but 1 authorization lines"]);
    // A line with no request behind it.
    expect(checkAuthorizationLog(line).violations).toEqual([
      "0 authorization requests but 1 authorization lines",
    ]);
    // Counts that match pass; other routes and other consent methods are not authorization requests.
    const matching = [
      request,
      line,
      "[rig] GET /oauth/consent 404",
      "[rig] POST /oauth/token 200",
    ].join("\n");
    expect(checkAuthorizationLog(matching)).toMatchObject({
      requests: 1,
      authorizationLines: 1,
      violations: [],
    });
  });

  test("fails an empty log, which would check nothing", () => {
    expect(checkAuthorizationLog("").violations).toHaveLength(1);
    expect(checkAuthorizationLog("[rig] GET /login 200").responses).toBe(0);
  });
});

describe("the check's entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "nemar-check-authz-"));
  const entry = join(ROOT, "scripts", "oidc-conformance", "check-authz.ts");
  const run = (file: string) => spawnSync("bun", [entry, file], { cwd: ROOT, encoding: "utf8" });
  const file = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const clean = [
    "[rig] GET /oauth/authorize 302",
    authorizationLogLine("redirect", "invalid_request", false),
    "[rig] GET /oauth/authorize 200",
    authorizationLogLine("consent", null, true),
    "",
  ].join("\n");

  test("exits 0 for a clean log", () => {
    const result = run(file("clean.log", clean));
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain("invalid_request: 1");
  });

  test("exits 1 for a log with a violation", () => {
    const bad = `${clean}${authorizationLogLine("redirect", "invalid_scope", true)}\n`;
    const result = run(file("bad.log", bad));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::");
  });

  test("exits 1 for an empty log", () => {
    expect(run(file("empty.log", "")).status).toBe(1);
  });

  test("exits 1 for a missing log, with an ::error:: line and no stack trace", () => {
    const result = run(join(dir, "does-not-exist.log"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error::cannot read the rig's log");
    expect(result.stderr).not.toContain("    at ");
  });

  test("exits 2 and says how to call it when given no file", () => {
    const result = spawnSync("bun", [entry], { cwd: ROOT, encoding: "utf8" });
    expect(result.status).toBe(2);
  });

  test("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the images", () => {
  const override = parse(read("scripts/oidc-conformance/compose.override.yml")) as {
    services: Record<string, { image: string; extra_hosts?: string[] }>;
  };

  test("each of the three is pinned by tag and by digest", () => {
    const images = Object.values(override.services).map((s) => s.image);
    expect(images).toHaveLength(3);
    for (const image of images) expect(image).toMatch(/:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
  });

  test("the suite's two images are at the workflow's release tag", () => {
    const tag = /SUITE_TAG:\s*(\S+)/.exec(read(".github/workflows/oidc-conformance.yml"))?.[1];
    expect(tag).toMatch(/^release-v\d+\.\d+\.\d+$/);
    expect(override.services.server?.image).toContain(`:${tag}@`);
    expect(override.services.nginx?.image).toContain(`:${tag}@`);
    expect(override.services.mongodb?.image).toContain("mongo:6.0.13@");
  });

  test("the suite's server reaches the rig by name, from the host's gateway", () => {
    expect(override.services.server?.extra_hosts).toEqual(["rig.example.org:host-gateway"]);
  });
});

describe("the workflow", () => {
  const text = read(".github/workflows/oidc-conformance.yml");
  interface Step {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    "timeout-minutes"?: number;
    with?: { path: string };
  }
  const workflow = parse(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: { conformance: { "timeout-minutes": number; steps: Step[] } };
  };
  const steps = workflow.jobs.conformance.steps;

  test("is dispatched by hand and by nothing else", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  });

  test("reads the repository and nothing else, uses no secret, and is bounded", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(text).not.toMatch(/secrets\./);
    expect(workflow.jobs.conformance["timeout-minutes"]).toBe(60);
  });

  test("uploads the results and the logs, and never the plan configurations", () => {
    const upload = steps.find((s) => String(s.uses).startsWith("actions/upload-artifact@"));
    expect(upload?.with?.path.trim()).toBe("conformance-artifacts/");
    // The plan configurations are written to the runner's temporary directory, outside that path.
    expect(text).toContain("RIG_OUT_DIR=$RUNNER_TEMP/rig-out");
    expect(text).not.toMatch(/path:[^\n]*rig-out/);
  });

  test("runs the configuration plan first, then the approved Basic variants", () => {
    const names = steps.map((s) => s.name);
    expect(names.indexOf("Configuration plan (smoke test, no browser)")).toBeLessThan(
      names.indexOf("Basic plan"),
    );
    expect(text).toContain(
      '"oidcc-basic-certification-test-plan[server_metadata=discovery][client_registration=static_client]"',
    );
    expect(text).toContain('"oidcc-config-certification-test-plan"');
  });

  test("pins the Python packages exactly, and nothing newer than the pin date can be resolved", () => {
    expect(text).toContain("--with httpx==0.28.1 --with pyparsing==3.3.3");
    const runs = text.match(/uv run [^\n]*/g) ?? [];
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(run).toContain("--exclude-newer 2026-11-05");
    const setup = steps.find((s) => String(s.uses).startsWith("astral-sh/setup-uv@"));
    expect((setup as { with?: { "enable-cache"?: boolean } }).with?.["enable-cache"]).toBe(false);
  });

  test("bounds each long step so that together they fit the 60 minute job", () => {
    const limit = (name: string) =>
      steps.find((s) => s.name === name)?.["timeout-minutes"] as number;
    expect(limit("Start the suite")).toBe(12);
    expect(limit("Configuration plan (smoke test, no browser)")).toBe(10);
    expect(limit("Basic plan")).toBe(30);
    const total =
      limit("Start the suite") +
      limit("Configuration plan (smoke test, no browser)") +
      limit("Basic plan");
    // Leaves at least eight minutes for the installs, the pull, the logs and the upload.
    expect(total).toBeLessThanOrEqual(52);
    expect(workflow.jobs.conformance["timeout-minutes"]).toBe(60);
  });

  test("checks the authorization errors after the plans and before the upload", () => {
    const names = steps.map((s) => s.name);
    const check = names.indexOf("Check the authorization errors");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(names.indexOf("Basic plan"));
    expect(check).toBeLessThan(names.indexOf("Upload results and logs"));
    expect(String(steps[check]?.run)).toContain("check-authz.ts conformance-artifacts/rig.log");
    // Nothing lets the step pass when the check fails: no continue-on-error, and no "||", ";" or "true".
    const step = steps[check] as Record<string, unknown>;
    expect("continue-on-error" in step).toBe(false);
    expect(String(step.run)).not.toMatch(/\|\||;|true/);
    // It runs even if a plan failed, so a failure never hides the cause.
    expect(String(steps[check]?.if)).toContain("always()");
  });

  test("stops the rig and the suite before it uploads anything", () => {
    const names = steps.map((s) => s.name);
    const stop = names.indexOf("Stop the rig and the suite");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(names.indexOf("Upload results and logs"));
    const body = String(steps[stop]?.run);
    expect(body).toContain("kill");
    expect(body).toContain("docker compose");
    expect(body).toContain("down");
    // It always runs, waits up to 10 seconds for the rig to exit, and fails if the rig is still there.
    expect(String(steps[stop]?.if)).toContain("always()");
    expect(body).toContain("kill -0");
    expect(body).toMatch(/seq 1 20[\s\S]*sleep 0\.5[\s\S]*exit 1/);
    // The pid is read without failing the step when the file is missing, and an empty pid skips the wait.
    expect(body).toContain('pid=$(cat "$RUNNER_TEMP/rig.pid" 2>/dev/null || true)');
    expect(body).toContain('[ -n "$pid" ] || exit 0');
    // Two waits, a kill -9 between them, and the failure only after the second wait.
    const waits = [...body.matchAll(/seq 1 20/g)].map((m) => m.index as number);
    expect(waits).toHaveLength(2);
    const kill9 = body.indexOf("kill -9");
    expect(kill9).toBeGreaterThan(waits[0] as number);
    expect(kill9).toBeLessThan(waits[1] as number);
    expect(body.indexOf("exit 1")).toBeGreaterThan(waits[1] as number);
    expect(body.indexOf("exit 1")).toBe(body.lastIndexOf("exit 1"));
    // The header says what the uploaded files do and do not hold.
    expect(text).toContain("nothing live is uploaded");
  });

  test("checks the suite's commit, so a moved tag fails the run", () => {
    expect(text).toMatch(/SUITE_COMMIT:\s*[0-9a-f]{40}/);
    expect(text).toContain('"$actual" != "$SUITE_COMMIT"');
  });
});
