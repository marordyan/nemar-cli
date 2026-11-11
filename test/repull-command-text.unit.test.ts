/**
 * What `nemar admin repull` tells an administrator (ADR 0111; epic #1046 phase 6, #1912): the
 * confirmation names only what the run will do up to `--until`, and no help, output or pull request
 * body names a command that does not exist (`plan`, `execute`, `status`, `resume`, `merge`,
 * `abandon` and `auto` are; there is no `--abandon` flag; the canary is a script).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmQuestion, repullCommand } from "../src/commands/admin-repull";
import { releaseBody } from "../src/lib/repull/execute/pull-request";
import type { ExecuteSummary } from "../src/lib/repull/execute/run";
import { patchBody } from "../src/lib/repull/patch-turn";

const SUMMARY: ExecuteSummary = {
  datasetId: "on004362",
  fromTag: "1.0.0",
  toTag: "1.1.0",
  toVersion: "2.0.0",
  doiCount: 2,
  copyItems: 17,
  status: null,
  until: "pr_open",
};

describe("the confirmation depends on --until", () => {
  test("pr_open names the copy, the registration, the push and the pull request", () => {
    const q = confirmQuestion(SUMMARY);
    expect(q).toContain("copy up to 17 object(s) from upstream by version");
    expect(q).toContain("push release/v2.0.0 and open its pull request");
    expect(q).toContain("stop at pr_open");
    expect(q).toContain("never merges");
    expect(q).toContain("2 version DOI(s)");
  });

  test("an earlier stop does not promise a later write", () => {
    const planned = confirmQuestion({ ...SUMMARY, until: "planned" });
    expect(planned).toContain("record the re-pull and stop at planned");
    expect(planned).not.toMatch(/copy|push|pull request|register/);

    const prepared = confirmQuestion({ ...SUMMARY, until: "prepared" });
    expect(prepared).toContain("stop at prepared");
    expect(prepared).toContain("prepare it");
    expect(prepared).not.toMatch(/copy up to|push release|open its pull request|register the keys/);

    const copied = confirmQuestion({ ...SUMMARY, until: "copied" });
    expect(copied).toContain("copy up to 17 object(s)");
    expect(copied).not.toMatch(/push release|open its pull request|register the keys/);

    const registered = confirmQuestion({ ...SUMMARY, until: "registered" });
    expect(registered).toContain("register the keys");
    expect(registered).not.toMatch(/push release|open its pull request/);
  });

  test("a continued run says where it continues from", () => {
    expect(confirmQuestion({ ...SUMMARY, status: "copied" })).toContain("from copied");
  });

  test("a supersede says first what it ends", () => {
    const q = confirmQuestion({
      ...SUMMARY,
      supersedes: { id: 3, toTag: "1.0.5", status: "pr_open", prNumber: 12 },
    });
    expect(q).toStartWith(
      "First supersede re-pull #3 (to 1.0.5, pr_open): close its pull request #12",
    );
    expect(q).toContain("end it superseded");
  });
});

/**
 * The help a user sees for `nemar admin repull <name> --help-all`, read through the real entry
 * point in its own process. In-process it depends on the order the test files load in:
 * `src/lib/help.ts` patches `Command.prototype.addHelpText` at load time to replace every "after"
 * text with a one-line hint, so a file that loads it before `admin-repull.ts` is first imported
 * leaves this one reading the hint, and the deploy gate (one process, one file order) failed four of
 * these cases while the sharded pull request run passed them.
 */
function helpOf(name: string): string {
  const run = Bun.spawnSync(
    ["bun", "run", "src/index.ts", "admin", "repull", name, "--help-all", "--no-color"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, NEMAR_CONFIG_DIR: mkdtempSync(join(tmpdir(), "nemar-help-")) },
    },
  );
  expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
  return new TextDecoder().decode(run.stdout).replace(/\s+/g, " ");
}

