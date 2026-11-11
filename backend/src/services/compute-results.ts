/**
 * What the person is told and given when a job has results (epic #2005 phase A5, #2010; ADR 0118;
 * design section 7, "Results").
 *
 * THE MAIL LINKS TO A PAGE, NEVER TO A FILE. The "results ready" email carries one address,
 * `<APP_BASE_URL>/compute/jobs/<id>`, and nothing that would let a reader of the mail (or of a
 * forwarded copy of it) download a result: a presigned address is a bearer link, so it is made only
 * when the owner asks for it on the page (`mintResultLinks`), never put in a mail and never logged.
 * Nothing the job wrote is in the mail: not its name, its output paths or its log.
 *
 * LINKS ARE BEARER LINKS. `mintResultLinks` makes a 7-day presigned GET for each declared output of a
 * finished, verified job, only for the job's owner (the route checks), only while the objects exist
 * (a head finds them gone: `results_expired`), and at most `RESULT_LINKS_MAX` at a time. Anyone who
 * holds a link can download until it expires, and the terms say so. A link is returned to the owner and
 * never logged, never mailed and never stored.
 */

import { COMPUTE_REFUSAL_STATUS } from "../../../shared/compute-state.js";
import { resultsOutputKey } from "../../../shared/contract/compute-launch.js";
import { escapeHtml } from "../lib/escape.js";
import type { Bindings } from "../types/bindings.js";
import type { ComputeJobRow } from "./compute-jobs.js";
import { COMPUTE_PRESIGN_MAX_SECONDS, computeS3, presignGet } from "./compute-s3.js";
import { readDeclared } from "./compute-verify.js";
import { resolveEmailConfig, sendEmail } from "./email.js";
import { appBase } from "./environment.js";

/** The page a job's results are on: the one address the mail carries. */
export function computeJobPageUrl(env: Pick<Bindings, "APP_BASE_URL">, jobId: string): string {
  return `${appBase(env)}/compute/jobs/${jobId}`;
}

interface MailRecipient {
  email: string | null;
  given_name: string | null;
  account_kind: string | null;
  deleted_at: string | null;
}

/** The columns a notification takes of the person, and nothing else about them. */
export const RESULTS_RECIPIENT_SQL = `SELECT email, given_name, account_kind, deleted_at
  FROM users WHERE id = ?1`;

export type ResultsMailOutcome =
  | "sent"
  | "skipped_pipeline"
  | "skipped_no_account"
  | "skipped_service_account"
  | "skipped_no_address";

/**
 * Tell the person their job's results are ready, with a link to the job's page. Skipped (not failed)
 * for a pipeline job, a job with no account, a service account, a deleted account and an account with
 * no address. Called after the job is `finished` and committed, by the caller that won the
 * transition, inside a try and catch: mail never fails the action, and a failed send is not retried
 * (the page and the owner's own request for links do not depend on it). The send goes through the
 * Worker's one mail path, so the development fence (`DEV_EMAIL_ALLOWLIST`) applies to it unchanged.
 */
