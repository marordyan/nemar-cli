/**
 * User routes
 *
 * Handles authenticated user operations.
 *
 * `POST /me/upload-access/request` (ADR 0042, #1253) lives here rather than in
 * auth-web.ts for one reason: this router mounts `authMiddleware`, which
 * accepts BOTH the CLI's bearer token and the dashboard's session cookie
 * (`__Host-nemar_session`, or the legacy `nemar_session`), and the request has to
 * be makeable from either. The auth-web routes
 * mount `webSessionMiddleware` and are cookie-only by design.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { AccountKind, AccountStatus } from "../../../shared/contract/user.js";
import { auditLogStatement } from "../db/audit-log";
import { flag } from "../db/flag";
import { authMiddleware } from "../middleware/auth";
import {
  getAdminEmailsForCategory,
  isAdminNotificationAllowed,
  resolveEmailConfig,
  sendUploadAccessRequestEmail,
} from "../services/email";
import { validateGitHubUsername } from "../services/github";
import { getDatasetsToken } from "../services/github-auth";
import { profileGapsForRow } from "../services/profile-gaps";
import {
  ALREADY_APPROVED_REFUSAL,
  GITHUB_UNAVAILABLE_REFUSAL,
  WHY_MAX_CHARS,
  checkUploadAccessRequest,
  githubUnverifiedRefusal,
} from "../services/upload-access";
import type { Bindings, Variables } from "../types/bindings";

export const userRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All user routes require authentication
userRoutes.use("*", authMiddleware);

/**
 * GET /users/me - Get current authenticated user info
 */
userRoutes.get("/me", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  // Get additional user details including sandbox status
  const userDetails = await db
    .prepare(
      `
    SELECT
      status,
      account_kind,
      created_at,
      approved_at,
      email_verified,
      orcid_verified,
      given_name,
      family_name,
      username,
      github_username,
      city,
      country,
      username_auto_assigned,
      sandbox_completed,
      sandbox_completed_at,
      sandbox_dataset_id,
      service_access,
      (SELECT COUNT(*) FROM datasets WHERE owner_user_id = ? AND is_sandbox = 0) as dataset_count
    FROM users
    WHERE id = ?
  `,
    )
    .bind(user.id, user.id)
    .first<{
      // Closed by migration 0001's CHECK constraint (shared/contract/user.ts).
      status: AccountStatus;
      // Read from the ROW rather than reused from the credential, for the same
      // reason `username` below is: it is what exempts a `service`/`test`
      // account from the `orcid_verified` gap (#1271, ADR 0048), and the gap
      // list has to describe the account as it is now. Closed by migration
      // 0082's CHECK constraint.
      account_kind: AccountKind;
      created_at: string;
      approved_at: string;
      email_verified: number;
      orcid_verified: number;
      given_name: string | null;
      family_name: string | null;
      // Read from the ROW rather than reused from the credential (#1268): the
      // gap list must describe the account as it is now, and `AuthUser` types
      // both of these non-null because a token-bearing CLI account has them --
      // which is exactly the assumption a NULL-username web row breaks.
      username: string | null;
      github_username: string | null;
      city: string | null;
      country: string | null;
      username_auto_assigned: number;
      sandbox_completed: number;
      sandbox_completed_at: string | null;
      sandbox_dataset_id: string | null;
      service_access: number;
      dataset_count: number;
    }>();

  // Get token info
  const tokenInfo = await db
    .prepare(
      `
    SELECT api_key_prefix, created_at, last_used_at
    FROM tokens
    WHERE user_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `,
    )
    .bind(user.id)
    .first<{
      api_key_prefix: string;
      created_at: string;
      last_used_at: string | null;
    }>();

  return c.json({
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      github_username: user.github_username,
      role: user.role,
      orcid: user.orcid || null,
      // Added for `nemar auth profile` (#1254): the command's whole job is to
      // say what each identifier currently IS and where to change it, and
      // "email: ada@lab.org" with no word on whether that inbox is confirmed
      // is the half-answer that sends someone to support. Purely additive --
      // the contract marks all five optional, so an older CLI is unaffected.
      status: userDetails?.status,
      email_verified: !!userDetails?.email_verified,
      orcid_verified: !!userDetails?.orcid_verified,
      given_name: userDetails?.given_name ?? null,
      family_name: userDetails?.family_name ?? null,
      created_at: userDetails?.created_at,
      approved_at: userDetails?.approved_at,
      dataset_count: userDetails?.dataset_count || 0,
      sandbox_completed: !!userDetails?.sandbox_completed,
      sandbox_completed_at: userDetails?.sandbox_completed_at,
      sandbox_dataset_id: userDetails?.sandbox_dataset_id,
      // Tiered access (website ADR 0010): admin-granted permission to upload/compute.
      service_access: !!userDetails?.service_access,
      // What this account is still missing, computed by the SAME function the
      // upload-access preconditions use (#1268, ADR 0045) -- so `nemar auth
      // status` can never list a different set of fields from the one a request
      // is refused for. An empty array is a real answer; the key is absent only
      // when the row itself could not be read.
      profile_gaps: userDetails ? profileGapsForRow(userDetails) : undefined,
      username_auto_assigned: flag(userDetails?.username_auto_assigned),
      // What this account IS (epic #1272 phase 4, #1284; ADR 0048). Absent
      // when the row could not be read, matching every other field above.
      account_kind: userDetails?.account_kind,
    },
    token: tokenInfo
      ? {
          prefix: tokenInfo.api_key_prefix,
          created_at: tokenInfo.created_at,
          last_used_at: tokenInfo.last_used_at,
        }
      : null,
  });
});

