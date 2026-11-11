/**
 * N.0.1: NEMAR's corrections replayed onto the released N.0.0 (ADR 0111, decisions 1 and 3; epic
 * #1046 phase 6, #1912), driven through the real entry point against `repull-pr-world.ts` with its
 * default fixture: NEMAR edited a sidecar and added a description key (two corrections) and edited
 * `participants.tsv`, which upstream changed too (a conflict). N.0.0 is merged by the real gate;
 * the test plays the dataset workflow (the tag) and the DOI's callback (the version row); every
 * step of the re-pull itself is the real CLI and the real Worker routes over bun:sqlite, on a
 * loopback port named in the child's environment. GitHub and S3 are stand-ins. No mocks.
 *
 * The properties, each with a test:
 *  - after the release and the lock, a plan with conflicts waits for an administrator's decision,
 *    and nothing is pushed;
 *  - with `--keep-upstream`, N.0.1 replays the sidecar byte for byte and the description key, says
 *    2.0.1, leaves the conflict on upstream's side, scrubs and copies nothing, and opens a second
 *    pull request; it then goes through the same screen, gates, merge (claiming the cap as N.0.1)
 *    and release as N.0.0, to `complete`, and `pr-reviews approve --merge` merges it through that
 *    same gate;
 *  - with `--take-ours participants.tsv`, the conflict is replayed as NEMAR had it;
 *  - a `--take-ours` that names no conflict refuses before anything is written;
 *  - abandon after the release declines N.0.1 (`patch_declined`), closing its pull request and
 *    deleting its branch when they exist, and never while N.0.0's lock is not recorded; a release
 *    branch or pull request of N.0.1's version that is not this re-pull's is neither closed nor
 *    deleted, a branch that cannot be judged is kept, a branch that moved after it was judged is
 *    not deleted (the delete is leased), and a merged N.0.1 pull request or a held claim refuses;
 *  - a plan file that is not the record's refuses (`plan-not-the-record`) and writes nothing;
 *  - a run that pushed N.0.1 and could not record it is taken up by the next run with the same
 *    resolutions, and refused (`branch-foreign`) with other ones;
 *  - N.0.1 is made on `main` as enrichment left it, not on the N.0.0 merge;
 *  - a `main` moved by enrichment with N.0.1's pull request `dirty` makes N.0.1 again, pushed with
 *    a lease, and a run that pushed it and could not record it is recognized by the next;
 *  - N.0.1's pull request closed without a merge ends the record `patch_declined`;
 *  - N.0.1's merge commit read back without its trailers stays `patch_merged` (`merge-trailers`);
 *    so does a tag whose tree is not N.0.1's gated head (`patch-tree-mismatch`), until resume is
 *    given the administrator's reason (`--accept-tag-tree`);
 *  - a record that does not state its corrections is not merged as N.0.1 (stage `message`).
 *
 * What only the canary and the first production runs can check: that GitHub opens and squash-merges
 * a second release pull request on the same repository as the stand-in does, and that the dataset
 * workflows tag v2.0.1 and mint its DOI as they do any other patch release.
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
import { readFileSync, writeFileSync } from "node:fs";
import { which } from "bun";
import { planDigest, readPlanFile } from "../src/lib/repull/digest";
import { PATHS, gitIn } from "./helpers/repull-fixture";
import {
  type RepullWorld,
  type WorldPoint,
  enrichedMetadata,
  startRepullWorld,
} from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

let w: RepullWorld;
/**
 * The points the cases start from, each reached once, in `beforeAll`, by the same real CLI runs a
 * case would otherwise repeat (and asserted there): N.0.0 merged, tagged v2.0.0 and its version
 * row written (`released`); then released and locked, waiting for a decision on its conflict
 * (`locked`); then N.0.1 made with `--keep-upstream` (`opened`, `patch_synthesized`); then its
 * screen passed and its gates recorded (`gated`, `patch_gates_clear`).
 */
