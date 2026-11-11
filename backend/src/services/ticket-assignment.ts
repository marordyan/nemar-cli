/**
 * Who holds a support ticket, who may see one, and what removing a person does to both
 * (epic #1893 phase 3, #1896).
 *
 * Three things live here because they must agree:
 *   - {@link resolveAssignee}: one function applies a queue's strategy, away windows and the
 *     eligibility rules;
 *   - {@link ticketVisibleTo}: the one SQL predicate the admin API (phase 3b) puts in every read
 *     and write, so a restricted ticket is never reachable by a path that forgot the rule;
 *   - {@link mailReleaseStatements}: what a demotion, a revocation or a soft delete does to a
 *     removed person's tickets, availability and queue references.
 *
 * Access follows the account's role and the per-ticket exclusion, and nothing else. An admin is
 * an admin whether a person or an agent holds the account; no rule below reads the account kind
 * or the username.
 */

export type QueueStrategy = "fixed" | "round_robin" | "pool";

export interface MailQueueRow {
  tag: string;
  restricted: number;
  strategy: QueueStrategy;
  assignee_user_id: number | null;
  backup_user_id: number | null;
  rr_members: string;
  rr_cursor: number;
}

/** What the assignment rules need to know about the ticket being placed. */
export interface AssignmentContext {
  /** An account that must never hold the ticket, even if it is an owner. */
  excludedUserId?: number | null;
  /** The ticket's own restriction, ORed with the queue's: a restricted ticket in an open queue
   *  still goes only to an owner. */
  restricted?: boolean;
}

/**
 * Queues that are restricted whatever their row says, or whether they have one. The row is
 * data an operator can delete or edit; confidentiality must not depend on it, so a ticket for
 * one of these tags is restricted even if the queue row is missing (a missing row assigns
 * nobody, the pool, but never unrestricts).
 */
export const RESTRICTED_TAGS: ReadonlySet<string> = new Set(["security", "conduct"]);

/** Whether tickets of `tag` are restricted, given the queue row if there is one. */
export function isRestrictedQueue(tag: string, row?: { restricted: number } | null): boolean {
  return RESTRICTED_TAGS.has(tag) || row?.restricted === 1;
}

/** The fallback queue's tag: routes any recipient tag that has no queue of its own. */
export const FALLBACK_QUEUE_TAG = "*";

/** The most tries at advancing a round-robin cursor against concurrent claims. */
const CURSOR_ATTEMPTS = 4;

/** Normalised UTC form SQLite's datetime() reads, for comparing away windows. */
function sqlTime(now: Date): string {
  return now.toISOString();
}

/**
 * Whether `userId` may hold a ticket: an approved, live admin or owner; for a restricted
 * ticket an owner only, and never the ticket's excluded account.
 */
