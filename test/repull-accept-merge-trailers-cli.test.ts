/**
 * A re-pull merged outside NEMAR's gate, with GitHub's own merge button, and its acceptance
 * (`nemar admin repull resume <id> --accept-merge-trailers "<reason>"`; epic #1046; ADR 0111, the
 * amendment of 2026-10-29; issue #1996), driven through the real entry point against
 * `repull-pr-world.ts` with a plan that has no corrections, so the record can reach `complete`.
 *
 * Everything NEMAR's is real: the CLI, the Worker's routes over bun:sqlite with every migration,
 * the real `git` and `git-annex` repositories served as bare origins, and the privacy ledger's own
 * fresh-clone rule (`ledgerChecks` in `scripts/scrub/git/git-lib.ts`) run on a fresh clone of the
 * origin the re-pull and the Worker wrote. GitHub is the suites' stand-in: its squash merge
 * commits onto the origin's `main` with the message it is sent, and its Git Data and Contents
 * answers are read from, and written to, the same origin. No mocks.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - a merge without the trailers is refused at the release without the flag, and the dataset
 *    then fails the fresh-clone proof (`ledger-commit-not-alone`): the premise;
 *  - with a reason, the merge is verified, accepted, the ledger line naming it is written to
 *    `main` in a commit of its own, the release goes on to `complete`, and the proof passes;
 *  - a line that could not be written leaves the acceptance recorded, the Worker refuses the
 *    release until the line is on `main`, and the next run writes it once;
 *  - a parent, a head or a tree that is not the record's, a record the automatic path opened or
 *    another administrator's, and a merge commit that is not the record's are refused, by the CLI
 *    and by the Worker on its own, and nothing is written;
 *  - a head or a parent enrichment moved is accepted;
 *  - the output says what this run verified and every field of what the Worker read (its head,
 *    parent and tree, whether enrichment moved them, and what the merge did to the ledger, in each
 *    of its three words), and an acceptance's refusals exit 1 or 3 by one rule, an API answer that
 *    was lost or rate-limited included.
 *
 * What only production can check: that GitHub's Contents API takes the leased write of the ledger
 * on `main` and answers a stale `sha` with 409, and that GitHub's comparison names the files as
 * the stand-in does.
 *
 * CI TIER: unit-pure. Hermetic: every server the suite starts or reaches listens on loopback.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { which } from "bun";
import type { LedgerEntry } from "../scripts/scrub/contract";
import { isAnnexRef, ledgerChecks } from "../scripts/scrub/git/git-lib";
import { validateLedgerEntry } from "../scripts/scrub/ledger";
import { mergeAcceptanceLine } from "../shared/repull-merge-acceptance";
import { runCommand } from "../src/lib/git-annex/run-command";
import { WORKER_TOKEN } from "./helpers/github-standin";
import { gitIn } from "./helpers/repull-fixture";
import {
  ADMIN_ID,
  ADMIN_KEY,
  type RepullWorld,
  type WorldPoint,
  enrichedMetadata,
  prKey,
  startRepullWorld,
} from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const LEDGER = ".nemar/corrections.jsonl";
const REASON =
  "Merged with GitHub's button by mistake; the merge was read and is the re-pull's own";

let w: RepullWorld;
/** The record at `gates_clear`, its screen passed: where a merge on GitHub's page is made from. */
let gated: WorldPoint;
/** GitHub's merge button pressed at `gated`: the record still at `gates_clear`. */
let mergedOnGitHub: WorldPoint;

beforeAll(async () => {
  if (!awsInstalled) return;
  w = await startRepullWorld({ fixture: { noContributorEdits: true, identifierJsonB: true } });
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  const ready = await resume();
  expect(ready.exitCode, ready.all).toBe(0);
  expect(w.row().status).toBe("gates_clear");
  gated = await w.save();
  await w.mergeOnGitHub();
  mergedOnGitHub = await w.save();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (awsInstalled) await w.restore();
});

const resume = (extra: string[] = []) =>
  w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra]);
