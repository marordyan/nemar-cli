/**
 * The rig for the OpenID Foundation conformance suite (epic #2014 phase #2020, slice C1).
 *
 * NOT A TEST FILE. It serves the REAL Worker entry point over a throwaway in-memory SQLite database
 * that carries every migration, on a TLS listener the suite can reach, and prints nothing a log must not
 * hold. Everything the suite checks is NEMAR's own code: discovery, keys, the authorization check and
 * consent routes, the token, userinfo, revocation and introspection endpoints.
 *
 * WHAT THE RIG REPLACES is the website's HTML, and only that, because the suite's browser (HtmlUnit)
 * cannot run the website's module scripts or be handed a cookie:
 *   - `/login`: a script-free form. It signs in through the REAL routes (`/auth/code/request`, whose
 *     answer echoes the code for a `.test` account outside production, then `/auth/code/verify`) and
 *     relays the real `Set-Cookie`. It first clears the account's recent sign-in codes from the throwaway
 *     database, because production allows five codes an hour and the suite signs in many times a minute;
 *     the limit is an abuse control for a real mailbox and is not what is under test.
 *   - `/oauth/authorize` and `/oauth/consent`: the authorization page's contract. They forward the
 *     request and the person's cookie to the check and consent routes (as the website's server does,
 *     with the pinned `Origin` and the caller marker) and render or follow the answer.
 *
 * WHAT THIS CANNOT FIND: a defect in the website's real page. The real page refuses a cross-site `POST`
 * (Astro's origin check) and this stand-in accepts it, so `oidcc-ensure-post-request-succeeds` passes
 * here and says nothing about the page. The real page is the later slice's run.
 *
 * ENVIRONMENT (all optional except RIG_OUT_DIR):
 *   RIG_OUT_DIR   where the plan configurations are written (they hold the throwaway clients' secrets,
 *                 are never uploaded or logged, and live outside the artifact paths; the result files
 *                 the suite exports DO copy the three plan clients' secrets, but they belong to a
 *                 database that lives in the rig's memory and dies when the job ends, so nothing live
 *                 is uploaded)
 *   RIG_HOST      the host name the suite reaches the rig by (default rig.example.org)
 *   RIG_PORT      the TLS port (default 9443)
 *   SUITE_ORIGIN  the suite's public origin (default https://localhost.emobix.co.uk:8443)
 *   RIG_ALIAS     the suite alias, which fixes its callback address (default nemar)
 *
 * NETWORK. The listener binds all interfaces because on a GitHub-hosted runner the suite's container
 * reaches the host through Docker's `host-gateway`. A move to the shared application host must NOT
 * keep that: bind the Docker gateway address only (or a user-defined bridge), so the rig is not
 * reachable from the host's other networks.
 *
 * The certificate is self-signed, made by `openssl` into a temporary directory when the rig starts, held
 * in memory and removed at once. It is stored nowhere.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../../backend/src/index";
import type { Bindings } from "../../backend/src/types/bindings";
import { freshDb, realD1 } from "../../backend/test/helpers/d1";
import { seedUser } from "../../backend/test/helpers/oidc-harness";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
  OIDC_AUTHORIZE_CONSENT_PATH,
  type OidcAuthorizeAnswer,
} from "../../shared/contract/oidc-authorize";
import { OIDC_SECRET_PREFIX } from "../../shared/oidc";
import { answerError, authorizationLogLine, carriesChallenge } from "./authz-log";
import {
  RIG_ACCOUNT_EMAIL,
  RIG_TEXT,
  buildBasicPlanConfig,
  buildConfigPlanConfig,
  callbackAddress,
} from "./plan-config";

const HOST = process.env.RIG_HOST ?? "rig.example.org";
const PORT = Number(process.env.RIG_PORT ?? 9443);
const ISSUER = `https://${HOST}:${PORT}`;
const SUITE_ORIGIN = process.env.SUITE_ORIGIN ?? "https://localhost.emobix.co.uk:8443";
const ALIAS = process.env.RIG_ALIAS ?? "nemar";
const OUT_DIR = process.env.RIG_OUT_DIR;
if (!OUT_DIR) throw new Error("RIG_OUT_DIR is required");

/** The origin the website's page pins on its own calls to the API. */
const PAGE_ORIGIN = "https://app.nemar.org";