/**
 * GET /users/me/datasets - List datasets owned by current user
 */
userRoutes.get("/me/datasets", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;

  const datasets = await db
    .prepare(
      `
    SELECT
      dataset_id,
      name,
      description,
      status,
      github_repo,
      concept_doi,
      created_at,
      updated_at
    FROM datasets
    WHERE owner_user_id = ?
    ORDER BY created_at DESC
  `,
    )
    .bind(user.id)
    .all();

  return c.json({ datasets: datasets.results });
});

// ---------------------------------------------------------------
// POST /users/me/upload-access/request  (ADR 0042, #1253)
// ---------------------------------------------------------------

/** The columns the admin review card is built from. */
interface UploadRequestRow {
  id: number;
  username: string | null;
  email: string;
  given_name: string | null;
  family_name: string | null;
  city: string | null;
  country: string | null;
  affiliation: string | null;
  orcid: string | null;
  /** The why text as stored. REQUIRED, not optional: a retry reads the card's
   *  body from here, and an optional field let the route omit the column from
   *  its SELECT and mail an empty review card without the compiler noticing. */
  description: string | null;
}

/**
 * Mail the admins one review card and stamp `upload_access_notified_at` when
 * at least one of them received it.
 *
 * Shared by the first request and by a retry, so the two cannot drift on what
 * "notified" means. Never throws: the request row has already committed by the
 * time this runs on either path, and failing the response would tell a user
 * their request was not recorded when it was. What it does instead is REPORT,
 * so the caller can say `email_sent: false` and so the next call re-sends.
 *
 * `whyText` is passed on the first request (the text is not on the row yet
 * when the caller reads it) and read back from `description` on a retry.
 */
async function notifyAdminsOfUploadRequest(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  row: UploadRequestRow,
  githubLogin: string,
  whyText?: string,
): Promise<{ delivered: number; attempted: number }> {
  const db = c.env.DB;
  try {
    const adminEmails = await getAdminEmailsForCategory(db, "user_approval", c.env);
    if (adminEmails.length === 0) {
      // getAdminEmailsForCategory already logged (and returned []) when the
      // production-only fence applied -- that is expected on a dev worker,
      // not a misconfiguration, so only escalate to console.error when the
      // fence was open and the admin table itself came back empty.
      if (isAdminNotificationAllowed(c.env)) {
        // Not an error the USER can act on, so the request still succeeds -- but
        // it is a misconfiguration an operator must see, and `admins_notified: 0`
        // makes it visible in the response as well as the log.
        console.error(
          `[upload-access] no admin recipients for user_approval; request from id=${row.id} stored but nobody was told`,
        );
      }
      return { delivered: 0, attempted: 0 };
    }

    const { fromEmail, replyTo, isDev } = resolveEmailConfig(c.env);
    const outcome = await sendUploadAccessRequestEmail(
      adminEmails,
      {
        id: row.id,
        username: (row.username ?? "").trim(),
        given_name: (row.given_name ?? "").trim(),
        family_name: (row.family_name ?? "").trim(),
        email: row.email,
        orcid: row.orcid,
        github_username: githubLogin,
        city: (row.city ?? "").trim(),
        country: (row.country ?? "").trim(),
        affiliation: row.affiliation,
        why: whyText ?? (row.description ?? "").trim(),
      },
      c.env.RESEND_API_KEY,
      fromEmail,
      replyTo,
      isDev,
      c.env,
    );

    if (outcome.delivered > 0) {
      // Conditional on it still being NULL so two concurrent retries stamp one
      // timestamp, and so a stamp is never moved forward by a later re-send.
      await db
        .prepare(
          `UPDATE users
              SET upload_access_notified_at = datetime('now')
            WHERE id = ? AND upload_access_notified_at IS NULL`,
        )
        .bind(row.id)
        .run();
    } else {
      console.error(
        `[upload-access] no admin received the request from id=${row.id} (${outcome.attempted} attempted, ${outcome.failures.length} failed); it will be re-sent on the next attempt`,
      );
    }
    return { delivered: outcome.delivered, attempted: outcome.attempted };
  } catch (emailErr) {
    // Reaching here is the admin-lookup or the config read failing, not a
    // send: sendUploadAccessRequestEmail catches per recipient. Left unstamped
    // so the next call retries.
    console.error("[upload-access] admin notification failed", emailErr);
    return { delivered: 0, attempted: 0 };
  }
}

