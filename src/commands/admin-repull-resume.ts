/**
 * The steps of `nemar admin repull` past the open pull request (ADR 0111, decisions 2, 3, 6 and 7;
 * epic #1046 phase 6):
 *
 *   nemar admin repull status <id>   what the record says (`lib/repull/status.ts`)
 *   nemar admin repull resume <id>   the head, main, the identifier screen and the gates, a held
 *                                    claim resolved from GitHub, and after the merge the release,
 *                                    the lock of what the copy wrote, N.0.1 and the end of the
 *                                    record (`lib/repull/resume.ts`, `lib/repull/release.ts`,
 *                                    `lib/repull/patch-turn.ts`); it never merges
 *
 * Registered on `repullCommand` by `admin-repull.ts`. The shared argument parsers and the
 * report of a refusal are exported for the merge command.
 */

import { Command, InvalidArgumentError } from "commander";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../../shared/publication-limits.js";
import { failMessage, requireSignedIn, say } from "../lib/admin-command.js";
import { ApiError, errorDetail } from "../lib/api/errors.js";
import { listRepullScreens, listRepulls } from "../lib/api/repull.js";
import { confirm } from "../lib/confirm.js";
import { markReportedExit, markUsageExit } from "../lib/debug-log.js";
import { ExecuteRefused } from "../lib/repull/execute/verify-plan.js";
import { type ResumeResult, resumeRepull } from "../lib/repull/resume.js";
import { olderLine, statusLines } from "../lib/repull/status.js";
import { AUTOMATIC_HELP, automaticFinish } from "./admin-repull-automatic.js";

/** Exit code of a step that stopped resumable or waits: run it again. */
export const EXIT_WAITING = 3;

/** A dataset id typed on the command line, or null after saying so (exit 1). */
export function datasetArg(raw: string, json: boolean): string | null {
  if (/^[a-z]{2}\d{6}$/.test(raw)) return raw;
  failMessage(`"${raw}" is not a dataset id (like on004362).`, { json, answered: true });
  markUsageExit();
  return null;
}

/** `--wait-minutes`: a whole number of minutes, 0 to 120. */
export function parseMinutes(value: string): number {
  const n = Number(value);
  if (!/^\d{1,3}$/.test(value.trim()) || n > 120) {
    throw new InvalidArgumentError("a whole number of minutes from 0 to 120 is required.");
  }
  return n;
}

/** `--acknowledge-identifier-screen`: the publication path's length rule (ADR 0086). */
export function parseReason(value: string): string {
  const reason = value.trim();
  if (reason.length < ACKNOWLEDGMENT_MIN_LENGTH || reason.length > ACKNOWLEDGMENT_MAX_LENGTH) {
    throw new InvalidArgumentError(
      `a reason of ${ACKNOWLEDGMENT_MIN_LENGTH} to ${ACKNOWLEDGMENT_MAX_LENGTH} characters is required.`,
    );
  }
  return reason;
}

/** Report a refusal of a step past the open pull request: exit 3 when it left a record behind. */
export function reportRefused(err: unknown, json: boolean, out: (line: string) => void): void {
  if (err instanceof ExecuteRefused) {
    failMessage(`Refused (${err.code}): ${err.message}`, { json, answered: true });
    for (const line of err.lines) out(line);
    if (err.resumable) process.exitCode = EXIT_WAITING;
    return;
  }
  failMessage(`Failed: ${errorDetail(err)}`, { json, answered: err instanceof ApiError });
}

export const statusCommand = new Command("status")
  .argument("<datasetId>")
  .description("Show the record of a dataset's re-pulls: state, pull request, screen, what is next")
  .option("--json", "Print the records and the newest one's screens as JSON")
  .action(async (datasetId: string, options: { json?: boolean }) => {
    const json = options.json === true;
    if (!requireSignedIn(json)) return;
    if (!datasetArg(datasetId, json)) return;
    try {
      const { repulls } = await listRepulls({ dataset: datasetId, limit: 5 });
      const newest = repulls[0];
      const screens = newest ? await listRepullScreens(newest.id) : null;
      if (json) {
        console.log(JSON.stringify({ repulls, screens }, null, 2));
        return;
      }
      if (!newest) {
        console.log(`${datasetId} has no re-pull on record.`);
        return;
      }
      for (const line of statusLines(newest, screens?.exempt ? null : (screens?.screens ?? []))) {
        console.log(line);
      }
      if (repulls.length > 1) {
        console.log("Earlier attempts:");
        for (const row of repulls.slice(1)) console.log(olderLine(row));
      }
    } catch (err) {
      failMessage(`Could not read the re-pulls of ${datasetId}: ${errorDetail(err)}`, {
        json,
        answered: err instanceof ApiError,
      });
    }
  });