describe("no text names a command that does not exist", () => {
  test("the commands that exist are plan, execute, status, resume, merge, abandon and auto", () => {
    expect(repullCommand.commands.map((c) => c.name()).sort()).toEqual([
      "abandon",
      "auto",
      "execute",
      "merge",
      "plan",
      "resume",
      "status",
    ]);
  });

  test("the execute help names resume, merge, abandon and --supersede", () => {
    const help = helpOf("execute");
    expect(help).toContain("nemar admin repull resume <id>");
    expect(help).toContain("nemar admin repull merge <id>");
    expect(help).toContain("nemar admin repull abandon <id>");
    expect(help).toContain("--supersede");
    expect(help).not.toMatch(/not built/);
    expect(help).toContain("a message that ends with the commit's two trailers");
  });

  test("the auto help says what it shows and that it changes nothing, and names no flag that does not exist", () => {
    const help = helpOf("auto");
    expect(help).toContain("It changes nothing.");
    expect(help).toContain("AUTO_REPULL_ENABLED and AUTO_REPULL_MERGE_ENABLED");
    expect(help).toContain("--json prints the same facts");
    expect(help).toContain("nemar admin repull status <id>");
    // The failure line is printed (the command's tests pin that), so "nothing" would be untrue.
    expect(help).toContain("Only the failure is");
    expect(help).toContain("printed then, never a table");
    expect(help).not.toContain("Nothing is printed");
    expect(help).not.toMatch(/--abandon/);
  });

  test("the abandon help says what each status ends as, and what it refuses", () => {
    const help = helpOf("abandon");
    expect(help).toContain("ends the record abandoned");
    expect(help).toContain("patch_declined");
    expect(help).toContain("refused (wait-for-release)");
    expect(help).toContain("a merged one refuses");
    expect(help).not.toMatch(/--abandon/);
  });

  test("the resume and merge help say what each writes, and that resume never merges", () => {
    const resume = helpOf("resume");
    expect(resume).toContain("It never merges");
    expect(resume).toContain("--acknowledge-identifier-screen");
    // It takes the record on after the merge too: the release, the lock and the end.
    expect(resume).toContain("the release and the lock");
    expect(resume).toContain("records the release");
    expect(resume).toContain("locks the objects the copy and the uploads wrote");
    expect(resume).toContain("and no other object under the dataset's prefix");
    // N.0.1, and the decision on conflicts that comes before it.
    expect(resume).toContain("--take-ours");
    expect(resume).toContain("--keep-upstream");
    expect(resume).toContain("N.0.1 is made from the reviewed plan");
    expect(resume).not.toMatch(/not built/);
    const merge = helpOf("merge");
    expect(merge).toContain("squash-merges at the screened commit");
    expect(merge).toContain("today's re-pull merge cap");
    // A claim GitHub did not merge under is kept, never released after five minutes.
    expect(merge).toContain("A merge GitHub did not make keeps its claim");
    expect(merge).not.toMatch(/released after five minutes|five minutes old/);
  });
});

describe("the pull request body", () => {
  const body = releaseBody({
    datasetId: "on004362",
    repullId: 4,
    ds: "ds004362",
    fromTag: "1.0.0",
    toTag: "1.1.0",
    toVersion: "2.0.0",
    patchVersion: "2.0.1",
    digest: `sha256:${"ab".repeat(32)}`,
    doiCount: 2,
    counts: { delta_paths: 3 },
  });

  test("names the commands that take it on and merge it, and none that does not exist", () => {
    expect(body).toContain("nemar admin repull resume on004362");
    expect(body).toContain("nemar admin repull merge on004362");
    expect(body).toContain("nemar admin pr-reviews");
    expect(body).not.toMatch(/repull abandon/);
  });

  test("states that the squash message must end with both trailers, then gives them", () => {
    expect(body).toContain("The squash commit message must end with both trailers");
    expect(body).toContain("as its last paragraph");
    expect(body).toContain("the merge path writes that message itself");
    expect(body).toContain("Upstream-Snapshot: ds004362@1.1.0");
    expect(body).toContain(`Repull-Plan: sha256:${"ab".repeat(32)}`);
    expect(body).toContain("Do not merge this from GitHub's page.");
  });

  test("names counts and the digest, never a path or a key", () => {
    expect(body).not.toMatch(/SHA256E|sub-\d|\.edf/);
  });
});

describe("N.0.1's pull request body", () => {
  const body = patchBody(
    {
      id: 4,
      dataset_id: "on004362",
      upstream_ds: "ds004362",
      from_tag: "1.0.0",
      to_tag: "1.1.0",
      to_version: "2.0.0",
      plan_digest: `sha256:${"ab".repeat(32)}`,
    } as Parameters<typeof patchBody>[0],
    {
      paths: [{ path: "sub-01/x.json", ours: "G:100644:x" }],
      keys: [],
      corrections: 1,
      resolutions: 0,
    },
    "2.0.1",
  );

  test("names the commands that take it on, the trailers, and counts only", () => {
    expect(body).toContain("nemar admin repull resume on004362");
    expect(body).toContain("nemar admin repull merge on004362");
    expect(body).toContain("Repull-Patch: corrections=1");
    expect(body).toContain("Nothing is scrubbed and nothing is copied");
    expect(body).not.toMatch(/sub-\d|\.json/);
  });
});
