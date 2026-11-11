/**
 * Read the session cookie out of a `Set-Cookie` header, under whichever name the Worker issued it.
 *
 * The API issues `__Host-nemar_session` once `HOST_PREFIXED_SESSION_COOKIE` is on and the legacy
 * `nemar_session` before that, and a response that issues the first also CLEARS the second
 * (`nemar_session=; Max-Age=0`). A regex for the bare `nemar_session=` matches inside
 * `__Host-nemar_session=` by accident and the clear never, so a live test written that way reads
 * the right value only by luck. This matches each name as a whole cookie name, skips a clear (an
 * empty value), and hands back the pair to send, `name=value`, so the next request carries the
 * cookie under the name it was issued with.
 *
 * `Headers.get("set-cookie")` joins several cookies with `, `, so a name is taken to start at the
 * beginning of the string or after whitespace or a comma.
 */
export function sessionCookiePair(setCookie: string | null | undefined): string | null {
  if (!setCookie) return null;
  for (const m of setCookie.matchAll(/(?:^|[\s,])((?:__Host-)?nemar_session)=([^;,\s]+)/g)) {
    return `${m[1]}=${m[2]}`;
  }
  return null;
}