const RESUME_HELP = `
Takes a dataset's open re-pull up where it stopped, past its open pull request, on this machine
with your own GitHub token (GH_TOKEN, else \`gh auth token\`). It never merges.

  pr_open      reads the pull request: one found merged is recorded (the Worker reads it on
               GitHub), one closed unmerged ends the record abandoned; a head moved by
               enrichment is recorded, any other is refused (head-foreign). NEMAR's main must be
               the base or have moved by enrichment only; when it moved and GitHub reports the
               pull request dirty or behind, or enrichment changed a path outside .nemar/ and
               .github/, the commit is made again on the new main and pushed with a lease (asked
               first unless --yes). Then the identifier screen of the head is
               dispatched (when none exists or it produced no verdict), and once it passes and
               GitHub reports the pull request clean, the gates are recorded: gates_clear. On a
               re-pull you opened, unstable because BIDS validation failed and no other check
               or status fails is recorded too (both read with your token), and that pull
               request merges with --bids-failure-reason, or without it once the validation
               passes.
  gates_clear  a held claim to merge is resolved from GitHub: a merge is recorded, and a claim
               GitHub says did not merge expires once it is 30 minutes old. A main enrichment
               moved outside .nemar/ and .github/ since the gates (the merge refuses it,
               merge-main-moved) takes the record back to pr_open, where the commit is made again.
  merged       the merge commit GitHub wrote must end with the re-pull commit's two trailers
               (merge-trailers otherwise: a merge made outside NEMAR's gate, with GitHub's own
               button, say). It waits for the tag v<N.0.0> and the version row (its DOI) first.
               Then --accept-merge-trailers "<reason>" accepts a merge without its trailers, on a
               re-pull you opened, only once this run and then the Worker have read that it is
               the squash merge, or GitHub's plain merge commit (two parents, the merged head
               second), of the record's own pull request, at its recorded head (or one
               enrichment moved), on the record's base (or one enrichment moved), with the
               re-pull's tree outside .nemar/ and .github/; the Worker records your reason and,
               when the merge appended the delta scrub's ledger line, appends to the ledger on
               main one line naming the merge, which the privacy ledger's fresh-clone proof reads.
               Then it compares the tagged tree with the re-pull's commit and records the release
               (the Worker reads the tag, the version row and that line itself). N.0.1's tagged tree must be its gated head
               outside .nemar/ and .github/ (patch-tree-mismatch otherwise): read the difference,
               then --accept-tag-tree "<reason>" records the release.
  released     locks the objects the copy and the uploads wrote (and no other object under the
               dataset's prefix), with the ambient AWS credentials reading the staging manifest
               that lists them; only once every one is locked is the count recorded. Then:
               with no correction and no conflict in the plan, the record is complete; with
               conflicts, it waits for your decision (--take-ours, --keep-upstream: a conflict
               you do not name stays on upstream's side only with --keep-upstream); otherwise
               N.0.1 is made from the reviewed plan (--plan, else the plan's default path):
               NEMAR's side of each correction, and of each conflict you resolved to it,
               replayed onto the new main (nothing is scrubbed or copied), release/v<N.0.1>
               pushed and its pull request opened (asked first unless --yes): patch_synthesized.
  patch_*      N.0.1's pull request takes the same steps as N.0.0's (the screen, the gates, the
               release), and the record is complete once v<N.0.1> is released.

A screen that asks for a person is acknowledged with --acknowledge-identifier-screen "<reason>",
after you read it with \`nemar admin repull status <id>\`; a direct identifier cannot be.
A conflict is named as the plan names it: a path, or dataset_description.json#<Key> for one key
of the description. The README family is replayed as a unit.

Exit codes:
  0  ready to merge (gates_clear, patch_gates_clear), complete, or released with a record that
     does not say how many corrections and conflicts its plan has (it is not completed, and it
     blocks the dataset's next re-pull until \`nemar admin repull abandon <id>\` ends it).
  3  waiting (for the screen, GitHub, a person, your decision on conflicts) after
     --wait-minutes, or stopped with why recorded on the record; run resume again.
  1  refused before anything was written, nothing to resume, or the record ended (abandoned,
     patch_declined).

${AUTOMATIC_HELP} With it, resume is a finish: it takes up only the automatic re-pull
its dispatch names, only once it has merged, and walks it to complete.`;

/** `--take-ours`: repeated, each a conflict the plan lists. */
function collectTakeOurs(value: string, previous: string[]): string[] {
  if (value.trim() === "")
    throw new InvalidArgumentError("a path, or dataset_description.json#<Key>.");
  return [...previous, value];
}

