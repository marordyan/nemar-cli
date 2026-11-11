/**
 * The authorization code flow as the token-phase suites need it (epic #2014 phase #2018), on top of
 * `oidc-harness.ts`: an account, a live app session under the `__Host-` cookie name, a client
 * registered through the owner's route, signing keys made by the owner's rotation, a code minted by
 * the REAL authorization routes (check, and consent when the client is asked), and requests to the
 * token endpoint with HTTP Basic client authentication.
 *
 * Nothing here stands in for NEMAR logic: every code comes from `POST /auth/oidc/authorize` (and
 * `/auth/oidc/consent`), every client from `POST /admin/oidc/clients`, every key from
 * `POST /admin/oidc/keys/rotate`. The PKCE pairs are computed with real SHA-256.
 */

import { expect } from "bun:test";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
  OIDC_AUTHORIZE_CONSENT_PATH,
} from "../../../shared/contract/oidc-authorize";
import { toBase64Url } from "../../src/services/oidc-encoding";
import { issueSession } from "../../src/services/web-session";
import { type Answer, OWNER_KEY, type OidcHarness, clientBody } from "./oidc-harness";

export const APP = "https://app.nemar.org";
/** A redirect address on a first-party origin (`https`, a `nemar.org` subdomain, not a partner). */
export const FIRST_PARTY_REDIRECT = "https://tools.nemar.org/oidc/callback";
/** A redirect address of a third-party client. */
export const THIRD_PARTY_REDIRECT = "https://client.example.org/callback";

/** The RFC 7636 appendix B pair: a 43-character verifier and its S256 challenge. */
export const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** The S256 challenge of a verifier: base64url(SHA-256(ASCII verifier)), unpadded. */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

let accountCounter = 0;

/** An account as the provider sees one: status, kind, ORCID iD and whether a sign-in proved it. */
export function seedAccount(
  h: OidcHarness,
  opts: {
    status?: string;
    kind?: "person" | "service" | "test";
    orcid?: string | null;
    orcidVerified?: boolean;
    /** An `oauth_identities` ORCID row for this iD; none when null or absent. */
    identity?: string | null;
    givenName?: string | null;
    familyName?: string | null;
    emailVerified?: boolean;
    serviceAccess?: boolean;
  } = {},
): number {
  accountCounter += 1;
  const name = `oidctoken${accountCounter}`;
  h.db
    .query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind,
                          orcid, orcid_verified, given_name, family_name, service_access)
       VALUES (?, ?, 'x', ?, 'member', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      `${name}@example.org`,
      opts.status ?? "verified",
      opts.emailVerified === false ? 0 : 1,
      opts.kind ?? "person",
      opts.orcid ?? null,
      opts.orcidVerified ? 1 : 0,
      opts.givenName === undefined ? "Ada" : opts.givenName,
      opts.familyName === undefined ? "Lovelace" : opts.familyName,
      opts.serviceAccess ? 1 : 0,
    );
  const id = h.db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(name)?.id as number;
  if (opts.identity) {
    h.db
      .query(
        "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      )
      .run(id, opts.identity);
  }
  return id;
}

/** A live app session for the account, as the `Cookie` header a browser would send. */
export async function sessionCookie(h: OidcHarness, userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(h.env, userId, false, "test-agent", null, "orcid");
  return `__Host-nemar_session=${cookieIdRaw}`;
}

/** A registered client: its public id and its secret, as the owner's route answered them. */
export interface RegisteredClient {
  clientId: string;
  secret: string;
  redirect: string;
}

/** Register a client through the owner's route. First-party by default, so no consent screen. */
export async function registerClient(
  h: OidcHarness,
  over: Record<string, unknown> = {},
): Promise<RegisteredClient> {
  const firstParty = over.first_party !== false;
  const redirect = firstParty ? FIRST_PARTY_REDIRECT : THIRD_PARTY_REDIRECT;
  const body = clientBody({
    redirect_uris: [redirect],
    allowed_scopes: ["openid", "profile", "email", "orcid", "nemar.account", "offline_access"],
    allowed_grants: ["authorization_code", "refresh_token"],
    first_party: firstParty,
    ...over,
  });
  const res = await h.call("POST", "/admin/oidc/clients", { key: OWNER_KEY, body });
  expect(res.status).toBe(201);
  const json = res.json as { client: { client_id: string }; client_secret: string };
  return {
    clientId: json.client.client_id,
    secret: json.client_secret,
    redirect: (body.redirect_uris as string[])[0] as string,
  };
}