const hex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// ---------------------------------------------------------------------------------------------
// The Worker, over a throwaway database
// ---------------------------------------------------------------------------------------------

const db = freshDb();
const OWNER_KEY = `rig-owner-key-${hex(24)}`;
const env = {
  DB: realD1(db),
  ENVIRONMENT: "development",
  API_BASE_URL: ISSUER,
  APP_BASE_URL: ISSUER,
  OIDC_SECRET: `${OIDC_SECRET_PREFIX}${hex(32)}`,
  ENCRYPTION_KEY: `rig-encryption-key-${hex(24)}`,
  HOST_PREFIXED_SESSION_COOKIE: "1",
} as unknown as Bindings;

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch((err) => console.error("[rig] background work failed:", err));
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const call = (req: Request) => worker.fetch(req, env, ctx);

interface Reply {
  status: number;
  headers: Headers;
  json: Record<string, unknown> | null;
  text: string;
}

/** One request into the Worker, in process. */
async function api(
  method: string,
  path: string,
  opts: { key?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  const res = await call(
    new Request(`${ISSUER}${path}`, {
      method,
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    }),
  );
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

// ---------------------------------------------------------------------------------------------
// Seeding, through the real routes where a route exists
// ---------------------------------------------------------------------------------------------

async function registerClient(name: string): Promise<{ client_id: string; client_secret: string }> {
  const res = await api("POST", "/admin/oidc/clients", {
    key: OWNER_KEY,
    json: {
      name,
      redirect_uris: [callbackAddress(SUITE_ORIGIN, ALIAS)],
      allowed_scopes: ["openid", "profile", "email", "offline_access"],
      allowed_grants: ["authorization_code", "refresh_token"],
      sign_in_rule: "person_proven_orcid",
      audience: "https://api.example.org",
    },
  });
  if (res.status !== 201 || !res.json)
    throw new Error(`client registration answered ${res.status}`);
  return {
    client_id: (res.json.client as { client_id: string }).client_id,
    client_secret: res.json.client_secret as string,
  };
}

async function seed(): Promise<void> {
  await seedUser(db, "rigowner", "owner", OWNER_KEY);
  const rotated = await api("POST", "/admin/oidc/keys/rotate", { key: OWNER_KEY, json: {} });
  if (rotated.status !== 200) throw new Error(`key rotation answered ${rotated.status}`);

  // A person with an ORCID iD proven by signing in with ORCID, who can sign in by e-mail code.
  const orcid = "0000-0002-1825-0097";
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind,
                        orcid, orcid_verified, given_name, family_name, service_access)
     VALUES ('conformance', ?, 'x', 'verified', 'member', 1, 'person', ?, 1, 'Conformance', 'Tester', 0)`,
  ).run(RIG_ACCOUNT_EMAIL, orcid);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?")
    .get(RIG_ACCOUNT_EMAIL);
  if (!row) throw new Error("the person was not seeded");
  db.query(
    "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
  ).run(row.id, orcid);

  const client = await registerClient("Conformance client one");
  const client2 = await registerClient("Conformance client two");
  // The suite's client_secret_post module reads its own client; NEMAR refuses a secret in the body.
  const clientPost = await registerClient("Conformance client post");
  // The pre-flight signs in at a client of its own, so client one's consent and grant are not spent.
  const smokeClient = await registerClient("Conformance pre-flight");

  mkdirSync(OUT_DIR as string, { recursive: true });
  const addr = { issuer: ISSUER, alias: ALIAS };
  writeFileSync(
    join(OUT_DIR as string, "config-plan.json"),
    JSON.stringify(buildConfigPlanConfig(addr), null, 2),
  );
  writeFileSync(
    join(OUT_DIR as string, "basic-plan.json"),
    JSON.stringify(buildBasicPlanConfig(addr, { client, client2, clientPost }), null, 2),
  );
  writeFileSync(join(OUT_DIR as string, "smoke-client.json"), JSON.stringify(smokeClient));
}

// ---------------------------------------------------------------------------------------------
// The stand-in pages
// ---------------------------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const html = (status: number, title: string, body: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
};

const pageHeaders = (cookie: string) => ({
  Cookie: cookie,
  Origin: PAGE_ORIGIN,
  [OIDC_AUTHORIZE_CALLER_HEADER]: OIDC_AUTHORIZE_CALLER_VALUE,
});

/** Where to send the person after signing in: only the rig's own authorization page. */
function safeNext(next: string | null): string {
  if (next?.startsWith("/oauth/authorize") && !next.startsWith("//") && !next.includes("\\")) {
    return next;
  }
  return "/oauth/authorize";
}

function loginPage(next: string): Response {
  return html(
    200,
    "Sign in",
    `<h1>${RIG_TEXT.signIn}</h1>
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<label for="email">Email</label>
<input id="email" name="email" type="text" value="">
<button id="signin" type="submit">Continue</button>
</form>`,
  );
}

async function login(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET") return loginPage(safeNext(url.searchParams.get("next")));
  const form = new URLSearchParams(await req.text());
  const email = (form.get("email") ?? "").trim().toLowerCase();
  const next = safeNext(form.get("next"));
  const fail = (what: string) =>
    html(500, "Sign-in failed", `<h1>Sign-in failed</h1><p>${esc(what)}</p>`);

  // Only the rig's own account may sign in here: the next statement deletes auth codes, and it must
  // never be reachable for any other address.
  if (email !== RIG_ACCOUNT_EMAIL) {
    return html(400, "Sign-in refused", "<h1>Sign-in refused</h1><p>Unknown account.</p>");
  }
  // The abuse counter of a real mailbox is not under test: clear it for this throwaway account.
  db.query("DELETE FROM auth_codes WHERE email = ?").run(RIG_ACCOUNT_EMAIL);
  const requested = await api("POST", "/auth/code/request", { json: { email } });
  const code = requested.json?.dev_code;
  if (requested.status !== 200 || typeof code !== "string") {
    return fail(`the code request answered ${requested.status} without a code`);
  }
  const cookie = req.headers.get("cookie") ?? "";
  const verified = await api("POST", "/auth/code/verify", {
    json: { email, code, remember: false },
    headers: { Origin: PAGE_ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
  });
  if (verified.status !== 200) return fail(`the code check answered ${verified.status}`);
  return redirect(next, verified.headers.getSetCookie());
}

function consentPage(
  answer: Extract<OidcAuthorizeAnswer, { kind: "consent" }>,
  request: string,
): Response {
  const scopes = answer.scopes.map((s) => `<li>${esc(s)}</li>`).join("");
  return html(
    200,
    "Allow access",
    `<h1>Allow ${esc(answer.client_name)} to sign you in?</h1>
<ul>${scopes}</ul>
<form method="post" action="/oauth/consent">
<input type="hidden" name="request" value="${esc(request)}">
<input type="hidden" name="consent_token" value="${esc(answer.consent_token)}">
<button type="submit" name="decision" value="deny">Deny</button>
<button type="submit" name="decision" value="allow">Allow</button>
</form>`,
  );
}

const ERROR_PAGE_TEXT: Record<string, string> = {
  invalid_client: "NEMAR does not know the application that sent you here.",
  invalid_redirect_uri: `The application asked NEMAR to send you to an address it ${RIG_TEXT.redirectNotRegistered}.`,
  invalid_request: "NEMAR could not read the request this application sent.",
  consent_invalid:
    "NEMAR could not confirm that you saw this request. Start again from the application.",
  unavailable: "NEMAR could not complete this sign-in. Start again from the application.",
};

/** Render what the check or the consent route answered. */
function follow(answer: OidcAuthorizeAnswer, request: string): Response {
  // One line per authorization response: its kind, its error code if any, and whether the request
  // carried a code_challenge. No value is logged.
  console.log(authorizationLogLine(answer.kind, answerError(answer), carriesChallenge(request)));
  switch (answer.kind) {
    case "redirect":
      return redirect(answer.location);
    case "login":
    case "reauth":
      return redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${answer.request}`)}`);
    case "consent":
      return consentPage(answer, request);
    case "rule_refused":
      return html(
        403,
        "Not allowed",
        `<h1>This account cannot sign in to ${esc(answer.client_name)}</h1><p><a href="${esc(answer.location)}">Return to the application</a></p>`,
      );
    case "error_page":
      return html(
        400,
        "Something went wrong",
        `<h1>Something went wrong</h1><p>${esc(ERROR_PAGE_TEXT[answer.code] ?? answer.code)}</p>`,
      );
  }
}

async function authorizePage(req: Request): Promise<Response> {
  // A GET carries the request in its query; a POST carries the same string as a form body.
  const request =
    req.method === "POST"
      ? (await req.text()).replace(/^\?/, "")
      : new URL(req.url).search.slice(1);
  const res = await api("POST", OIDC_AUTHORIZE_CHECK_PATH, {
    json: { request },
    headers: pageHeaders(req.headers.get("cookie") ?? ""),
  });
  if (res.status !== 200 || !res.json) {
    console.log(
      authorizationLogLine("check_failed", `check_status_${res.status}`, carriesChallenge(request)),
    );
    return html(
      502,
      "Error",
      `<h1>Error</h1><p>The authorization check answered ${res.status}.</p>`,
    );
  }
  return follow(res.json as unknown as OidcAuthorizeAnswer, request);
}

async function consentDecision(req: Request): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const res = await api("POST", OIDC_AUTHORIZE_CONSENT_PATH, {
    json: {
      request: form.get("request") ?? "",
      consent_token: form.get("consent_token") ?? "",
      decision: form.get("decision") ?? "",
    },
    headers: pageHeaders(req.headers.get("cookie") ?? ""),
  });
  if (res.status !== 200 || !res.json) {
    console.log(
      authorizationLogLine(
        "check_failed",
        `consent_status_${res.status}`,
        carriesChallenge(form.get("request") ?? ""),
      ),
    );
    return html(502, "Error", `<h1>Error</h1><p>The consent decision answered ${res.status}.</p>`);
  }
  return follow(res.json as unknown as OidcAuthorizeAnswer, form.get("request") ?? "");
}

// ---------------------------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------------------------

function certificate(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "nemar-rig-"));
  try {
    const made = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${HOST}`,
        "-addext",
        `subjectAltName=DNS:${HOST},DNS:localhost`,
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { encoding: "utf8" },
    );
    if (made.status !== 0) {
      throw new Error(`openssl could not make the certificate: ${made.stderr}`);
    }
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await seed();

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  tls: certificate(),
  async fetch(req) {
    const url = new URL(req.url);
    let res: Response;
    try {
      if (url.pathname === "/login") res = await login(req);
      else if (url.pathname === "/oauth/authorize") res = await authorizePage(req);
      else if (url.pathname === "/oauth/consent" && req.method === "POST") {
        res = await consentDecision(req);
      } else res = await call(req);
    } catch (err) {
      console.error("[rig] request failed:", err);
      // A request the stand-in pages could not answer still gets its authorization line, so the run's
      // check sees it (the line count must equal the request count).
      if (
        url.pathname === "/oauth/authorize" ||
        (url.pathname === "/oauth/consent" && req.method === "POST")
      ) {
        console.log(authorizationLogLine("check_failed", "handler_failed", false));
      }
      res = new Response("internal error", { status: 500 });
    }
    // Method, path and status only: never a query, a code, a token or a body.
    console.log(`[rig] ${req.method} ${url.pathname} ${res.status}`);
    return res;
  },
});

console.log(`[rig] listening on ${ISSUER}; plan configurations written (not printed)`);
