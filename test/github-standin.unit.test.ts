/**
 * The CLI-side GitHub stand-in refuses the short `commits/tags/<tag>` spelling as real GitHub does
 * (422), and resolves a tag only through `commits/refs/tags/<tag>` (ADR 0111, annotated
 * 2026-11-08). Without this case the refusal is exercised only through a release suite failing.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type GitHubStandin, startGitHubStandin } from "./helpers/github-standin";

const SHA = "c".repeat(40);
let gh: GitHubStandin;

beforeAll(() => {
  gh = startGitHubStandin();
  gh.resolveTag = async (_dataset, tag) => (tag === "v2.0.0" ? SHA : null);
});
afterAll(() => gh.stop());

test("tags/<tag> is 422 even for a tag that resolves; refs/tags/<tag> answers the commit", async () => {
  const sha = { Accept: "application/vnd.github.sha" };
  const short = await fetch(`${gh.url}/repos/nemarDatasets/on099999/commits/tags/v2.0.0`, {
    headers: sha,
  });
  expect(short.status).toBe(422);
  expect(await short.text()).toContain("No commit found for SHA: tags/v2.0.0");
  const full = await fetch(`${gh.url}/repos/nemarDatasets/on099999/commits/refs/tags/v2.0.0`, {
    headers: sha,
  });
  expect(full.status).toBe(200);
  expect(await full.text()).toBe(SHA);
});