let released: WorldPoint;
let locked: WorldPoint;
let opened: WorldPoint;
let gated: WorldPoint;

beforeAll(async () => {
  if (!awsInstalled) return;
  w = await startRepullWorld();
  const head = w.row().head_sha as string;
  expect((await resume()).exitCode).toBe(3);
  await w.reportScreen(head, "clean");
  expect((await resume()).exitCode).toBe(0);
  const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
  expect(merged.exitCode, merged.all).toBe(0);
  await w.tagMain("2.0.0");
  w.insertVersionRow("2.0.0");
  released = await w.save();
  const waiting = await resume();
  expect(waiting.exitCode, waiting.all).toBe(3);
  expect(w.row().status).toBe("released");
  locked = await w.save();
  const made = await resume(["--keep-upstream"]);
  expect(made.exitCode, made.all).toBe(3);
  expect(w.row().status).toBe("patch_synthesized");
  opened = await w.save();
  await w.reportScreen(w.row().patch_head_sha as string, "clean");
  const ready = await resume();
  expect(ready.exitCode, ready.all).toBe(0);
  expect(w.row().status).toBe("patch_gates_clear");
  gated = await w.save();
});
afterAll(() => w?.stop());
beforeEach(async () => {
  if (awsInstalled) await w.restore();
});

const resume = (extra: string[] = []) =>
  w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes", ...extra]);
const show = (rev: string, path: string) => gitIn(w.fx.originRepo, ["show", `${rev}:${path}`]);
const oid = async (rev: string, path: string) =>
  (await gitIn(w.fx.originRepo, ["rev-parse", `${rev}:${path}`])).trim();
const hasRef = async (ref: string) =>
  (await gitIn(w.fx.originRepo, ["for-each-ref", "--format=%(refname)", ref])).trim() !== "";
const S3_WRITES = ["PutObject", "CopyObject", "UploadPartCopy", "CreateMultipartUpload"] as const;
const s3Writes = () => S3_WRITES.flatMap((op) => w.s3.calls(op));

/** N.0.0 merged by the real gate, tagged v2.0.0 and its version row written: the record merged. */
const releasedN0 = () => w.restore(released);
/** Released and locked: the record waits at `released` for a decision on its conflict. */
const lockedN0 = () => w.restore(locked);
/** N.0.1 made with `--keep-upstream`: the record at `patch_synthesized`. */
const patchOpen = () => w.restore(opened);
/** N.0.1's screen passed and its gates recorded: `patch_gates_clear`. */
const patchGates = () => w.restore(gated);

