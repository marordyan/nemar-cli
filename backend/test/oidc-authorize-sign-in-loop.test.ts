/**
 * The authorization endpoint and the ORCID sign-in, end to end (epic #2014 phase #2017 round 1; ADR
 * 0119 rules 3 and 10).
 *
 * When the check route asks for a fresh sign-in (`reauth`) or finds no session it accepts (`login`),
 * the page sends the person to sign in and back with the request the API returned. The loop closes
 * only if the sign-in mints a new `__Host-` session, so both cases are driven through the REAL Worker:
 * the check route, the ORCID callback with a real local server standing in for ORCID's token endpoint
 * (the only external boundary), and the check route again with the cookie the callback set. The
 * callback's own rules are `orcid-callback-sign-in.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
} from "../../shared/contract/oidc-authorize";
import { encodeState } from "../src/services/orcid-auth";
import { issueSession } from "../src/services/web-session";
import { OWNER_KEY, type OidcHarness, clientBody, startOidcHarness } from "./helpers/oidc-harness";

const APP = "https://app.nemar.org";
const CSRF = "csrf-callback-sign-in-test";
const REDIRECT = "https://client.example.org/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const PERSON_ID = "0000-0002-1825-0097";

/** The iD the stand-in's token endpoint returns for the next exchange. */
let returnedOrcid = PERSON_ID;
let orcid: Server;

beforeAll(() => {
  orcid = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/oauth/token") {
        return Response.json({ orcid: returnedOrcid, name: "Ada Lovelace", access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  orcid.stop(true);
});

let h: OidcHarness;

async function harness(flag: "1" | undefined): Promise<OidcHarness> {
  return startOidcHarness({
    HOST_PREFIXED_SESSION_COOKIE: flag,
    WEB_SESSION_COOKIE_DOMAIN: "",
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcid.port}`,
    ORCID_PUB_API_BASE: `http://localhost:${orcid.port}`,
    ENCRYPTION_KEY: "callback-test-encryption-key-0123456789",
  });
}

beforeEach(async () => {
  returnedOrcid = PERSON_ID;
  h = await harness("1");
});

let counter = 0;

/** An active person, holding `identity` as a proven ORCID iD when one is given. */
function seedPerson(identity: string | null = null): number {
  counter += 1;
  const name = `cbperson${counter}`;
  h.db
    .query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind,
                          orcid, orcid_verified)
       VALUES (?, ?, 'x', 'verified', 'member', 1, 'person', ?, ?)`,
    )
    .run(name, `${name}@example.org`, identity, identity ? 1 : 0);
  const id = h.db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(name)?.id as number;
  if (identity) {
    h.db
      .query(
        "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      )
      .run(id, identity);
  }
  return id;
}

async function session(userId: number, name = "__Host-nemar_session"): Promise<string> {
  const { cookieIdRaw } = await issueSession(h.env, userId, false, "test-agent", null, "orcid");
  return `${name}=${cookieIdRaw}`;
}

/** The ORCID callback, as the browser reaches it after ORCID, with the state cookie start set. */
function callback(mode: "login" | "link" | "relink", next: string, cookies: string[] = []) {
  const state = `__Host-nemar_oauth_state=${encodeState({ csrf: CSRF, mode, next })}`;
  return h.call("GET", `/auth/orcid/callback?state=${CSRF}&code=authcode`, {
    headers: { Cookie: [state, ...cookies].join("; ") },
  });
}

/** The `__Host-nemar_session` the response set, as a Cookie header value, or null. */
function mintedSession(headers: Headers): string | null {
  for (const raw of headers.getSetCookie()) {
    const [pair] = raw.split(";");
    if (pair.startsWith("__Host-nemar_session=") && pair.length > "__Host-nemar_session=".length) {
      return pair;
    }
  }
  return null;
}

async function registerClient(): Promise<string> {
  const res = await h.call("POST", "/admin/oidc/clients", {
    key: OWNER_KEY,
    body: clientBody({ redirect_uris: [REDIRECT], sign_in_rule: "person_proven_orcid" }),
  });
  expect(res.status).toBe(201);
  return (res.json as { client: { client_id: string } }).client.client_id;
}

function authorizationRequest(clientId: string, extra: Array<[string, string]> = []): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid",
    state: "client-state",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
  });
  for (const [k, v] of extra) params.append(k, v);
  return params.toString();
}

async function check(request: string, cookie?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Origin: APP,
    [OIDC_AUTHORIZE_CALLER_HEADER]: OIDC_AUTHORIZE_CALLER_VALUE,
  };
  if (cookie) headers.Cookie = cookie;
  const res = await h.call("POST", OIDC_AUTHORIZE_CHECK_PATH, { body: { request }, headers });
  expect(res.status).toBe(200);
  return res.json as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Rule 1: every completed sign-in mints a fresh session
// ---------------------------------------------------------------------------------------------

describe("a completed ORCID sign-in always mints a fresh session", () => {
  test("a person asked to sign in again (reauth) comes back with a session the check accepts", async () => {
    const clientId = await registerClient();
    const person = seedPerson(PERSON_ID);
    const old = await session(person);
    h.db.run(
      "UPDATE web_sessions SET created_at = datetime('now', '-10 minutes') WHERE user_id = ?",
      [person],
    );
    const asked = await check(authorizationRequest(clientId, [["prompt", "login"]]), old);
    expect(asked.kind).toBe("reauth");

    const back = `/oauth/authorize?${asked.request as string}`;
    const signedIn = await callback("login", back, [old]);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("Location")).toBe(`${APP}${back}`);
    const fresh = mintedSession(signedIn.headers);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(old);

    expect((await check(asked.request as string, fresh as string)).kind).toBe("consent");
  });

  test("a browser holding only a legacy-name session, sent to sign in, comes back with one the check accepts", async () => {
    const clientId = await registerClient();
    const person = seedPerson(PERSON_ID);
    const legacy = await session(person, "nemar_session");
    const asked = await check(authorizationRequest(clientId), legacy);
    expect(asked.kind).toBe("login");

    const back = `/oauth/authorize?${asked.request as string}`;
    const signedIn = await callback("login", back, [legacy]);
    const fresh = mintedSession(signedIn.headers);
    expect(fresh).not.toBeNull();
    expect((await check(asked.request as string, fresh as string)).kind).toBe("consent");
  });
});