export async function sendComputeResultsReadyEmail(
  env: Bindings,
  job: ComputeJobRow,
): Promise<ResultsMailOutcome> {
  if (job.source === "pipeline") return "skipped_pipeline";
  if (job.account_id === null) return "skipped_no_account";
  const person = await env.DB.prepare(RESULTS_RECIPIENT_SQL)
    .bind(job.account_id)
    .first<MailRecipient>();
  if (!person || person.deleted_at !== null) return "skipped_no_address";
  if (person.account_kind === "service") return "skipped_service_account";
  if (typeof person.email !== "string" || person.email.trim() === "") return "skipped_no_address";

  const { fromEmail, replyTo, isDev } = resolveEmailConfig(env);
  const greeting = person.given_name?.trim() ? escapeHtml(person.given_name.trim()) : "there";
  const url = escapeHtml(computeJobPageUrl(env, job.id));
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #16a34a;">Your compute job has finished</h1>

  <p>Hello ${greeting}, the results of your NEMAR compute job are ready.</p>

  <p style="margin: 24px 0;">
    <a href="${url}" style="color: #2563eb; word-break: break-all;">${url}</a>
  </p>

  <p style="color: #666; font-size: 14px;">Sign in and open the page to download your results.
  Results are kept for a limited time, and the page shows how long.</p>

  <p style="color: #999; font-size: 12px; margin-top: 30px;">
    <a href="https://nemar.org" style="color: #999;">NEMAR</a> - Neuroelectromagnetic Data Archive and Tools Resource
  </p>
</body>
</html>
  `;
  await sendEmail(
    person.email,
    "Your NEMAR compute job has finished",
    html,
    env.RESEND_API_KEY ?? "",
    fromEmail,
    replyTo,
    isDev,
    env,
  );
  return "sent";
}

// --- Links ---------------------------------------------------------------------------------------

/** What a result link lives: seven days, S3's and R2's own maximum. */
export const RESULT_LINK_SECONDS = COMPUTE_PRESIGN_MAX_SECONDS;

/** The most links one call makes: a response is a few hundred kilobytes, never a megabyte per thousand. */
export const RESULT_LINKS_MAX = 1000;

export interface ResultLink {
  path: string;
  size: number;
  url: string;
}

export type LinksResult =
  | {
      ok: true;
      links: ResultLink[];
      expires_at: string;
      total: number;
      truncated: boolean;
      /** Pass as `after` to get the next page; null when this page is the last. */
      next_after: string | null;
    }
  | { ok: false; code: "bad_state" | "results_expired" | "compute_disabled"; status: number };

const linkRefusal = (code: "bad_state" | "results_expired" | "compute_disabled"): LinksResult => ({
  ok: false,
  code,
  status: COMPUTE_REFUSAL_STATUS[code],
});

/**
 * 7-day presigned GETs for a finished job's declared outputs, in path order, at most `RESULT_LINKS_MAX`
 * (`truncated` says there are more, `total` how many there are in all, and `next_after` is the cursor of
 * the next page: the last path of this one). `after` starts the page at the first output whose path sorts
 * strictly after it, so every output of a job of any size is reachable in pages (round 1 of #2041: the
 * first 1,000 alone left the rest unreachable). The job must be `finished` and verified
 * (`bad_state` otherwise). The objects must still be there: the declared file and the first output are
 * read with a head through the binding, and one that is gone is `results_expired` (the bucket's rule
 * deletes results after their retention; a renewal never makes a link for an object that is not there).
 * The caller has already checked that the person is the job's owner.
 */
export async function mintResultLinks(
  env: Bindings,
  job: ComputeJobRow,
  after: string | null = null,
): Promise<LinksResult> {
  if (job.state !== "finished" || job.results_verified_at === null) return linkRefusal("bad_state");
  const bucket = env.COMPUTE_RESULTS;
  const s3 = computeS3(env);
  if (!bucket || !s3) return linkRefusal("compute_disabled");
  const declared = await readDeclared(bucket, job.id);
  if (declared.kind !== "ok") return linkRefusal("results_expired");
  const outputs = [...declared.value.outputs].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const remaining = after === null ? outputs : outputs.filter((o) => o.path > after);
  const first = remaining[0];
  if (first !== undefined && (await bucket.head(resultsOutputKey(job.id, first.path))) === null) {
    return linkRefusal("results_expired");
  }
  const chosen = remaining.slice(0, RESULT_LINKS_MAX);
  const links: ResultLink[] = [];
  let expires = "";
  for (const o of chosen) {
    const signed = await presignGet(s3, "results", resultsOutputKey(job.id, o.path), {
      expiresIn: RESULT_LINK_SECONDS,
    });
    links.push({ path: o.path, size: o.size, url: signed.url });
    expires = expires === "" || signed.expires_at < expires ? signed.expires_at : expires;
  }
  if (expires === "") {
    expires = new Date(Date.now() + RESULT_LINK_SECONDS * 1000).toISOString();
  }
  return {
    ok: true,
    links,
    expires_at: expires,
    total: outputs.length,
    truncated: remaining.length > chosen.length,
    next_after: remaining.length > chosen.length ? (chosen[chosen.length - 1]?.path ?? null) : null,
  };
}