export const resumeCommand = new Command("resume")
  .argument("<datasetId>")
  .description(
    "Take an open re-pull on past its pull request: screen, gates, then the release and the lock (never merges)",
  )
  .option(
    "--wait-minutes <n>",
    "How long to wait for the screen and GitHub (0 reads once)",
    parseMinutes,
    10,
  )
  .option(
    "--acknowledge-identifier-screen <reason>",
    "Your reason for a screen verdict that asks for a person (ADR 0086)",
    parseReason,
  )
  .option(
    "--plan <file>",
    "The reviewed plan file N.0.1 is made from (default: the plan's own path)",
  )
  .option(
    "--take-ours <conflict>",
    "Resolve a conflict the plan lists to NEMAR's side in N.0.1 (repeatable)",
    collectTakeOurs,
    [] as string[],
  )
  .option("--keep-upstream", "Leave every conflict the plan lists on upstream's side")
  .option(
    "--accept-tag-tree <reason>",
    "Your reason for recording N.0.1's release when its tag's tree is not its gated head (patch-tree-mismatch)",
    parseReason,
  )
  .option(
    "--accept-merge-trailers <reason>",
    "Your reason for accepting a merge made without the re-pull's trailers (merge-trailers), once it is shown to be this re-pull's own",
    parseReason,
  )
  .option("-y, --yes", "Do not ask before pushing (a re-synthesis, or N.0.1)")
  .option("--json", "Print the record as JSON")
  .option("--automatic-dispatch <id>", "The central workflow's finish of a merged re-pull")
  .addHelpText("after", RESUME_HELP)
  .action(
    async (
      datasetId: string,
      options: {
        waitMinutes: number;
        acknowledgeIdentifierScreen?: string;
        plan?: string;
        takeOurs: string[];
        keepUpstream?: boolean;
        acceptTagTree?: string;
        acceptMergeTrailers?: string;
        yes?: boolean;
        json?: boolean;
        automaticDispatch?: string;
      },
    ) => {
      if (options.automaticDispatch !== undefined) {
        await automaticFinish(options.automaticDispatch, datasetId, options);
        return;
      }
      const json = options.json === true;
      const out = say(json);
      if (!requireSignedIn(json)) return;
      if (!datasetArg(datasetId, json)) return;
      let result: ResumeResult;
      try {
        result = await resumeRepull({
          datasetId,
          waitMinutes: options.waitMinutes,
          ...(options.acknowledgeIdentifierScreen
            ? { acknowledgment: options.acknowledgeIdentifierScreen }
            : {}),
          ...(options.plan ? { plan: options.plan } : {}),
          takeOurs: options.takeOurs,
          keepUpstream: options.keepUpstream === true,
          ...(options.acceptTagTree ? { acceptTagTree: options.acceptTagTree } : {}),
          ...(options.acceptMergeTrailers
            ? { acceptMergeTrailers: options.acceptMergeTrailers }
            : {}),
          ...(options.yes
            ? {}
            : {
                confirm: async (question: string) =>
                  (await confirm(question, { yes: false })) === "confirmed",
              }),
          out: (line) => out(line),
          ...(process.env.NEMAR_REPULL_POLL_MS && /^\d+$/.test(process.env.NEMAR_REPULL_POLL_MS)
            ? { pollMs: Number(process.env.NEMAR_REPULL_POLL_MS) }
            : {}),
        });
      } catch (err) {
        reportRefused(err, json, out);
        return;
      }
      const { row } = result;
      if (json) {
        console.log(
          JSON.stringify(
            {
              repull: row,
              outcome: result.outcome,
              waiting_for: result.waitingFor ?? null,
              // `ready` over a failed BIDS validation: the merge needs --bids-failure-reason.
              bids_failure: result.bidsFailure === true,
            },
            null,
            2,
          ),
        );
      }
      switch (result.outcome) {
        case "ready":
          out(
            result.bidsFailure
              ? `Ready to merge over the failed BIDS validation: nemar admin repull merge ${datasetId} --bids-failure-reason "<reason>"`
              : `Ready to merge: nemar admin repull merge ${datasetId}`,
          );
          break;
        case "released":
          out(`Re-pull #${row?.id} of ${datasetId} is released.`);
          break;
        case "waiting":
          out(`Waiting for ${result.waitingFor}. Run resume again.`);
          process.exitCode = EXIT_WAITING;
          markReportedExit();
          break;
        case "ended":
          process.exitCode = 1;
          markReportedExit();
          break;
        case "nothing":
          out(
            row
              ? `${datasetId} has no open re-pull; the newest, #${row.id}, is ${row.status}.`
              : `${datasetId} has no re-pull on record.`,
          );
          process.exitCode = 1;
          markReportedExit();
          break;
        default:
          out(`Re-pull #${row?.id} of ${datasetId} is ${row?.status}.`);
      }
    },
  );