/**
 * Bounds only. The 20-character minimum, the trim, and every account-state
 * precondition live in services/upload-access.ts so they answer with the typed
 * `{ error, message, missing }` shape the website renders -- zValidator's own
 * 400 body is a zod issue tree, which no client of this endpoint reads.
 * `WHY_MAX_CHARS * 4` is a transport bound, not the rule: it stops a megabyte
 * of text at the door while leaving the real limit to the one place that
 * reports it properly.
 */
const uploadAccessRequestSchema = z.object({
  why: z
    .string()
    .max(WHY_MAX_CHARS * 4)
    .optional()
    .default(""),
});

/**
 * Ask for upload access, once (ADR 0042).
 *
 * The account row carries the whole request: `upload_access_requested_at` is
 * when, `description` is why, and `service_access` is whether an admin has
 * since answered. There is no request table because there is no second
 * request -- approval closes this one permanently and revocation is an admin
 * action with its own audit trail, not a re-opening.
 *
 * Three outcomes:
 *   201 + `{ ok: true }`                the request was opened and mailed
 *   200 + `{ already_requested: true }` one is already open; NOT re-mailed
 *   409 `already_approved`              the grant is already held
 *
 * Idempotency is enforced by the conditional UPDATE, not by the SELECT above
 * it: `WHERE upload_access_requested_at IS NULL` means exactly one of two
 * concurrent requests writes the stamp, and `changes` is what decides which
 * one sends the email. A pre-check alone would let a double-clicked button mail
 * every admin twice.
 */