const accepting = () => resume(["--accept-merge-trailers", REASON]);
const mainHead = async () =>
  (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
const acceptances = () =>
  w.db().query("SELECT * FROM upstream_repull_merge_acceptances").all() as Array<
    Record<string, unknown>
  >;
/** Tag v2.0.0 at main and write its version row, as the dataset workflow and the DOI leave them. */
async function tagged(): Promise<string> {
  const tag = await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
  return tag;
}

/** The Worker's route, called as an administrator's CLI would, with no check made before it. */
async function acceptRoute(
  body: Record<string, unknown>,
): Promise<{ status: number; code: string }> {
  const res = await fetch(`${w.apiUrl}/admin/repulls/${w.row().id}/merge-trailers/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = (await res.json()) as { code?: string };
  return { status: res.status, code: answer.code ?? "" };
}

/**
 * The privacy ledger's fresh-clone rule (ADR 0085) on a new clone of the origin: the refs
 * `git-scrub verify --fresh-clone` scans (every ref but git-annex's), as it reads them.
 */
async function proof() {
  const dir = mkdtempSync(join(tmpdir(), "nemar-accept-proof-"));
  try {
    await gitIn(dir, ["clone", "-q", "--no-local", w.fx.originRepo, "clone"]);
    const repo = join(dir, "clone");
    const refs = (await gitIn(repo, ["for-each-ref", "--format=%(refname)"]))
      .split("\n")
      .filter((r) => r !== "" && !isAnnexRef(r));
    return await ledgerChecks(repo, refs, w.fx.datasetId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The requests the CLI sent to the acceptance route: the first asks whether one is recorded (no
 * reason), and a second carries the reason. One means the CLI refused on its own reading first.
 */
const acceptRequests = () => w.apiWrites.filter((p) => p.endsWith("/merge-trailers/accept"));

const GIT_ID = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** One commit of several files onto a ref of the bare origin (null removes a file). */
async function commitFiles(
  ref: string,
  files: Record<string, string | null>,
  message: string,
): Promise<string> {
  const repo = w.fx.originRepo;
  const before = (await gitIn(repo, ["rev-parse", ref])).trim();
  const dir = mkdtempSync(join(tmpdir(), "nemar-accept-index-"));
  const env = { ...GIT_ID, GIT_INDEX_FILE: join(dir, "index") };
  const run = async (args: string[], stdin?: string) => {
    const r = await runCommand(["git", ...args], {
      cwd: repo,
      env,
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    await run(["read-tree", ref]);
    for (const [path, content] of Object.entries(files)) {
      // A bare repository has no work tree, so a removal goes through --index-info (mode 0).
      if (content === null) {
        await run(["update-index", "--index-info"], `0 ${"0".repeat(40)}\t${path}\n`);
        continue;
      }
      const blob = await run(["hash-object", "-w", "--stdin"], content);
      await run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
    }
    const tree = (await runCommand(["git", "write-tree"], { cwd: repo, env })).stdout.trim();
    const commit = (
      await runCommand(["git", "commit-tree", tree, "-p", before, "-m", message], {
        cwd: repo,
        env,
      })
    ).stdout.trim();
    await gitIn(repo, ["update-ref", ref, commit, before]);
    return commit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Nothing written: no acceptance, no ledger write, `main` where it was. */
async function nothingWritten(main: string): Promise<void> {
  expect(acceptances()).toEqual([]);
  expect(w.ledgerWrites()).toBe(0);
  expect(await mainHead()).toBe(main);
  expect(w.row().status).toBe("merged");
}

describe.skipIf(!awsInstalled)("a merge made outside the gate", () => {
  test("without --accept-merge-trailers the release refuses, and the dataset fails the proof", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("merge-trailers");
    expect(run.all).toContain("--accept-merge-trailers");
    expect(w.row()).toMatchObject({ status: "merged", merge_sha: merge, tag_sha: null });
    expect(w.row().last_error).toStartWith("[release:merge-trailers]");
    await nothingWritten(merge);
    // The premise: the squash commit appends the delta scrub's line beside the re-pull's files and
    // carries no trailers, so the fresh-clone proof fails it for good.
    expect(
      (await gitIn(w.fx.originRepo, ["diff", "--name-only", `${merge}^`, merge])).split("\n"),
    ).toContain(LEDGER);
    const before = await proof();
    expect(before).toMatchObject({ notAlone: 1, unmatched: 0, invalid: 0, accepted: 0 });
  });

  test("with a reason it is verified, accepted, attested on main, and the release completes", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const ledgerAtMerge = await gitIn(w.fx.originRepo, ["show", `${merge}:${LEDGER}`]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    // What was verified, and what was accepted, in plain words.
    expect(run.all).toContain("does not end with the re-pull commit's two trailers");
    expect(run.all).toContain("Verified by this run");
    // Every field of the Worker's evidence, in the line that prints it.
    const row0 = w.row();
    const tree = (await gitIn(w.fx.originRepo, ["rev-parse", `${merge}^{tree}`])).trim();
    expect(run.all).toContain(
      `The Worker read on GitHub with its own credential: pull request #${row0.pr_number} merged at ${(row0.head_sha as string).slice(0, 12)}, parent ${row0.base_sha.slice(0, 12)}, tree ${tree.slice(0, 12)}, the re-pull's outside .nemar/ and .github/; the merge appends the delta scrub's repull-scrubbed line to the privacy ledger and edits no line before it; and the re-pull is yours.`,
    );
    // What this run verified is said before the Worker is asked.
    expect(run.all.indexOf("Verified by this run")).toBeLessThan(
      run.all.indexOf("The Worker read on GitHub"),
    );
    expect(run.all).toContain(`is GitHub's squash merge of pull request #${w.row().pr_number}`);
    expect(run.all).toContain("the recorded head");
    expect(run.all).toContain("its one parent");
    expect(run.all).toContain("is the record's base");
    expect(run.all).toContain("its tree is the re-pull's commit");
    expect(run.all).toContain("repull-scrubbed");
    expect(run.all).toContain(
      `Accepted on your reason, and recorded on re-pull #${w.row().id}: ${REASON}`,
    );
    expect(run.all).toContain(`The line that names ${merge.slice(0, 12)} is on main`);
    expect(run.all).toContain("is complete");

    // The record went on as for a gated merge: released at the tag, lineage, the lock, complete.
    const row = w.row();
    expect(row).toMatchObject({ status: "complete", tag_sha: merge, last_error: null });
    expect(JSON.parse(row.counts).locked).toBeGreaterThan(0);
    expect(
      w
        .db()
        .query("SELECT source_version_basis FROM dataset_versions WHERE version = '2.0.0'")
        .get(),
    ).toEqual({ source_version_basis: "lineage" });

    // The acceptance, with the reason, recorded once; the reason is in the audit row too.
    const [accepted, ...more] = acceptances();
    expect(more).toEqual([]);
    expect(accepted).toMatchObject({
      repull_id: row.id,
      pr: "n0",
      merge_sha: merge,
      reason: REASON,
      accepted_by: ADMIN_ID,
      attestation_needed: 1,
    });
    expect(accepted?.attested_at).not.toBeNull();
    const audit = w
      .db()
      .query("SELECT details FROM audit_log WHERE action = 'repull_merge_trailers_accepted'")
      .all() as Array<{ details: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details as string)).toMatchObject({
      merge_sha: merge,
      reason: REASON,
    });

    // One commit of NEMAR's on main, after the merge, touching the ledger only, appending one line.
    const main = await mainHead();
    expect(accepted?.attestation_sha).toBe(main);
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${main}^`])).trim()).toBe(merge);
    expect((await gitIn(w.fx.originRepo, ["diff", "--name-only", merge, main])).trim()).toBe(
      LEDGER,
    );
    const ledgerOnMain = await gitIn(w.fx.originRepo, ["show", `${main}:${LEDGER}`]);
    expect(ledgerOnMain.startsWith(ledgerAtMerge)).toBe(true);
    const added = ledgerOnMain.slice(ledgerAtMerge.length).split("\n").filter(Boolean);
    expect(added).toHaveLength(1);
    const entry = validateLedgerEntry(JSON.parse(added[0] as string) as LedgerEntry);
    expect(entry).toMatchObject({
      dataset: w.fx.datasetId,
      action: "repull-merge-accepted",
      versions: ["v2.0.0"],
      verification: "squash-merge-verified",
      actor: "nemar-repull",
      commit: merge,
      plan: row.plan_digest,
    });
    // The reason never reaches the public ledger.
    expect(ledgerOnMain).not.toContain("GitHub's button");
    expect(w.ledgerWrites()).toBe(1);

    // And the fresh-clone proof now passes, vouching for exactly that merge.
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, invalid: 0, accepted: 1 });
  });

  test("a line that could not be written: the acceptance stands, the release waits, the next run writes it once", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    const tag = await tagged();
    w.setLedgerWriteFault(() => Response.json({ message: "Server Error" }, { status: 502 }));
    const first = await accepting();
    expect(first.exitCode, first.all).toBe(3);
    expect(first.all).toContain("attestation-unwritten");
    expect(w.row().status).toBe("merged");
    expect(acceptances()).toHaveLength(1);
    expect(acceptances()[0]).toMatchObject({ attested_at: null, attestation_sha: null });
    expect(await mainHead()).toBe(merge);
    // The Worker refuses the release until the line is on main, whatever a caller says.
    const released = await fetch(`${w.apiUrl}/admin/repulls/${w.row().id}/released`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pr: "n0", tag_sha: tag, tree_verified: true }),
    });
    expect(released.status).toBe(409);
    expect(((await released.json()) as { code: string }).code).toBe("acceptance-unattested");

    // Recorded once: the same request for another merge commit is refused.
    const parent = (await gitIn(w.fx.originRepo, ["rev-parse", `${merge}^`])).trim();
    expect(await acceptRoute({ pr: "n0", merge_sha: parent, reason: REASON })).toEqual({
      status: 409,
      code: "merge-mismatch",
    });
    // The next run needs no reason: the acceptance is recorded, and its line is written once.
    w.setLedgerWriteFault(null);
    const second = await resume();
    expect(second.exitCode, second.all).toBe(0);
    expect(second.all).toContain(`it was accepted earlier, by administrator #${ADMIN_ID}`);
    expect(second.all).toContain(`on the reason: ${REASON}`);
    expect(w.row().status).toBe("complete");
    expect(acceptances()).toHaveLength(1);
    expect(w.ledgerWrites()).toBe(2);
    const ledger = await gitIn(w.fx.originRepo, ["show", `refs/heads/main:${LEDGER}`]);
    expect(ledger.split("\n").filter((l) => l.includes("repull-merge-accepted"))).toHaveLength(1);
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, accepted: 1 });
    // A third run finds nothing open, and writes nothing.
    expect((await resume()).exitCode).toBe(1);
    expect(w.ledgerWrites()).toBe(2);
  });

  test("a parent that is not the base moved by enrichment is refused by the CLI and by the Worker", async () => {
    await w.restore(gated);
    await w.commitOnto("refs/heads/main", "README.md", "Changed by hand on main.\n");
    await w.mergeOnGitHub();
    const merge = await mainHead();
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-parent-foreign");
    expect(run.all).toContain("Nothing was accepted or written");
    expect(acceptRequests()).toHaveLength(1);
    await nothingWritten(merge);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-parent-foreign",
    });
    await nothingWritten(merge);
  });

  test("a parent that enrichment moved is accepted, and said so", async () => {
    await w.restore(gated);
    await w.commitOnto(
      "refs/heads/main",
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, "refs/heads/main"),
      "Update NEMAR metadata",
    );
    await w.mergeOnGitHub();
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("moved by enrichment only");
    const parent = (await gitIn(w.fx.originRepo, ["rev-parse", `${w.row().merge_sha}^`])).trim();
    expect(run.all).toContain(`parent ${parent.slice(0, 12)} (moved by enrichment)`);
    expect(w.row().status).toBe("complete");
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, accepted: 1 });
  });

  test("a head enrichment moved is accepted; a head moved by any other commit is refused", async () => {
    await w.restore(gated);
    const branch = `refs/heads/${w.row().branch}`;
    await w.commitOnto(
      branch,
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, branch),
      "Update NEMAR metadata",
    );
    await w.mergeOnGitHub();
    await tagged();
    const ok = await accepting();
    expect(ok.exitCode, ok.all).toBe(0);
    expect(ok.all).toContain("which enrichment moved the recorded head");
    const moved = (await gitIn(w.fx.originRepo, ["rev-parse", branch])).trim();
    expect(ok.all).toContain(`merged at ${moved.slice(0, 12)} (moved by enrichment)`);
    expect(w.row().status).toBe("complete");

    await w.restore(gated);
    await w.commitOnto(branch, "README.md", "Changed by hand on the release branch.\n");
    await w.mergeOnGitHub();
    const merge = await mainHead();
    await tagged();
    const foreign = await accepting();
    expect(foreign.exitCode, foreign.all).toBe(1);
    expect(foreign.all).toContain("merge-head-foreign");
    expect(acceptRequests()).toHaveLength(1);
    await nothingWritten(merge);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-head-foreign",
    });
    await nothingWritten(merge);
  });

  test("a tree that is not the re-pull's commit is refused by the CLI and by the Worker", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3); // records the merge; refuses merge-trailers
    // The record's synthesized commit, as if it were another: the base's.
    const base = w.row().base_sha;
    const baseTree = (await gitIn(w.fx.originRepo, ["rev-parse", `${base}^{tree}`])).trim();
    w.db().run("UPDATE upstream_repulls SET synth_sha = ?, synth_tree = ?", [base, baseTree]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-tree-mismatch");
    expect(acceptRequests()).toHaveLength(2); // the resume that recorded the merge, and this one
    await nothingWritten(merge);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-tree-mismatch",
    });
    await nothingWritten(merge);
  });

  test("a record the automatic path opened, or another administrator's, is not accepted", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const automatic = await accepting();
    expect(automatic.exitCode, automatic.all).toBe(1);
    expect(automatic.all).toContain("accept-automatic");
    // Refused by this run before any reason was sent: the earlier resume's request and this one's.
    expect(acceptRequests()).toHaveLength(2);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "accept-automatic",
    });
    await nothingWritten(merge);

    w.db().run("UPDATE upstream_repulls SET origin = 'administrator', actor_user_id = 1");
    const before = acceptRequests().length;
    const theirs = await accepting();
    expect(theirs.exitCode, theirs.all).toBe(1);
    expect(theirs.all).toContain("accept-not-yours");
    // The CLI cannot tell whose the record is: the Worker refused the request with the reason.
    expect(acceptRequests().length - before).toBe(2);
    await nothingWritten(merge);
  });

  test("the release does not advise a flag the Worker would refuse on a record the automatic path opened", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("merge-trailers");
    expect(run.all).toContain("no command moves this record on");
    expect(run.all).not.toContain("--accept-merge-trailers");
    await nothingWritten(merge);
    // An administrator's record is still told the way.
    w.db().run("UPDATE upstream_repulls SET origin = 'administrator'");
    const told = await resume();
    expect(told.all).toContain('--accept-merge-trailers "<reason>"');
    expect(told.all).toContain("only for the administrator who opened the re-pull");
  });

  test("a Worker with no acceptance route is named as such, and nothing is written", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    w.setApiOverride((req) =>
      req.method === "POST" && new URL(req.url).pathname.endsWith("/merge-trailers/accept")
        ? Response.json({ error: "Not found" }, { status: 404 })
        : null,
    );
    const run = await accepting();
    w.setApiOverride(null);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("this Worker has no acceptance route");
    expect(run.all).not.toContain("Invalid response from server");
    await nothingWritten(merge);
  });

  test("the Worker takes only the record's merge commit, and a reason only for a first acceptance", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    const other = (await gitIn(w.fx.originRepo, ["rev-parse", `${merge}^`])).trim();
    expect(await acceptRoute({ pr: "n0", merge_sha: other, reason: REASON })).toEqual({
      status: 409,
      code: "merge-mismatch",
    });
    expect(await acceptRoute({ pr: "n0", merge_sha: merge })).toEqual({
      status: 409,
      code: "merge-trailers-not-accepted",
    });
    expect((await acceptRoute({ pr: "n0", merge_sha: merge, reason: "too short" })).status).toBe(
      400,
    );
    await nothingWritten(merge);
  });

  test("a line another writer appended while NEMAR wrote is kept: the write is leased on the ledger it read", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const ledger = await gitIn(w.fx.originRepo, ["show", `${merge}:${LEDGER}`]);
    const other = `${JSON.stringify({
      version: 1,
      at: "2026-10-29T11:00:00.000Z",
      dataset: w.fx.datasetId,
      action: "published-again",
      versions: ["v2.0.0"],
      counts: {},
      scanner: "identifier-scan@abcdef1",
      verification: "none",
      actor: "someone",
    })}\n`;
    // The first write finds that another writer appended a line to the ledger first.
    let once = true;
    w.setLedgerWriteFault(async () => {
      if (!once) return null;
      once = false;
      await w.commitOnto("refs/heads/main", LEDGER, `${ledger}${other}`, "Record the publication");
      return Response.json({ message: `${LEDGER} does not match` }, { status: 409 });
    });
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.ledgerWrites()).toBe(2);
    const onMain = await gitIn(w.fx.originRepo, ["show", `refs/heads/main:${LEDGER}`]);
    expect(onMain.startsWith(`${ledger}${other}`)).toBe(true);
    expect(onMain.slice(ledger.length + other.length)).toContain(
      '"action":"repull-merge-accepted"',
    );
    expect(w.row().status).toBe("complete");
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, invalid: 0, accepted: 1 });
  });

  test("a line the Worker was told is written and main does not show stops the release: attestation-unseen", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    // A GitHub that answers the write as made, and made nothing.
    w.setLedgerWriteFault(() =>
      Response.json(
        { content: { sha: "e".repeat(40) }, commit: { sha: "d".repeat(40) } },
        { status: 201 },
      ),
    );
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("attestation-unseen");
    expect(w.row()).toMatchObject({ status: "merged", tag_sha: null });
    expect(await mainHead()).toBe(merge);
    // The Worker refuses the release while the line is not on main, whatever its own flag says.
    const released = await fetch(`${w.apiUrl}/admin/repulls/${w.row().id}/released`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pr: "n0", tag_sha: merge, tree_verified: true }),
    });
    expect(((await released.json()) as { code: string }).code).toBe("acceptance-unattested");
    // The next run reads main again, finds no line and writes it, once; the record completes.
    w.setLedgerWriteFault(null);
    const second = await resume();
    expect(second.exitCode, second.all).toBe(0);
    expect(w.row().status).toBe("complete");
    expect(w.ledgerWrites()).toBe(2);
    const ledger = await gitIn(w.fx.originRepo, ["show", `refs/heads/main:${LEDGER}`]);
    expect(ledger.split("\n").filter((l) => l.includes("repull-merge-accepted"))).toHaveLength(1);
    // A third finds nothing open and writes nothing.
    expect((await resume()).exitCode).toBe(1);
    expect(w.ledgerWrites()).toBe(2);
  });

  test("a line on main already naming the merge is not NEMAR's: refused, nothing written", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const ledger = await gitIn(w.fx.originRepo, ["show", `${merge}:${LEDGER}`]);
    const handMade = `${mergeAcceptanceLine({
      dataset: w.fx.datasetId,
      version: "2.0.0",
      mergeSha: merge,
      planDigest: w.row().plan_digest as string,
      scanner: "identifier-scan@abcdef1",
      at: "2026-10-01T00:00:00.000Z",
    })}\n`;
    const main = await w.commitOnto("refs/heads/main", LEDGER, `${ledger}${handMade}`, "By hand");
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("attestation-conflict");
    expect(acceptances()).toEqual([]);
    expect(w.ledgerWrites()).toBe(0);
    expect(await mainHead()).toBe(main);
    expect(w.row().status).toBe("merged");
  });

  test("trailers the proof reads with values not the record's: accepted, and the line it writes changes nothing", async () => {
    await w.restore(gated);
    const plan = `sha256:${"c".repeat(64)}`;
    await w.mergeOnGitHub({
      message: `Upstream-Snapshot: ds099999@1.1.0\nRepull-Plan: ${plan}`,
    });
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("is not the re-pull's own");
    expect(w.row().status).toBe("complete");
    // The merge passes the proof on its own trailers, and the line naming it is matched, not
    // counted against the dataset.
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, invalid: 0, accepted: 0 });
  });

  test("the acceptance waits for the tag, so NEMAR's line never lands on main before it", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    const early = await accepting();
    expect(early.exitCode, early.all).toBe(3);
    expect(early.all).toContain("the tag v2.0.0");
    expect(acceptances()).toEqual([]);
    expect(w.ledgerWrites()).toBe(0);
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "complete", tag_sha: merge });
  });

  test("--accept-merge-trailers on a record that does not need it says it changes nothing", async () => {
    await w.restore(gated);
    const ready = await accepting();
    expect(ready.exitCode, ready.all).toBe(0);
    expect(ready.all).toContain("--accept-merge-trailers changed nothing");
    // A merge through NEMAR's gate carries its trailers.
    const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
    expect(merged.exitCode, merged.all).toBe(0);
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain(
      "carries the re-pull's trailers; --accept-merge-trailers changes nothing",
    );
    expect(acceptances()).toEqual([]);
  });

  test("a pull request that is not the record's branch of its own repository: pr-foreign, by the CLI", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    const pull = w.gh.pulls[prKey(w)];
    if (!pull) throw new Error("no pull request");
    pull.headRepo = "someone/fork";
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("pr-foreign");
    expect(acceptRequests()).toHaveLength(2); // the first run's question and this one's; no reason sent
    await nothingWritten(merge);
  });

  test("GitHub naming another merge commit than the record's: merge-mismatch, by the CLI and by the Worker", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    const pull = w.gh.pulls[prKey(w)];
    if (!pull) throw new Error("no pull request");
    pull.mergeCommitSha = "e".repeat(40);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-mismatch");
    expect(acceptRequests()).toHaveLength(2);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-mismatch",
    });
    await nothingWritten(merge);
  });

  /**
   * What GitHub's merge button writes (ADR 0111, the amendment of 2026-11-09): a commit on `main`
   * with the gated head's tree, `main`'s tip as its first parent, and `others` after it. The pull
   * request is then marked merged at that commit, as GitHub answers for a merge made on its page.
   */
  async function mergeCommitOnGitHub(others: (head: string, tree: string) => Promise<string[]>) {
    await w.restore(gated);
    const origin = w.fx.originRepo;
    const head = w.row().head_sha as string;
    const main = await mainHead();
    const tree = (await gitIn(origin, ["rev-parse", `${head}^{tree}`])).trim();
    const parents = [main, ...(await others(head, tree))];
    const merge = (
      await runCommand(
        [
          "git",
          "commit-tree",
          tree,
          ...parents.flatMap((p) => ["-p", p]),
          "-m",
          "Merge pull request",
        ],
        { cwd: origin, env: GIT_ID },
      )
    ).stdout.trim();
    await gitIn(origin, ["update-ref", "refs/heads/main", merge, main]);
    const pull = w.gh.pulls[prKey(w)];
    if (!pull) throw new Error("no pull request");
    Object.assign(pull, { merged: true, state: "closed", mergeCommitSha: merge });
    await tagged();
    return { merge, head, main, tree };
  }

  /** A commit of the given tree that is not on any history the record knows. */
  const strangerCommit = async (tree: string, parent?: string) =>
    (
      await runCommand(
        ["git", "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "stranger"],
        { cwd: w.fx.originRepo, env: GIT_ID },
      )
    ).stdout.trim();

  test("a plain merge of the pull request (two parents, the merged head second) is accepted, attested and released", async () => {
    await w.restore(gated);
    const merge = await w.mergeOnGitHub({ method: "merge" });
    expect(
      (await gitIn(w.fx.originRepo, ["rev-list", "--parents", "-n", "1", merge])).trim().split(" "),
    ).toHaveLength(3);
    await tagged();
    const ledgerAtMerge = await gitIn(w.fx.originRepo, ["show", `${merge}:${LEDGER}`]);
    // Before the acceptance the dataset fails the proof, as it does for any merge without trailers.
    expect(await proof()).toMatchObject({ notAlone: 1, accepted: 0 });
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("Verified by this run");
    expect(run.all).toContain(`is a plain merge commit of pull request #${w.row().pr_number}`);
    expect(run.all).toContain("its first parent (its second is the merged head");
    expect(run.all).not.toContain("squash merge of pull request");
    expect(run.all).toContain("is complete");
    const row = w.row();
    expect(row).toMatchObject({ status: "complete", tag_sha: merge, last_error: null });
    const [accepted, ...more] = acceptances();
    expect(more).toEqual([]);
    expect(accepted).toMatchObject({ pr: "n0", merge_sha: merge, reason: REASON });
    // The one line NEMAR wrote names the merge, and the proof now vouches for exactly that merge.
    const ledgerOnMain = await gitIn(w.fx.originRepo, ["show", `${await mainHead()}:${LEDGER}`]);
    expect(ledgerOnMain.startsWith(ledgerAtMerge)).toBe(true);
    const added = ledgerOnMain.slice(ledgerAtMerge.length).split("\n").filter(Boolean);
    expect(added).toHaveLength(1);
    expect(validateLedgerEntry(JSON.parse(added[0] as string) as LedgerEntry)).toMatchObject({
      action: "repull-merge-accepted",
      commit: merge,
    });
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, invalid: 0, accepted: 1 });
  });

  test("a plain merge on a main that enrichment moved is accepted, said as a parent moved by enrichment", async () => {
    await w.restore(gated);
    await w.commitOnto(
      "refs/heads/main",
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, "refs/heads/main"),
      "Update NEMAR metadata",
    );
    const merge = await w.mergeOnGitHub({ method: "merge" });
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("moved by enrichment only");
    expect(run.all).toContain("is a plain merge commit");
    expect(w.row()).toMatchObject({ status: "complete", merge_sha: merge });
    expect(await proof()).toMatchObject({ notAlone: 0, unmatched: 0, accepted: 1 });
  });

  test("a plain merge whose first parent is main moved by anything but enrichment: merge-parent-foreign, by the CLI and by the Worker", async () => {
    await w.restore(gated);
    await w.commitOnto("refs/heads/main", "README.md", "Changed by hand on main.\n");
    const merge = await w.mergeOnGitHub({ method: "merge" });
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-parent-foreign");
    expect(acceptRequests()).toHaveLength(1);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-parent-foreign",
    });
    await nothingWritten(merge);
  });

  test("a plain merge of a head enrichment moved is accepted; of a head moved by any other commit is refused", async () => {
    await w.restore(gated);
    const branch = `refs/heads/${w.row().branch}`;
    await w.commitOnto(
      branch,
      ".nemar/metadata.json",
      await enrichedMetadata(w.fx.originRepo, branch),
      "Update NEMAR metadata",
    );
    await w.mergeOnGitHub({ method: "merge" });
    await tagged();
    const ok = await accepting();
    expect(ok.exitCode, ok.all).toBe(0);
    expect(ok.all).toContain("which enrichment moved the recorded head");
    expect(w.row().status).toBe("complete");

    await w.restore(gated);
    await w.commitOnto(branch, "README.md", "Changed by hand on the release branch.\n");
    const merge = await w.mergeOnGitHub({ method: "merge" });
    await tagged();
    const foreign = await accepting();
    expect(foreign.exitCode, foreign.all).toBe(1);
    expect(foreign.all).toContain("merge-head-foreign");
    expect(acceptRequests()).toHaveLength(1);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-head-foreign",
    });
    await nothingWritten(merge);
  });

  test("a plain merge whose tree is not the re-pull's commit: merge-tree-mismatch, by the CLI and by the Worker", async () => {
    await w.restore(gated);
    const merge = await w.mergeOnGitHub({ method: "merge" });
    await tagged();
    expect((await resume()).exitCode).toBe(3); // records the merge; refuses merge-trailers
    // The record's synthesized commit, as if it were another: the base's.
    const base = w.row().base_sha;
    const baseTree = (await gitIn(w.fx.originRepo, ["rev-parse", `${base}^{tree}`])).trim();
    w.db().run("UPDATE upstream_repulls SET synth_sha = ?, synth_tree = ?", [base, baseTree]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-tree-mismatch");
    await nothingWritten(merge);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-tree-mismatch",
    });
    await nothingWritten(merge);
  });

  test("a merge commit of three parents: merge-not-squash, by the CLI and by the Worker", async () => {
    const { merge } = await mergeCommitOnGitHub(async (head, tree) => [
      head,
      await strangerCommit(tree),
    ]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-not-squash");
    expect(acceptRequests()).toHaveLength(1); // refused by the CLI, before any reason was sent
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-not-squash",
    });
    await nothingWritten(merge);
  });

  test("two parents whose second is not the merged head: merge-second-parent-foreign, by the CLI and by the Worker", async () => {
    // The same tree as the gated head, so that the shape is the only thing that is wrong.
    const { merge } = await mergeCommitOnGitHub(async (_head, tree) => [
      await strangerCommit(tree),
    ]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-second-parent-foreign");
    expect(acceptRequests()).toHaveLength(1);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-second-parent-foreign",
    });
    await nothingWritten(merge);
  });

  test("two parents with the merged head FIRST and main second are not GitHub's merge: refused", async () => {
    // The order is the rule: the first parent is what the base is compared with.
    await w.restore(gated);
    const origin = w.fx.originRepo;
    const head = w.row().head_sha as string;
    const main = await mainHead();
    const tree = (await gitIn(origin, ["rev-parse", `${head}^{tree}`])).trim();
    const merge = (
      await runCommand(
        ["git", "commit-tree", tree, "-p", head, "-p", main, "-m", "Merge pull request"],
        { cwd: origin, env: GIT_ID },
      )
    ).stdout.trim();
    await gitIn(origin, ["update-ref", "refs/heads/main", merge, main]);
    const pull = w.gh.pulls[prKey(w)];
    if (!pull) throw new Error("no pull request");
    Object.assign(pull, { merged: true, state: "closed", mergeCommitSha: merge });
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-second-parent-foreign");
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-second-parent-foreign",
    });
    await nothingWritten(merge);
  });

  test("a merge that edits an earlier ledger line: merge-ledger-foreign, by the CLI and by the Worker", async () => {
    await w.restore(gated);
    const branch = `refs/heads/${w.row().branch}`;
    const ledger = await gitIn(w.fx.originRepo, ["show", `${branch}:${LEDGER}`]);
    const [first, ...rest] = ledger.split("\n");
    const edited = [first?.replace('"version":1', '"version":1 '), ...rest].join("\n");
    const head = await w.commitOnto(branch, LEDGER, edited, "edit the ledger");
    const merge = await w.mergeOnGitHub();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    // The record's head, as if the edit were the re-pull's own: only the ledger check is left.
    w.db().run("UPDATE upstream_repulls SET head_sha = ?", [head]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-ledger-foreign");
    expect(acceptRequests()).toHaveLength(2);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-ledger-foreign",
    });
    await nothingWritten(merge);
  });

  test("a repull-scrubbed line whose scanner no ledger line can carry is refused before anything is recorded", async () => {
    await w.restore(gated);
    const branch = `refs/heads/${w.row().branch}`;
    const ledger = await gitIn(w.fx.originRepo, ["show", `${branch}:${LEDGER}`]);
    const lines = ledger.split("\n").filter(Boolean);
    const last = JSON.parse(lines.at(-1) as string);
    expect(last.action).toBe("repull-scrubbed");
    lines[lines.length - 1] = JSON.stringify({ ...last, scanner: "identifier-scan@xyz" });
    const head = await w.commitOnto(branch, LEDGER, `${lines.join("\n")}\n`, "a bad scanner");
    const merge = await w.mergeOnGitHub();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    w.db().run("UPDATE upstream_repulls SET head_sha = ?", [head]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-ledger-foreign");
    expect(run.all).toContain("names no scanner a ledger line can carry");
    await nothingWritten(merge);
  });

  test("main that no longer holds the merge: merge-not-on-main, before the acceptance and before a later write", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const parent = (await gitIn(w.fx.originRepo, ["rev-parse", `${merge}^`])).trim();
    // main rewritten past the merge, before anything was accepted.
    await gitIn(w.fx.originRepo, ["update-ref", "refs/heads/main", parent, merge]);
    const before = await accepting();
    expect(before.exitCode, before.all).toBe(1);
    expect(before.all).toContain("merge-not-on-main");
    expect(acceptances()).toEqual([]);
    expect(w.ledgerWrites()).toBe(0);

    // Accepted, its first write lost, then main rewritten: the next run writes no line naming an id
    // the history no longer holds.
    await w.restore(mergedOnGitHub);
    await tagged();
    w.setLedgerWriteFault(() => Response.json({ message: "Server Error" }, { status: 502 }));
    expect((await accepting()).exitCode).toBe(3);
    expect(acceptances()).toHaveLength(1);
    w.setLedgerWriteFault(null);
    await gitIn(w.fx.originRepo, ["update-ref", "refs/heads/main", parent, merge]);
    const later = await resume();
    expect(later.exitCode, later.all).toBe(1);
    expect(later.all).toContain("merge-not-on-main");
    expect(later.all).toContain("The acceptance is recorded");
    expect(w.ledgerWrites()).toBe(1);
    expect(await mainHead()).toBe(parent);
  });

  test("a partial failure says what this run verified and that the acceptance is recorded, without contradiction", async () => {
    await w.restore(mergedOnGitHub);
    await tagged();
    w.setLedgerWriteFault(() => Response.json({ message: "Server Error" }, { status: 502 }));
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("Verified by this run");
    expect(run.all).toContain("The Worker answered: The acceptance is recorded");
    expect(run.all).not.toContain("did not accept");
  });

  test("a later run meeting a line it did not write: attestation-conflict, exit 1 as on a first acceptance", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    w.setLedgerWriteFault(() => Response.json({ message: "Server Error" }, { status: 502 }));
    expect((await accepting()).exitCode).toBe(3);
    w.setLedgerWriteFault(null);
    const ledger = await gitIn(w.fx.originRepo, ["show", `${merge}:${LEDGER}`]);
    const handMade = `${mergeAcceptanceLine({
      dataset: w.fx.datasetId,
      version: "2.0.0",
      mergeSha: merge,
      planDigest: w.row().plan_digest as string,
      scanner: "identifier-scan@abcdef1",
      at: "2026-10-01T00:00:00.000Z",
    })}\n`;
    await w.commitOnto("refs/heads/main", LEDGER, `${ledger}${handMade}`, "By hand");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("attestation-conflict");
    expect(run.all).toContain("The acceptance is recorded");
    expect(w.ledgerWrites()).toBe(1);
  });

  test("a ledger write GitHub refuses with a 422 that says the blob moved is read again and made once", async () => {
    await w.restore(mergedOnGitHub);
    await tagged();
    let once = true;
    w.setLedgerWriteFault(() => {
      if (!once) return null;
      once = false;
      return Response.json(
        { message: ".nemar/corrections.jsonl does not match 0123456789" },
        { status: 422 },
      );
    });
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.ledgerWrites()).toBe(2);
    expect(w.row().status).toBe("complete");
  });

  test("a GitHub that cannot be read exits 3, for the CLI's reading and for the Worker's, and nothing is written", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    const pull = w.gh.pulls[prKey(w)];
    if (!pull) throw new Error("no pull request");
    pull.adminReadsAfterFirst = { status: 503 };
    const cli = await accepting();
    expect(cli.exitCode, cli.all).toBe(3);
    expect(cli.all).toContain("github-unreadable");
    await nothingWritten(merge);
    pull.adminReadsAfterFirst = undefined;
    w.gh.expiredTokens.add(WORKER_TOKEN);
    const worker = await accepting();
    expect(worker.exitCode, worker.all).toBe(3);
    expect(worker.all).toContain("github-unreadable");
    await nothingWritten(merge);
  });

  test("the Worker's own reading of enrichment: more than 20 commits, 300 files or a removal is not enrichment", async () => {
    const meta = (rev: string, n: number) =>
      enrichedMetadata(w.fx.originRepo, rev, `2026-10-25T00:00:${String(n).padStart(2, "0")}Z`);
    // 21 enrichment commits on main: more than enrichment ever makes.
    await w.restore(gated);
    for (let i = 0; i < 21; i++) {
      await w.commitOnto(
        "refs/heads/main",
        ".nemar/metadata.json",
        await meta("refs/heads/main", i),
        "Update NEMAR metadata",
      );
    }
    let merge = await w.mergeOnGitHub();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-parent-foreign",
    });
    await nothingWritten(merge);

    // 300 files under .nemar/ in one commit: GitHub's comparison lists at most 300, so not all.
    await w.restore(gated);
    const many: Record<string, string | null> = {};
    for (let i = 0; i < 300; i++) many[`.nemar/extra-${i}.json`] = `{"i":${i}}\n`;
    await commitFiles("refs/heads/main", many, "Update NEMAR metadata");
    merge = await w.mergeOnGitHub();
    await tagged();
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("merge-parent-foreign");
    expect(acceptRequests()).toHaveLength(2); // the CLI's shape check took it; the Worker did not
    await nothingWritten(merge);

    // A file under .nemar/ removed: enrichment adds and changes, never removes.
    await w.restore(gated);
    const removed = await commitFiles(
      "refs/heads/main",
      { ".nemar/metadata.json": null },
      "remove metadata",
    );
    const gone = await runCommand(["git", "cat-file", "-e", `${removed}:.nemar/metadata.json`], {
      cwd: w.fx.originRepo,
    });
    expect(gone.exitCode).not.toBe(0);
    merge = await w.mergeOnGitHub();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-parent-foreign",
    });
    await nothingWritten(merge);
  });

  test("a base that shares no history with the merge's parent is not enrichment: merge-parent-foreign", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    // A root commit of its own, as a record whose base were another repository's.
    const empty = (
      await runCommand(["git", "hash-object", "-t", "tree", "-w", "--stdin"], {
        cwd: w.fx.originRepo,
        stdin: "",
      })
    ).stdout.trim();
    const root = (
      await runCommand(["git", "commit-tree", empty, "-m", "unrelated"], {
        cwd: w.fx.originRepo,
        env: GIT_ID,
      })
    ).stdout.trim();
    w.db().run("UPDATE upstream_repulls SET base_sha = ?", [root]);
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "merge-parent-foreign",
    });
    await nothingWritten(merge);
  });

  test("a main whose ledger is gone: ledger-missing-on-main, before anything is recorded", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    const main = await commitFiles("refs/heads/main", { [LEDGER]: null }, "remove the ledger");
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("ledger-missing-on-main");
    expect(acceptances()).toEqual([]);
    expect(w.ledgerWrites()).toBe(0);
    expect(await mainHead()).toBe(main);
    expect(merge).not.toBe(main);
  });

  test("a record that is not merged yet is not accepted by the Worker: bad-transition", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    expect(w.row().status).toBe("gates_clear");
    expect(await acceptRoute({ pr: "n0", merge_sha: merge, reason: REASON })).toEqual({
      status: 409,
      code: "bad-transition",
    });
    expect(acceptances()).toEqual([]);
  });

  test("a merge appending only a scrub's import line: accepted with no ledger line, said in both readings", async () => {
    await w.restore(gated);
    const branch = `refs/heads/${w.row().branch}`;
    const ledger = await gitIn(w.fx.originRepo, ["show", `${branch}:${LEDGER}`]);
    const lines = ledger.split("\n").filter(Boolean);
    const last = JSON.parse(lines.at(-1) as string);
    lines[lines.length - 1] = JSON.stringify({ ...last, action: "import-scrubbed" });
    const head = await w.commitOnto(branch, LEDGER, `${lines.join("\n")}\n`, "an import line");
    await w.mergeOnGitHub();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    w.db().run("UPDATE upstream_repulls SET head_sha = ?", [head]);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("  - it appends only a scrub's lines to the privacy ledger;");
    expect(run.all).toContain("; the merge appends only a scrub's lines to the privacy ledger;");
    expect(acceptances()).toMatchObject([{ attestation_needed: 0 }]);
    expect(w.ledgerWrites()).toBe(0);
  });

  test("an answer from the NEMAR API that was lost or rate-limited exits 3, and the next run takes it up", async () => {
    await w.restore(mergedOnGitHub);
    // Whether the request the API answers now is an acceptance with a reason, read before it is
    // answered, for every request, so no other request is taken for one.
    let withReason = false;
    w.setApiHook(async (req) => {
      withReason =
        req.method === "POST" &&
        new URL(req.url).pathname.endsWith("/merge-trailers/accept") &&
        typeof ((await req.json()) as { reason?: unknown }).reason === "string";
    });
    await tagged();
    // A rate limit, before the Worker read anything.
    w.setApiOverride(() =>
      withReason ? Response.json({ error: "Too Many Requests" }, { status: 429 }) : null,
    );
    const limited = await accepting();
    expect(limited.exitCode, limited.all).toBe(3);
    expect(limited.all).toContain("Too Many Requests");
    expect(acceptances()).toEqual([]);
    w.setApiOverride(null);
    // An answer lost on the way back, after the Worker accepted and wrote the line.
    let once = true;
    w.setApiAfter(() => {
      if (!withReason || !once) return null;
      once = false;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"accep'));
            c.error(new Error("the connection dropped"));
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const lost = await accepting();
    expect(lost.exitCode, lost.all).toBe(3);
    expect(acceptances()).toHaveLength(1);
    expect(w.ledgerWrites()).toBe(1);
    const next = await resume();
    expect(next.exitCode, next.all).toBe(0);
    expect(w.row().status).toBe("complete");
    expect(w.ledgerWrites()).toBe(1);
  });

  test("a probe for an earlier acceptance that went unanswered claims nothing about one", async () => {
    await w.restore(mergedOnGitHub);
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    w.setApiOverride((req) =>
      req.method === "POST" && new URL(req.url).pathname.endsWith("/merge-trailers/accept")
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : null,
    );
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("asked for an acceptance recorded earlier, the Worker answered");
    expect(run.all).not.toContain("acceptance is recorded");
    expect(run.all).not.toContain("stands");
  });

  test("every disjunct of pr-foreign refuses by itself, by the CLI", async () => {
    for (const [label, change] of [
      ["a base other than main", { base: "develop" }],
      ["another head branch", { headRef: "release/v9.9.9" }],
      ["a base repository not the dataset's", { baseRepo: "someone/fork" }],
    ] as const) {
      await w.restore(mergedOnGitHub);
      const merge = await mainHead();
      await tagged();
      expect((await resume()).exitCode).toBe(3);
      const pull = w.gh.pulls[prKey(w)];
      if (!pull) throw new Error("no pull request");
      Object.assign(pull, change);
      const run = await accepting();
      expect(run.exitCode, `${label}: ${run.all}`).toBe(1);
      expect(run.all, label).toContain("pr-foreign");
      expect(acceptRequests(), label).toHaveLength(2);
      await nothingWritten(merge);
    }
  });

  test("the Worker's record-side check refuses a merge commit the record does not name, whatever GitHub says", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    expect((await resume()).exitCode).toBe(3);
    const other = (await gitIn(w.fx.originRepo, ["rev-parse", `${merge}^`])).trim();
    const pull = w.gh.pulls[prKey(w)];
    if (!pull) throw new Error("no pull request");
    // GitHub agrees with the request, so only the record says no.
    pull.mergeCommitSha = other;
    const res = await fetch(`${w.apiUrl}/admin/repulls/${w.row().id}/merge-trailers/accept`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pr: "n0", merge_sha: other, reason: REASON }),
    });
    const answer = (await res.json()) as { code: string; error: string };
    expect([res.status, answer.code]).toEqual([409, "merge-mismatch"]);
    expect(answer.error).toContain(`records the merge ${merge.slice(0, 12)}`);
    await nothingWritten(merge);
  });

  test("a failed read of main after the acceptance is recorded says it is recorded, and exits 3", async () => {
    await w.restore(mergedOnGitHub);
    await tagged();
    w.setLedgerWriteFault(() => Response.json({ message: "Server Error" }, { status: 502 }));
    expect((await accepting()).exitCode).toBe(3);
    w.setLedgerWriteFault(null);
    w.setLedgerReadFault(() => Response.json({ message: "Server Error" }, { status: 503 }));
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("The acceptance is recorded, and GitHub could not be read");
    expect(run.all).not.toContain("nothing was recorded");
    expect(acceptances()).toHaveLength(1);
  });

  test("GitHub's 422 for a comparison with main is unread, not an absence: exit 3, nothing written", async () => {
    await w.restore(mergedOnGitHub);
    const merge = await mainHead();
    await tagged();
    w.setMainCompareFault(422);
    const run = await accepting();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("github-unreadable");
    expect(run.all).not.toContain("merge-not-on-main");
    await nothingWritten(merge);
  });

  test("a run given the flag that stops on a refusal before a release still says the flag changed nothing", async () => {
    await w.restore();
    const pull = w.gh.pulls[prKey(w)];
    if (!pull) throw new Error("no pull request");
    pull.headRepo = "someone/fork";
    const run = await accepting();
    expect(run.exitCode, run.all).not.toBe(0);
    expect(run.all).toContain("pr-foreign");
    expect(run.all).toContain("--accept-merge-trailers changed nothing");
  });

  test("a reason outside 10 to 500 characters is a usage error, before anything is read", async () => {
    await w.restore(mergedOnGitHub);
    const run = await resume(["--accept-merge-trailers", "short"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.all).toContain("a reason of 10 to 500 characters is required");
    expect(w.row().status).toBe("gates_clear");
    expect(acceptances()).toEqual([]);
  });
});