/** N.0.1's pull request as the GitHub stand-in holds it. */
const patchPull = () => w.gh.pulls[`${w.fx.datasetId}#${w.row().patch_pr_number}`];
const mainHead = async () =>
  (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
/** Enrichment on `main`: `.nemar/metadata.json` stamped again. Returns the new head. */
const enrichMain = async () =>
  w.commitOnto(
    "refs/heads/main",
    ".nemar/metadata.json",
    await enrichedMetadata(w.fx.originRepo, "refs/heads/main"),
    "Update NEMAR metadata",
  );
/** The next transition to `to` answers 503 after the Worker did not handle it: nothing recorded. */
function failNextTransition(match: (body: Record<string, unknown>) => boolean): void {
  let armed = false;
  w.setApiHook(async (req) => {
    if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/transition")) return;
    if (match((await req.json()) as Record<string, unknown>)) armed = true;
  });
  w.setApiOverride((req) => {
    if (!armed || req.method !== "POST") return null;
    armed = false;
    return Response.json({ error: "unavailable" }, { status: 503 });
  });
}
const abandon = () => w.cli(["repull", "abandon", w.fx.datasetId, "--yes"]);

describe.skipIf(!awsInstalled)("N.0.1", () => {
  test("after the release, conflicts wait for a decision and nothing is pushed", async () => {
    expect(JSON.parse(w.row().counts)).toMatchObject({ corrections: 2, conflicts: 1 });
    await releasedN0();
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("--take-ours");
    expect(run.all).toContain("--keep-upstream");
    const row = w.row();
    expect(row.status).toBe("released");
    expect(JSON.parse(row.counts).locked).toBeGreaterThan(0);
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
    expect(Object.values(w.gh.pulls).filter((p) => p.headRef === "release/v2.0.1")).toEqual([]);
  });

  test("a record that does not say its counts stays released, exits 0, and the message names the way out", async () => {
    await lockedN0();
    // Unknown is never zero: the record loses the two numbers the plan's tallies gave it.
    const counts = JSON.parse(w.row().counts);
    Reflect.deleteProperty(counts, "corrections");
    Reflect.deleteProperty(counts, "conflicts");
    w.db().run("UPDATE upstream_repulls SET counts = ?", [JSON.stringify(counts)]);
    const run = await resume();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("does not say how many corrections and conflicts");
    expect(run.all).toContain("it blocks");
    expect(run.all).toContain(`nemar admin repull abandon ${w.fx.datasetId}`);
    expect(w.row().status).toBe("released");
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
    // The way the message names works: it ends the record, and v2.0.0 stays released.
    const ended = await abandon();
    expect(ended.exitCode, ended.all).toBe(0);
    expect(w.row().status).toBe("patch_declined");
  });

  test("--keep-upstream replays the corrections byte for byte, and N.0.1 goes to complete through the same gates", async () => {
    await releasedN0();
    const base = w.row().base_sha;
    const mergeN0 = w.row().merge_sha as string;
    const writesBefore = s3Writes().length;
    const made = await resume(["--keep-upstream"]);
    // It stops waiting for N.0.1's identifier screen.
    expect(made.exitCode, made.all).toBe(3);
    const row = w.row();
    expect(row).toMatchObject({
      status: "patch_synthesized",
      patch_version: "2.0.1",
      patch_branch: "release/v2.0.1",
    });
    expect(JSON.parse(row.counts)).toMatchObject({ resolutions: 0 });
    const patch = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])).trim();
    expect(row.patch_head_sha).toBe(patch);
    // One commit on the merged N.0.0 (main at the merge), by the re-pull's identity.
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${patch}^@`])).trim()).toBe(
      row.patch_base_sha as string,
    );
    expect(row.patch_base_sha).toBe(mergeN0);
    // The sidecar NEMAR edited is NEMAR's blob again, byte for byte.
    expect(await oid(patch, PATHS.sidecar)).toBe(await oid(base, PATHS.sidecar));
    expect(await oid(mergeN0, PATHS.sidecar)).not.toBe(await oid(base, PATHS.sidecar));
    // The description: NEMAR's key back, N.0.1's version, upstream's GeneratedBy kept.
    const desc = JSON.parse(await show(patch, PATHS.description));
    expect(desc).toMatchObject({
      Version: "2.0.1",
      HowToAcknowledge: "Cite the NEMAR mirror.",
      GeneratedBy: [{ Name: "fixture-pipeline" }],
    });
    // The conflict stays on upstream's side, as N.0.0 holds it.
    expect(await oid(patch, PATHS.participants)).toBe(await oid(mergeN0, PATHS.participants));
    // Only those two paths differ from N.0.0.
    const changed = (await gitIn(w.fx.originRepo, ["diff", "--name-only", mergeN0, patch]))
      .trim()
      .split("\n")
      .sort();
    expect(changed).toEqual([PATHS.description, PATHS.sidecar].sort());
    // Its message ends with the trailers, N.0.1's own beside them.
    const trailers = (
      await gitIn(w.fx.originRepo, ["log", "-1", "--format=%(trailers:only,unfold)", patch])
    ).trim();
    expect(trailers).toContain(`Repull-Plan: ${row.plan_digest}`);
    expect(trailers).toContain("Repull-Patch: corrections=2");
    // Nothing scrubbed and nothing copied: no S3 write since N.0.0's lock.
    expect(s3Writes().length).toBe(writesBefore);
    // A second pull request, into main.
    const prs = Object.entries(w.gh.pulls).filter(([, p]) => p.headRef === "release/v2.0.1");
    expect(prs).toHaveLength(1);
    expect(prs[0]?.[1].base).toBe("main");
    expect(row.patch_pr_number).toBe(Number(prs[0]?.[0].split("#")[1]));

    // The same screen and gates as N.0.0's, on N.0.1's head.
    await w.reportScreen(patch, "clean");
    const ready = await resume();
    expect(ready.exitCode, ready.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "patch_gates_clear", patch_gates_sha: patch });

    // The merge claims the cap as N.0.1's and squash-merges with the trailers last.
    const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
    expect(merged.exitCode, merged.all).toBe(0);
    const after = w.row();
    expect(after.status).toBe("patch_merged");
    expect(after.patch_merge_claimed_at).not.toBeNull();
    expect(after.merge_claimed_at).not.toBeNull();
    const squash = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
    expect(after.patch_merge_sha).toBe(squash);
    expect(
      (await gitIn(w.fx.originRepo, ["log", "-1", "--format=%(trailers:only,unfold)", squash]))
        .trim()
        .split("\n"),
    ).toContain("Repull-Patch: corrections=2");

    // The release of v2.0.1, then complete; N.0.1 locks nothing of its own.
    const locksBefore = w.s3.calls("PutObjectRetention").length;
    await w.tagMain("2.0.1");
    w.insertVersionRow("2.0.1");
    const done = await resume();
    expect(done.exitCode, done.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "complete", last_error: null });
    expect(w.row().patch_tag_sha).not.toBeNull();
    expect(w.s3.calls("PutObjectRetention").length).toBe(locksBefore);
  });

  test("--take-ours replays the conflict as NEMAR had it", async () => {
    await releasedN0();
    const base = w.row().base_sha;
    const run = await resume(["--take-ours", PATHS.participants]);
    expect(run.exitCode, run.all).toBe(3);
    const row = w.row();
    expect(row.status).toBe("patch_synthesized");
    expect(JSON.parse(row.counts)).toMatchObject({ resolutions: 1 });
    const patch = row.patch_head_sha as string;
    expect(await oid(patch, PATHS.participants)).toBe(await oid(base, PATHS.participants));
  });

  test("a --take-ours that names no conflict refuses before anything is written", async () => {
    // The lock is recorded by a first run; the refusal comes on the second.
    await lockedN0();
    const writes = () => w.apiWrites.filter((x) => x.endsWith("/transition")).length;
    const before = writes();
    for (const name of [PATHS.sidecar, "no/such/path.json", "dataset_description.json#Name"]) {
      const run = await resume(["--take-ours", name]);
      expect(run.exitCode, run.all).toBe(1);
      expect(run.all).toContain("take-ours-invalid");
    }
    expect(writes()).toBe(before);
    expect(w.row().status).toBe("released");
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
  });

  test("pr-reviews approve --merge squash-merges N.0.1's pull request through the same gate, as N.0.1", async () => {
    await patchGates();
    const patch = w.row().patch_head_sha as string;
    const pr = w.row().patch_pr_number as number;
    const run = await w.cli([
      "pr-reviews",
      "approve",
      w.fx.datasetId,
      String(pr),
      "--merge",
      "--yes",
    ]);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("through the re-pull's gate");
    const sent = w.gh.seen.filter(
      (x) => x.method === "PUT" && x.path.endsWith(`/pulls/${pr}/merge`),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      sha: patch,
      merge_method: "squash",
      commit_title: `Release v2.0.1 (#${pr})`,
    });
    expect(String(sent[0]?.body?.commit_message)).toMatch(
      /\n\nUpstream-Snapshot: ds099999@1\.1\.0\nRepull-Plan: sha256:[0-9a-f]{64}\nRepull-Patch: corrections=2$/,
    );
    expect(w.row()).toMatchObject({ status: "patch_merged", patch_merge_claim_sha: patch });
  });

  test("abandon does not decline N.0.1 while N.0.0's lock is not recorded", async () => {
    await releasedN0();
    w.s3.inject("PutObjectRetention", { code: "InternalError", status: 500, times: 1 });
    const locked = await resume();
    expect(locked.exitCode, locked.all).toBe(3);
    expect(w.row().status).toBe("released");
    expect(JSON.parse(w.row().counts)).not.toHaveProperty("locked");
    const run = await w.cli(["repull", "abandon", w.fx.datasetId, "--yes"]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("lock-unrecorded");
    expect(w.row().status).toBe("released");
  });

  test("abandon after the release declines N.0.1; with its pull request open, it is closed and its branch deleted", async () => {
    await lockedN0();
    const declined = await w.cli(["repull", "abandon", w.fx.datasetId, "--yes"]);
    expect(declined.exitCode, declined.all).toBe(0);
    expect(w.row()).toMatchObject({ status: "patch_declined", tag_sha: expect.any(String) });

    await patchOpen();
    const pr = w.row().patch_pr_number as number;
    const run = await w.cli(["repull", "abandon", w.fx.datasetId, "--yes"]);
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row().status).toBe("patch_declined");
    expect(w.gh.pulls[`${w.fx.datasetId}#${pr}`]?.state).toBe("closed");
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
    // N.0.0 stays released: its tag is where it was.
    expect(await hasRef("refs/tags/v2.0.0")).toBe(true);
  });
  test("a plan file that is not the record's refuses before anything is written: plan-not-the-record", async () => {
    await lockedN0();
    // Another reviewed plan: the record's, with its path list in another order, so another digest.
    const { file, body } = readPlanFile(readFileSync(w.plan, "utf8"));
    body.paths = [...(body.paths as unknown[])].reverse() as typeof body.paths;
    const other = `${w.plan}.other.json`;
    writeFileSync(
      other,
      `${JSON.stringify({ ...file, ...body, digest: planDigest(body) }, null, 2)}\n`,
    );
    const writes = () => w.apiWrites.filter((x) => x.endsWith("/transition")).length;
    const before = writes();
    const run = await resume(["--keep-upstream", "--plan", other]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("plan-not-the-record");
    expect(writes()).toBe(before);
    expect(w.row()).toMatchObject({ status: "released", last_error: null });
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(false);
  });

  test("a run that pushed N.0.1 and could not record it: other resolutions refuse, the same ones are taken up", async () => {
    await releasedN0();
    failNextTransition((b) => b.to === "patch_synthesized");
    const first = await resume(["--keep-upstream"]);
    expect(first.exitCode, first.all).toBe(3);
    expect(w.row().status).toBe("released");
    const pushed = (
      await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])
    ).trim();
    w.setApiHook(null);
    w.setApiOverride(null);

    const other = await resume(["--take-ours", PATHS.participants]);
    expect(other.exitCode, other.all).toBe(3);
    expect(other.all).toContain("branch-foreign");
    expect(w.row().status).toBe("released");

    const same = await resume(["--keep-upstream"]);
    expect(same.exitCode, same.all).toBe(3);
    expect(same.all).toContain("already this re-pull's N.0.1 commit");
    expect(w.row()).toMatchObject({ status: "patch_synthesized", patch_head_sha: pushed });
  });

  test("N.0.1 is made on main as enrichment left it, not on the N.0.0 merge", async () => {
    await releasedN0();
    const merge = w.row().merge_sha as string;
    const enriched = await enrichMain();
    expect(enriched).not.toBe(merge);
    const run = await resume(["--keep-upstream"]);
    expect(run.exitCode, run.all).toBe(3);
    const row = w.row();
    expect(row.patch_base_sha).toBe(enriched);
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${row.patch_head_sha}^`])).trim()).toBe(
      enriched,
    );
  });

  test("main moved by enrichment and N.0.1's pull request dirty: N.0.1 is made again and pushed with a lease", async () => {
    await patchOpen();
    const before = w.row();
    const moved = await enrichMain();
    Object.assign(patchPull() as object, { mergeableState: "dirty" });
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("again on the new main");
    const head = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])).trim();
    expect(head).not.toBe(before.patch_head_sha);
    expect((await gitIn(w.fx.originRepo, ["rev-parse", `${head}^`])).trim()).toBe(moved);
    expect(w.row()).toMatchObject({
      status: "patch_synthesized",
      patch_head_sha: head,
      patch_base_sha: moved,
    });
    // The same replay, on the new main.
    expect(await oid(head, PATHS.sidecar)).toBe(
      await oid(before.patch_head_sha as string, PATHS.sidecar),
    );
  });

  test("a re-synthesis of N.0.1 pushed and not recorded is recognized by the next run", async () => {
    await patchOpen();
    const before = w.row();
    const moved = await enrichMain();
    Object.assign(patchPull() as object, { mergeableState: "dirty" });
    failNextTransition(
      (b) => (b.fields as Record<string, unknown> | undefined)?.patch_base_sha === moved,
    );
    const first = await resume();
    expect(first.exitCode, first.all).toBe(3);
    const pushed = (
      await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])
    ).trim();
    expect(pushed).not.toBe(before.patch_head_sha);
    expect(w.row()).toMatchObject({ patch_head_sha: before.patch_head_sha });
    w.setApiHook(null);
    w.setApiOverride(null);
    const second = await resume();
    expect(second.all).toContain("pushed by an earlier run");
    expect(w.row()).toMatchObject({
      status: "patch_synthesized",
      patch_head_sha: pushed,
      patch_base_sha: moved,
    });
  });

  test("N.0.1's pull request closed without a merge ends the record patch_declined", async () => {
    await patchOpen();
    Object.assign(patchPull() as object, { state: "closed" });
    const run = await resume();
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("patch_declined");
    expect(w.row().status).toBe("patch_declined");
    expect(await hasRef("refs/tags/v2.0.0")).toBe(true);
  });

  test("N.0.1's merge commit without its trailers last stays patch_merged: merge-trailers", async () => {
    await patchGates();
    w.setMergeMessageSuffix("\n\nCo-authored-by: someone <someone@example.org>");
    const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
    expect(merged.exitCode, merged.all).toBe(0);
    await w.tagMain("2.0.1");
    w.insertVersionRow("2.0.1");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("merge-trailers");
    expect(w.row().status).toBe("patch_merged");
    expect(String(w.row().last_error)).toContain("merge-trailers");
  });

  test("N.0.1 merged with GitHub's button is accepted on evidence, writes no ledger line, and completes", async () => {
    await patchGates();
    // GitHub's own merge button: its message, none of the re-pull's trailers.
    const merge = await w.mergeOnGitHub({ pr: "n1" });
    await w.tagMain("2.0.1");
    w.insertVersionRow("2.0.1");
    const refused = await resume();
    expect(refused.exitCode, refused.all).toBe(3);
    expect(refused.all).toContain("merge-trailers");
    expect(refused.all).toContain("--accept-merge-trailers");
    expect(w.row()).toMatchObject({ status: "patch_merged", patch_merge_sha: merge });
    const reason = "N.0.1 was merged on GitHub's page; its tree was read and is the gated head";
    const run = await resume(["--accept-merge-trailers", reason]);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain(
      `is GitHub's squash merge of pull request #${w.row().patch_pr_number} (release/v2.0.1`,
    );
    expect(run.all).toContain("its tree is the re-pull's gated N.0.1 head");
    expect(run.all).toContain("it does not touch the privacy ledger");
    // The Worker's own reading says the same, in the same words.
    expect(run.all).toContain("; the merge does not touch the privacy ledger;");
    expect(run.all).toContain("needs no line for it, and none was written");
    expect(w.row()).toMatchObject({ status: "complete", last_error: null });
    // Recorded with its reason, and no ledger line: N.0.1's merge does not touch the ledger, and a
    // line naming a commit the proof does not need it for would fail the proof on its own.
    expect(
      w
        .db()
        .query(
          "SELECT pr, merge_sha, reason, attestation_needed, attested_at FROM upstream_repull_merge_acceptances",
        )
        .all(),
    ).toEqual([{ pr: "n1", merge_sha: merge, reason, attestation_needed: 0, attested_at: null }]);
    expect(w.ledgerWrites()).toBe(0);
    expect(await mainHead()).toBe(merge);
  });

  test("N.0.1 merged with a plain merge commit is accepted on the patch columns, writes no ledger line, and completes", async () => {
    await patchGates();
    // GitHub's merge button with the merge method: two parents, main's tip and N.0.1's head.
    const merge = await w.mergeOnGitHub({ pr: "n1", method: "merge" });
    expect(
      (await gitIn(w.fx.originRepo, ["rev-list", "--parents", "-n", "1", merge])).trim().split(" "),
    ).toHaveLength(3);
    await w.tagMain("2.0.1");
    w.insertVersionRow("2.0.1");
    const refused = await resume();
    expect(refused.exitCode, refused.all).toBe(3);
    expect(refused.all).toContain("merge-trailers");
    expect(w.row()).toMatchObject({ status: "patch_merged", patch_merge_sha: merge });
    const reason = "N.0.1 was merged on GitHub's page with the merge method; its tree was read";
    const run = await resume(["--accept-merge-trailers", reason]);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain(
      `is a plain merge commit of pull request #${w.row().patch_pr_number} (release/v2.0.1`,
    );
    expect(run.all).toContain("its tree is the re-pull's gated N.0.1 head");
    expect(w.row()).toMatchObject({ status: "complete", last_error: null });
    expect(
      w
        .db()
        .query(
          "SELECT pr, merge_sha, reason, attestation_needed, attested_at FROM upstream_repull_merge_acceptances",
        )
        .all(),
    ).toEqual([{ pr: "n1", merge_sha: merge, reason, attestation_needed: 0, attested_at: null }]);
    expect(w.ledgerWrites()).toBe(0);
    expect(await mainHead()).toBe(merge);
  });

  test("N.0.1 merged with GitHub's button before its gates is not accepted: tree-anchor-missing", async () => {
    await patchOpen();
    const merge = await w.mergeOnGitHub({ pr: "n1" });
    await w.tagMain("2.0.1");
    w.insertVersionRow("2.0.1");
    const run = await resume([
      "--accept-merge-trailers",
      "N.0.1 was merged on GitHub's page before its screen and gates ran",
    ]);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("tree-anchor-missing");
    expect(w.row()).toMatchObject({ status: "patch_merged", patch_merge_sha: merge });
    expect(w.db().query("SELECT * FROM upstream_repull_merge_acceptances").all()).toEqual([]);
    expect(w.ledgerWrites()).toBe(0);
  });

  test("a tag whose tree is not N.0.1's gated head stays patch_merged: patch-tree-mismatch", async () => {
    await patchGates();
    const merged = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
    expect(merged.exitCode, merged.all).toBe(0);
    // Something that is not enrichment lands on main before the tag.
    await w.commitOnto("refs/heads/main", "code/after.txt", "Not N.0.1's.\n");
    await w.tagMain("2.0.1");
    w.insertVersionRow("2.0.1");
    const run = await resume();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("patch-tree-mismatch");
    expect(run.all).toContain("--accept-tag-tree");
    expect(w.row()).toMatchObject({ status: "patch_merged", patch_tag_sha: null });
    expect(String(w.row().last_error)).toContain("patch-tree-mismatch");
    // Resume again refuses again; with the administrator's reason the release is recorded.
    expect((await resume()).exitCode).toBe(3);
    const accepted = await resume([
      "--accept-tag-tree",
      "code/after.txt was pushed to main by hand and holds no identifier",
    ]);
    expect(accepted.exitCode, accepted.all).toBe(0);
    expect(accepted.all).toContain("its release is recorded on your reason");
    expect(w.row()).toMatchObject({ status: "complete", last_error: null });
    expect(w.row().patch_tag_sha).not.toBeNull();
  });

  test("a record that does not state its corrections is not merged as N.0.1: stage message", async () => {
    await patchGates();
    w.db().run("UPDATE upstream_repulls SET counts = json_set(counts, '$.corrections', 'two')");
    const run = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
    expect(run.exitCode, run.all).not.toBe(0);
    expect(run.all).toContain("does not state how many corrections N.0.1 replays");
    const n1 = w.row().patch_pr_number as number;
    expect(
      w.gh.seen.filter((x) => x.method === "PUT" && x.path.endsWith(`/pulls/${n1}/merge`)),
    ).toEqual([]);
    expect(w.row().status).toBe("patch_gates_clear");
  });

  test("abandon refuses a merged N.0.1 pull request, and a held claim to merge it", async () => {
    await patchGates();
    Object.assign(patchPull() as object, { merged: true, state: "closed" });
    const merged = await abandon();
    expect(merged.exitCode, merged.all).toBe(1);
    expect(merged.all).toContain("pull-request-merged");
    expect(w.row().status).toBe("patch_gates_clear");

    Object.assign(patchPull() as object, { merged: false, state: "open" });
    w.db().run(
      "UPDATE upstream_repulls SET patch_merge_claimed_at = '2026-10-25T00:00:00.000Z', patch_merge_claim_sha = patch_gates_sha",
    );
    const held = await abandon();
    expect(held.exitCode, held.all).toBe(1);
    expect(held.all).toContain("merge-claim-held");
    expect(w.row().status).toBe("patch_gates_clear");
    expect(w.gh.seen.filter((x) => x.method === "PATCH")).toEqual([]);
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(true);
  });

  test("abandon at released keeps a release/v2.0.1 and its pull request that are not this re-pull's", async () => {
    await lockedN0();
    await gitIn(w.fx.originRepo, ["update-ref", "refs/heads/release/v2.0.1", await mainHead()]);
    const foreign = await w.commitOnto("refs/heads/release/v2.0.1", "code/other.txt", "Alice's.\n");
    const n = (w.row().pr_number as number) + 5;
    w.gh.pulls[`${w.fx.datasetId}#${n}`] = {
      sha: foreign,
      headRef: "release/v2.0.1",
      author: "alice",
    };
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(0);
    expect(w.row().status).toBe("patch_declined");
    expect(run.all).toContain("The release branch was kept");
    expect(w.gh.pulls[`${w.fx.datasetId}#${n}`]?.state ?? "open").toBe("open");
    expect((await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])).trim()).toBe(
      foreign,
    );
  });

  test("abandon keeps a release/v2.0.1 it cannot judge: kept-unreadable", async () => {
    await lockedN0();
    await gitIn(w.fx.originRepo, ["update-ref", "refs/heads/release/v2.0.1", await mainHead()]);
    // The record names a merge commit origin does not hold, so N.0.1's commit cannot be read.
    w.db().run(`UPDATE upstream_repulls SET merge_sha = '${"f".repeat(40)}'`);
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("could not be read");
    expect(await hasRef("refs/heads/release/v2.0.1")).toBe(true);
  });

  test("abandon does not delete N.0.1's branch when it moved after it was judged: the delete is leased", async () => {
    await patchOpen();
    let moved = "";
    w.gh.beforeClose = async () => {
      moved = await w.commitOnto("refs/heads/release/v2.0.1", ".nemar/x.json", "{}\n");
    };
    const run = await abandon();
    expect(run.exitCode, run.all).toBe(3);
    expect(run.all).toContain("branch-moved");
    expect((await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.1"])).trim()).toBe(
      moved,
    );
    expect(w.row().status).toBe("patch_synthesized");
  });
});