userRoutes.post(
  "/me/upload-access/request",
  zValidator("json", uploadAccessRequestSchema),
  async (c) => {
    const authUser = c.get("user");
    const db = c.env.DB;
    const { why } = c.req.valid("json");
    const text = why.trim();

    try {
      const row = await db
        .prepare(
          `SELECT id, username, email, given_name, family_name, github_username,
                  city, country, affiliation, orcid, description, account_kind,
                  email_verified, orcid_verified, service_access,
                  upload_access_requested_at, upload_access_notified_at
             FROM users
            WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(authUser.id)
        .first<{
          id: number;
          username: string | null;
          email: string;
          given_name: string | null;
          family_name: string | null;
          github_username: string | null;
          city: string | null;
          country: string | null;
          affiliation: string | null;
          orcid: string | null;
          description: string | null;
          // Both read for the profile check: an unverified iD is a gap, and a
          // `service`/`test` row is exempt from it (#1271, ADR 0048).
          account_kind: AccountKind;
          email_verified: number;
          orcid_verified: number;
          service_access: number;
          upload_access_requested_at: string | null;
          upload_access_notified_at: string | null;
        }>();

      if (!row) {
        // The credential resolved but the row is gone (tombstoned mid-request).
        return c.json({ error: "Account not found" }, 403);
      }

      // Checked on `service_access` rather than on `status`: the grant is the
      // thing being requested, and the gate that would refuse an upload reads
      // that column too (services/upload-gate.ts). ADR 0040 makes the two
      // equivalent, but only one of them is what this endpoint is about.
      if (row.service_access === 1) {
        return c.json(ALREADY_APPROVED_REFUSAL, 409);
      }

      // Answered BEFORE the preconditions: an open request is already on an
      // admin's desk, and telling its owner to go fix their profile would
      // imply the request had failed.
      //
      // ...unless nobody was actually told. `upload_access_notified_at` is
      // NULL when every admin send failed, and short-circuiting on that row
      // would turn request-once into request-never: the stamp says answered,
      // the guard refuses to act, and no admin ever sees it. So a repeat call
      // in that state RETRIES the notification. The GitHub check is not
      // re-run -- the request already passed it, and this path exists to be
      // called repeatedly.
      if (row.upload_access_requested_at) {
        if (row.upload_access_notified_at) {
          return c.json({
            ok: true,
            already_requested: true,
            requested_at: row.upload_access_requested_at,
            email_sent: true,
            admins_notified: null,
          });
        }
        const retry = await notifyAdminsOfUploadRequest(c, row, (row.github_username ?? "").trim());
        return c.json({
          ok: true,
          already_requested: true,
          requested_at: row.upload_access_requested_at,
          email_sent: retry.delivered > 0,
          admins_notified: retry.delivered,
        });
      }

      const refusal = checkUploadAccessRequest(row, text);
      if (refusal) return c.json(refusal, 400);

      // Past the pure checks every required field is non-empty, which is what
      // lets the rest of this handler treat them as strings.
      const githubHandle = (row.github_username ?? "").trim();

      // Existence only -- not ownership. Nobody proves they control the
      // account here; what the review needs is that the handle an admin will
      // add as a repository collaborator actually resolves.
      //
      // #1052: the lookup has three answers and only a 404 is one about the
      // account. Reporting a GitHub outage as `github_username_unverified`
      // would tell the requester their handle does not exist and send them to
      // Settings to change a field that is already right -- and the request
      // would keep failing until GitHub recovered, with nothing on screen
      // saying so.
      const githubLookup = await validateGitHubUsername(
        githubHandle,
        await getDatasetsToken(c.env),
      );
      if (githubLookup.status === "unavailable") {
        console.error(`[upload-access] GitHub lookup unavailable: ${githubLookup.detail}`);
        return c.json(GITHUB_UNAVAILABLE_REFUSAL, 503);
      }
      if (githubLookup.status === "not_found") {
        return c.json(githubUnverifiedRefusal(githubHandle), 400);
      }
      const githubUser = githubLookup.user;

      const stamped = await db
        .prepare(
          `UPDATE users
              SET upload_access_requested_at = datetime('now'),
                  description = ?,
                  updated_at = datetime('now')
            WHERE id = ?
              AND upload_access_requested_at IS NULL
              AND service_access = 0
              AND deleted_at IS NULL`,
        )
        .bind(text, row.id)
        .run();

      if ((stamped.meta?.changes ?? 0) === 0) {
        // Lost the race to a concurrent request (or to an approval landing in
        // the same instant). Either way one request is open or answered and
        // this call must not mail a second copy.
        const current = await db
          .prepare("SELECT upload_access_requested_at FROM users WHERE id = ?")
          .bind(row.id)
          .first<{ upload_access_requested_at: string | null }>();
        return c.json({
          ok: true,
          already_requested: true,
          requested_at: current?.upload_access_requested_at ?? null,
        });
      }

      // Outside the write, and non-fatal, for the reason applyEmailVerification
      // records: the request HAS landed by now, and rolling it back over a
      // failed audit insert is the worse outcome. Loud in the log instead.
      try {
        await auditLogStatement(db, {
          userId: row.id,
          action: "upload_access_requested",
          resourceType: "user",
          resourceId: String(row.id),
          // The text itself is on the row and in the admin's inbox; the audit
          // row carries the shape of the event, not a second copy of the prose
          // (ADR 0036).
          details: JSON.stringify({
            via: c.get("authMethod") === "cookie" ? "web" : "cli",
            why_chars: text.length,
          }),
        }).run();
      } catch (auditErr) {
        console.error(
          `AUDIT GAP: upload_access_requested row not written for id=${row.id} (the request DID land):`,
          auditErr,
        );
      }

      // Admins only. The requester gets no mail here: they already know they
      // asked, and the answer they are waiting for is the upload-access-granted
      // mail that approval sends (ADR 0040 phase 2).
      //
      // The request is stored either way -- it is visible in
      // `nemar admin users --awaiting-approval` whether or not the mail went --
      // but the caller is TOLD which happened, and an undelivered one is
      // retried by the next call rather than silently sitting there.
      const notified = await notifyAdminsOfUploadRequest(c, row, githubUser.login, text);

      return c.json(
        {
          ok: true,
          already_requested: false,
          email_sent: notified.delivered > 0,
          admins_notified: notified.delivered,
        },
        201,
      );
    } catch (err) {
      console.error("[users] /me/upload-access/request failed", err);
      return c.json({ error: "Failed to submit upload access request" }, 500);
    }
  },
);