/** Make the first signing keys, so an identity token can be signed. */
export async function rotateKeys(h: OidcHarness): Promise<void> {
  const res = await h.call("POST", "/admin/oidc/keys/rotate", { key: OWNER_KEY, body: {} });
  expect(res.status).toBe(200);
}

/** The headers the website's authorization page sends: its pinned Origin and the caller marker. */
function pageHeaders(cookie: string): Record<string, string> {
  return {
    Cookie: cookie,
    Origin: APP,
    [OIDC_AUTHORIZE_CALLER_HEADER]: OIDC_AUTHORIZE_CALLER_VALUE,
  };
}

/**
 * A code from the real authorization routes: the check, and the consent screen's "allow" when the
 * client is asked. Fails the test on any other answer.
 */
export async function authorize(
  h: OidcHarness,
  client: RegisteredClient,
  cookie: string,
  opts: { scope?: string; nonce?: string | null; challenge?: string; state?: string } = {},
): Promise<string> {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirect,
    response_type: "code",
    scope: opts.scope ?? "openid profile",
    state: opts.state ?? "s-1",
    code_challenge: opts.challenge ?? RFC_CHALLENGE,
    code_challenge_method: "S256",
  });
  if (opts.nonce !== null) params.set("nonce", opts.nonce ?? "n-0S6_WzA2Mj");
  const request = params.toString();
  const check = await h.call("POST", OIDC_AUTHORIZE_CHECK_PATH, {
    body: { request },
    headers: pageHeaders(cookie),
  });
  expect(check.status).toBe(200);
  let answer = check.json as Record<string, unknown>;
  if (answer.kind === "consent") {
    const consent = await h.call("POST", OIDC_AUTHORIZE_CONSENT_PATH, {
      body: { request, consent_token: answer.consent_token, decision: "allow" },
      headers: pageHeaders(cookie),
    });
    expect(consent.status).toBe(200);
    answer = consent.json as Record<string, unknown>;
  }
  expect(answer.kind).toBe("redirect");
  const location = new URL(answer.location as string);
  const code = location.searchParams.get("code");
  expect(code).not.toBeNull();
  return code as string;
}

/** `Authorization: Basic` for a client id and secret, each form-encoded first (RFC 6749 2.3.1). */
export function basic(clientId: string, secret: string): string {
  const form = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
  return `Basic ${btoa(`${form(clientId)}:${form(secret)}`)}`;
}

/** A form POST to one of the `/oauth` endpoints, as a client's server sends it. */
export async function formPost(
  h: OidcHarness,
  path: string,
  form: Record<string, string> | string,
  opts: { authorization?: string | null; env?: Record<string, unknown>; bypass?: boolean } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (opts.authorization) headers.Authorization = opts.authorization;
  const rawBody = typeof form === "string" ? form : new URLSearchParams(form).toString();
  return h.call("POST", path, {
    rawBody,
    headers,
    env: opts.env as never,
    bypass: opts.bypass,
  });
}

/** The token endpoint, authenticated as `client`. */
export async function tokenRequest(
  h: OidcHarness,
  client: RegisteredClient,
  form: Record<string, string>,
  opts: { env?: Record<string, unknown> } = {},
): Promise<Answer> {
  return formPost(h, "/oauth/token", form, {
    authorization: basic(client.clientId, client.secret),
    env: opts.env,
  });
}

/** Redeem a code with the RFC verifier at the client's redirect address. */
export async function redeem(
  h: OidcHarness,
  client: RegisteredClient,
  code: string,
  over: Record<string, string> = {},
  opts: { env?: Record<string, unknown> } = {},
): Promise<Answer> {
  return tokenRequest(
    h,
    client,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirect,
      code_verifier: RFC_VERIFIER,
      ...over,
    },
    opts,
  );
}

/** Decode a compact JSON Web Token's header and claims, unverified (the suites verify separately). */
export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
} {
  const [h64, c64] = token.split(".") as [string, string];
  const decode = (s: string) =>
    JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)),
          (ch) => ch.charCodeAt(0),
        ),
      ),
    ) as Record<string, unknown>;
  return { header: decode(h64), claims: decode(c64) };
}
