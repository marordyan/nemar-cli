/**
 * The re-pull GitHub stand-in answers the two reads of the release step the way real GitHub does
 * (ADR 0111, annotated 2026-11-08). The release read the tag at `commits/tags/<tag>` until the
 * first production re-pull, where GitHub answered 422; a stand-in that took that spelling let every
 * suite pass. These cases pin the refusal itself, so it cannot be loosened without a test failing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type RepullGitHub, startRepullGitHub } from "./helpers/repull-github-standin";

const ID = "on099999";
const A = "a".repeat(40);
const B = "b".repeat(40);
let gh: RepullGitHub;

function base(): string {
  return (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL as string;
}

beforeAll(() => {
  gh = startRepullGitHub();
});
afterAll(() => gh.stop());
beforeEach(() => {
  gh.reset();
  gh.tags[`${ID}@v2.0.0`] = A;
});

describe("the tag read", () => {
  test("the short tags/<tag> form is refused with 422 even though the tag exists", async () => {
    const res = await fetch(`${base()}/repos/nemarDatasets/${ID}/commits/tags/v2.0.0`, {
      headers: { Accept: "application/vnd.github.sha" },
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("No commit found for SHA: tags/v2.0.0");
  });

  test("the full refs/tags/<tag> form answers the commit as a bare id", async () => {
    const res = await fetch(`${base()}/repos/nemarDatasets/${ID}/commits/refs/tags/v2.0.0`, {
      headers: { Accept: "application/vnd.github.sha" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(A);
  });
});

describe("the compare read", () => {
  test("equal ids are identical, different ids ahead, and an entry overrides both", async () => {
    const read = async (x: string, y: string) =>
      (await (await fetch(`${base()}/repos/nemarDatasets/${ID}/compare/${x}...${y}`)).json()) as {
        status: string;
      };
    expect((await read(A, A)).status).toBe("identical");
    expect((await read(A, B)).status).toBe("ahead");
    gh.compares[`${ID}:${A}...${B}`] = "diverged";
    expect((await read(A, B)).status).toBe("diverged");
  });
});