export async function isEligibleAssignee(
  db: D1Database,
  userId: number,
  restricted: boolean,
  excludedUserId: number | null | undefined,
): Promise<boolean> {
  if (excludedUserId != null && excludedUserId === userId) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM users
        WHERE id = ? AND status = 'approved' AND deleted_at IS NULL
          AND role IN (${restricted ? "'owner'" : "'admin', 'owner'"})`,
    )
    .bind(userId)
    .first<{ ok: number }>();
  return row !== null;
}

interface AvailabilityRow {
  away: number;
  backup_user_id: number | null;
}

/** Whether the person is inside an away window at `now`, and their backup if one is named. */
async function availability(db: D1Database, userId: number, now: Date): Promise<AvailabilityRow> {
  const row = await db
    .prepare(
      `SELECT backup_user_id,
              CASE WHEN (away_from IS NULL OR datetime(away_from) <= datetime(?1))
                    AND (away_until IS NULL OR datetime(?1) < datetime(away_until))
                    AND (away_from IS NOT NULL OR away_until IS NOT NULL)
                   THEN 1 ELSE 0 END AS away
         FROM mail_availability WHERE user_id = ?2`,
    )
    .bind(sqlTime(now), userId)
    .first<AvailabilityRow>();
  return row ?? { away: 0, backup_user_id: null };
}

/**
 * The person who should hold the ticket in place of `candidate`: the candidate if they are
 * eligible and present; else their named backup (one hop, itself eligible and present); else
 * null.
 */
async function present(
  db: D1Database,
  candidate: number,
  restricted: boolean,
  excluded: number | null | undefined,
  now: Date,
): Promise<number | null> {
  if (!(await isEligibleAssignee(db, candidate, restricted, excluded))) return null;
  const avail = await availability(db, candidate, now);
  if (!avail.away) return candidate;
  const backup = avail.backup_user_id;
  if (backup === null || backup === candidate) return null;
  if (!(await isEligibleAssignee(db, backup, restricted, excluded))) return null;
  return (await availability(db, backup, now)).away ? null : backup;
}

/** Parse the stored JSON list of round-robin members, ignoring anything that is not an id. */
export function parseRrMembers(json: string): number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => Number.isInteger(v));
  } catch {
    return [];
  }
}

/**
 * Pick the assignee for a new ticket in `queueTag`, or null to leave it in the pool.
 *
 * - `fixed`: the queue's assignee, else (ineligible or away without a backup) the queue's
 *   backup, else the pool.
 * - `round_robin`: members in order from the stored cursor; a member who is ineligible or away
 *   with no usable backup is skipped. The cursor moves past the member chosen with a
 *   compare-and-set, so two tickets arriving together do not take the same turn.
 * - `pool`: nobody; any eligible admin takes it.
 *
 * Eligibility (see {@link isEligibleAssignee}) is rechecked here for every candidate, so a
 * stale queue row can never widen access: a restricted queue yields only an owner who is not
 * the excluded account, whatever the row says. A queue that does not exist resolves as `pool`.
 */
export async function resolveAssignee(
  db: D1Database,
  queueTag: string,
  context: AssignmentContext = {},
  now: Date = new Date(),
): Promise<number | null> {
  const queue = await db
    .prepare("SELECT * FROM mail_queues WHERE tag = ?")
    .bind(queueTag)
    .first<MailQueueRow>();
  if (!queue) return null;
  const restricted = isRestrictedQueue(queueTag, queue) || context.restricted === true;
  const excluded = context.excludedUserId ?? null;

  if (queue.strategy === "fixed") {
    for (const candidate of [queue.assignee_user_id, queue.backup_user_id]) {
      if (candidate == null) continue;
      const chosen = await present(db, candidate, restricted, excluded, now);
      if (chosen !== null) return chosen;
    }
    return null;
  }

  if (queue.strategy === "round_robin") {
    let cursor = queue.rr_cursor;
    let members = parseRrMembers(queue.rr_members);
    for (let attempt = 0; attempt < CURSOR_ATTEMPTS; attempt++) {
      if (members.length === 0) return null;
      const start = ((cursor % members.length) + members.length) % members.length;
      let picked: number | null = null;
      let advancedTo = cursor;
      for (let i = 0; i < members.length; i++) {
        const chosen = await present(
          db,
          members[(start + i) % members.length],
          restricted,
          excluded,
          now,
        );
        if (chosen !== null) {
          picked = chosen;
          advancedTo = cursor + i + 1;
          break;
        }
      }
      if (picked === null) return null;
      const moved = await db
        .prepare(
          "UPDATE mail_queues SET rr_cursor = ?, updated_at = datetime('now') WHERE tag = ? AND rr_cursor = ?",
        )
        .bind(advancedTo, queueTag, cursor)
        .run();
      if ((moved.meta?.changes ?? 0) > 0) return picked;
      // Another ticket took a turn first: re-read the queue and choose again.
      const fresh = await db
        .prepare("SELECT rr_cursor, rr_members FROM mail_queues WHERE tag = ?")
        .bind(queueTag)
        .first<{ rr_cursor: number; rr_members: string }>();
      if (!fresh) return null;
      cursor = fresh.rr_cursor;
      members = parseRrMembers(fresh.rr_members);
    }
    return null;
  }

  return null;
}

/** A SQL predicate over a `mail_tickets` alias, with its binds, for splicing into a WHERE. */
export interface TicketVisibility {
  sql: string;
  binds: unknown[];
}

/**
 * The one rule for which tickets `viewer` may read or act on, for the admin API (phase 3b) to
 * put in every query:
 *   - an owner sees every ticket;
 *   - an admin sees every unrestricted ticket;
 *   - anyone else sees none;
 *   - and nobody sees a ticket that names them in `excluded_user_id`, whatever their role.
 * `alias` is the table alias in the caller's query and must be a plain identifier.
 */
export function ticketVisibleTo(
  viewer: { id: number; role: string },
  alias = "mail_tickets",
): TicketVisibility {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("ticketVisibleTo: bad alias");
  const excluded = `(${alias}.excluded_user_id IS NULL OR ${alias}.excluded_user_id <> ?)`;
  if (viewer.role === "owner") return { sql: excluded, binds: [viewer.id] };
  if (viewer.role === "admin") {
    return { sql: `(${alias}.restricted = 0 AND ${excluded})`, binds: [viewer.id] };
  }
  return { sql: "0", binds: [] };
}

/** One statement of {@link mailReleaseStatements}: the caller prepares it on its own D1. */
export interface MailReleaseStatement {
  sql: string;
  binds: unknown[];
}

/**
 * What ending a person's admin standing does to the mail tables, as statements for the caller
 * to run in the SAME batch as its own revocation statements (AGENTS.md, "Revocation cascades,
 * always"). Three callers, and the count is the point: a role demotion
 * (`POST /admin/users/:username/role`), `finalizeRevocation`, and `tombstoneUserCascade`
 * (which both the owner-only soft delete and the scheduled sweep run, so it counts once). A
 * fourth path that removes an admin needs these statements too.
 *
 * The compute counterpart, `computeReleaseStatements` (`services/compute-release.ts`, epic #2005
 * phase A8), has TWO callers, not three: `finalizeRevocation` and `tombstoneUserCascade`. A role
 * demotion is deliberately not one of them: compute is not an admin's standing, so a demoted person
 * keeps their jobs and their pools, while the tickets, the away window and the queue references above
 * exist only for admins. A new path that ends a WHOLE ACCOUNT needs both sets; one that only removes
 * an admin needs this set alone.
 *
 * The person's `mail_ticket_reads` markers (migration 0110) go with the rest under `scope: "all"`;
 * every caller named above gets them through this function, so none needs its own line.
 *
 * `scope: "all"` is for a person who is no longer an admin (a demotion to member, a revoke, a
 * delete). `scope: "restricted"` is for an owner demoted to admin, who still works ordinary
 * tickets: only restricted tickets and restricted-queue references are dropped.
 *
 * Their open tickets (any status but closed) go back to the pool, unassigned, with an
 * `unassigned` event on each; re-resolving through the queue would need the strategy code, which
 * is not SQL, so the pool is the deliberate answer and the next admin claims or is assigned.
 * Closed tickets keep their last assignee as history.
 */
export function mailReleaseStatements(
  userId: number,
  scope: "all" | "restricted",
): MailReleaseStatement[] {
  const all = scope === "all";
  const ticketScope = all ? "" : " AND restricted = 1";
  const queueScope = all ? "" : " AND restricted = 1";
  const statements: MailReleaseStatement[] = [
    {
      sql: `INSERT INTO mail_ticket_events (ticket_id, kind, actor_user_id, detail)
            SELECT id, 'unassigned', NULL, '{"reason":"assignee_removed"}' FROM mail_tickets
             WHERE assignee_user_id = ? AND status <> 'closed'${ticketScope}`,
      binds: [userId],
    },
    {
      sql: `UPDATE mail_tickets SET assignee_user_id = NULL, updated_at = datetime('now')
             WHERE assignee_user_id = ? AND status <> 'closed'${ticketScope}`,
      binds: [userId],
    },
    {
      sql: `UPDATE mail_queues SET assignee_user_id = NULL, updated_at = datetime('now')
             WHERE assignee_user_id = ?${queueScope}`,
      binds: [userId],
    },
    {
      sql: `UPDATE mail_queues SET backup_user_id = NULL, updated_at = datetime('now')
             WHERE backup_user_id = ?${queueScope}`,
      binds: [userId],
    },
    // Not scoped: an escalation owner must be an owner, so it is cleared whenever the person stops
    // being one, including an owner demoted to admin (scope "restricted").
    {
      sql: `UPDATE mail_queues SET escalation_user_id = NULL, updated_at = datetime('now')
             WHERE escalation_user_id = ?`,
      binds: [userId],
    },
    {
      sql: `UPDATE mail_queues
               SET rr_members = (SELECT json_group_array(value) FROM json_each(mail_queues.rr_members)
                                  WHERE value <> ?),
                   updated_at = datetime('now')
             WHERE json_valid(mail_queues.rr_members)
               AND EXISTS (SELECT 1 FROM json_each(mail_queues.rr_members) WHERE value = ?)${queueScope}`,
      binds: [userId, userId],
    },
  ];
  if (all) {
    statements.push(
      { sql: "DELETE FROM mail_availability WHERE user_id = ?", binds: [userId] },
      // The person's read markers (migration 0110): they are not an admin any more.
      { sql: "DELETE FROM mail_ticket_reads WHERE user_id = ?", binds: [userId] },
      {
        sql: "UPDATE mail_availability SET backup_user_id = NULL, updated_at = datetime('now') WHERE backup_user_id = ?",
        binds: [userId],
      },
    );
  }
  return statements;
}

/**
 * Statements only the soft delete (tombstone) runs: the person's account link on tickets is
 * erased, because the account is gone. The requester's address stays on the ticket as the
 * correspondence record. A demotion or a revocation keeps the account, so keeps the link.
 */
export function mailTombstoneStatements(userId: number): MailReleaseStatement[] {
  return [
    {
      sql: "UPDATE mail_tickets SET requester_user_id = NULL WHERE requester_user_id = ?",
      binds: [userId],
    },
  ];
}
