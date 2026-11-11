/**
 * A pre-flight for the rig (epic #2014 phase #2020): before the suite starts, walk the sign-in the way
 * the suite's browser will, with plain HTTP and no library, and fail in seconds with a plain sentence
 * if the rig is not ready, instead of 30 minutes into a plan.
 *
 * It reads the credentials of a client the rig registered for it alone (never printing them),
 * follows the stand-in pages (authorize, sign in, consent), receives a code at the suite's callback
 * address WITHOUT following it, redeems it with PKCE and checks the identity token's shape.
 *
 *   RIG_OUT_DIR=<dir> RIG_HOST=rig.example.org RIG_PORT=9443 NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     bun run scripts/oidc-conformance/smoke.ts
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RIG_ACCOUNT_EMAIL } from "./plan-config";

const HOST = process.env.RIG_HOST ?? "rig.example.org";
const PORT = Number(process.env.RIG_PORT ?? 9443);
const ISSUER = `https://${HOST}:${PORT}`;
const OUT_DIR = process.env.RIG_OUT_DIR;
if (!OUT_DIR) throw new Error("RIG_OUT_DIR is required");

// The pre-flight has a client of its own, so the first plan client's consent and grant stay unspent.
const plan = {
  client: JSON.parse(readFileSync(join(OUT_DIR, "smoke-client.json"), "utf8")) as {
    client_id: string;
    client_secret: string;
  },
};
const REDIRECT = `${process.env.SUITE_ORIGIN ?? "https://localhost.emobix.co.uk:8443"}/test/a/${process.env.RIG_ALIAS ?? "nemar"}/callback`;

const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

function fail(what: string): never {
  console.error(`[smoke] FAILED: ${what}`);
  process.exit(1);
}

async function step(
  method: string,
  address: string,
  form?: Record<string, string>,
): Promise<{ status: number; location: string | null; body: string }> {
  const url = address.startsWith("/") ? `${ISSUER}${address}` : address;
  const res = await fetch(url, {
    method,
    redirect: "manual",
    headers: {
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = (pair as string).indexOf("=");
    const name = (pair as string).slice(0, at);
    const value = (pair as string).slice(at + 1);
    if (value === "" || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  return { status: res.status, location: res.headers.get("location"), body: await res.text() };
}

const hidden = (body: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1]?.replace(/&amp;/g, "&");

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const query = new URLSearchParams({
  response_type: "code",
  client_id: plan.client.client_id,
  redirect_uri: REDIRECT,
  scope: "openid profile email",
  state: "smoke-state",
  nonce: "smoke-nonce",
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

// 1. Not signed in: the authorization page sends the person to sign in.
let page = await step("GET", `/oauth/authorize?${query}`);
if (page.status !== 302 || !page.location?.startsWith("/login")) {
  fail(`the authorization page did not send an anonymous visitor to sign in (${page.status})`);
}
const loginAddress = page.location;
page = await step("GET", loginAddress);
if (page.status !== 200 || !page.body.includes('id="signin"'))
  fail("the sign-in page is not served");
const next = hidden(page.body, "next") ?? "";

// 2. Sign in through the real routes; the real session cookie is set.
page = await step("POST", "/login", { email: RIG_ACCOUNT_EMAIL, next });
if (page.status !== 302 || ![...jar.keys()].some((k) => k.startsWith("__Host-"))) {
  fail(`signing in did not set the session cookie (${page.status})`);
}

// 3. Back at the authorization page: consent is asked, then the code arrives at the callback.
page = await step("GET", page.location ?? "/oauth/authorize");
const request = hidden(page.body, "request");
const token = hidden(page.body, "consent_token");
if (page.status !== 200 || !request || !token) fail(`no consent page (${page.status})`);
page = await step("POST", "/oauth/consent", {
  request: request as string,
  consent_token: token as string,
  decision: "allow",
});
const back = new URL(page.location ?? "https://invalid.example/");
if (page.status !== 302 || !page.location?.startsWith(REDIRECT)) {
  fail(`consent did not redirect to the callback address (${page.status})`);
}
const code = back.searchParams.get("code");
if (
  !code ||
  back.searchParams.get("state") !== "smoke-state" ||
  back.searchParams.get("iss") !== ISSUER
) {
  fail("the callback carries no code, the wrong state or the wrong issuer");
}

// 4. Redeem with PKCE and client_secret_basic.
const form = (v: string) => encodeURIComponent(v).replace(/%20/g, "+");
const basic = Buffer.from(
  `${form(plan.client.client_id)}:${form(plan.client.client_secret)}`,
).toString("base64");
const tokenRes = await fetch(`${ISSUER}/oauth/token`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: code as string,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  }).toString(),
});
const tokens = (await tokenRes.json()) as { id_token?: string; access_token?: string };
if (tokenRes.status !== 200 || !tokens.id_token || !tokens.access_token) {
  fail(`the token endpoint answered ${tokenRes.status}`);
}
const claims = JSON.parse(
  Buffer.from((tokens.id_token as string).split(".")[1] as string, "base64url").toString(),
) as Record<string, unknown>;
if (
  claims.iss !== ISSUER ||
  claims.aud !== plan.client.client_id ||
  claims.nonce !== "smoke-nonce"
) {
  fail("the identity token's iss, aud or nonce is wrong");
}

console.log("[smoke] ok: sign-in, consent, code, token and identity token");
