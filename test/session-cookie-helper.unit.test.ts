/**
 * `sessionCookiePair` (test/helpers/session-cookie.ts), the reader the live sign-in tests use.
 * Pure, no network: it is pinned here because the live suites that depend on it are skipped
 * without a deployed backend, so a mistake in it would otherwise be found only there.
 */

import { describe, expect, test } from "bun:test";
import { sessionCookiePair } from "./helpers/session-cookie";

const V = "abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_";

describe("sessionCookiePair", () => {
  test("reads the legacy name", () => {
    expect(sessionCookiePair(`nemar_session=${V}; HttpOnly; Secure; SameSite=Lax; Path=/`)).toBe(
      `nemar_session=${V}`,
    );
  });

  test("reads the new name and keeps it, so the next request sends it under that name", () => {
    expect(
      sessionCookiePair(`__Host-nemar_session=${V}; HttpOnly; Secure; SameSite=Lax; Path=/`),
    ).toBe(`__Host-nemar_session=${V}`);
  });

  test("with the new name issued and the legacy name cleared, it takes the issued one", () => {
    // What a flag-on sign-in sends, joined the way `Headers.get` joins them.
    const joined = [
      `__Host-nemar_session=${V}; HttpOnly; Secure; SameSite=Lax; Path=/`,
      "nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=app.nemar.org; Max-Age=0",
      "nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    ].join(", ");
    expect(sessionCookiePair(joined)).toBe(`__Host-nemar_session=${V}`);
  });

  test("a clear alone is not a session", () => {
    expect(
      sessionCookiePair("nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"),
    ).toBeNull();
    expect(
      sessionCookiePair("__Host-nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"),
    ).toBeNull();
  });

  test("does not match a cookie whose name only ends the same way", () => {
    expect(sessionCookiePair(`x_nemar_session=${V}; Path=/`)).toBeNull();
    expect(sessionCookiePair(`other__Host-nemar_session=${V}; Path=/`)).toBeNull();
  });

  test("is null for no header and for unrelated cookies", () => {
    expect(sessionCookiePair(null)).toBeNull();
    expect(sessionCookiePair(undefined)).toBeNull();
    expect(sessionCookiePair("")).toBeNull();
    expect(sessionCookiePair("analytics=reject; Path=/")).toBeNull();
  });
});
