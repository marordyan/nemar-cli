/**
 * The compute gateway's owner policy (epic #2005 phase A2, #2007; ADR 0118).
 *
 * The policy is one immutable row per version in `compute_policy` (migration 0114); the current
 * policy is the highest version, and no row means `DEFAULT_COMPUTE_POLICY` of
 * shared/contract/compute.ts. Everything the owner sets without a deploy lives in it.
 *
 * THE RULES, each one deliberate:
 *  - The write path is `putPolicy` and nothing else. It checks the strict `ComputePolicySchema`
 *    (a mistyped or unknown key is refused, never stripped), checks in the same statement that the
 *    account is an owner (so no caller, whatever route it came through, writes a version without
 *    one), and writes the version and its audit row in one batch, so a version never exists
 *    unaudited. The audit row is the shape of the event (who and which version), never the policy.
 *  - The read path is strict too, and fails closed. `getPolicy` parses a stored row with the same
 *    strict schema and throws `ComputePolicyUnreadable` for one it cannot parse; it never falls
 *    back to the default for a row that exists (the default applies only when there is no row at
 *    all), because a corrupt row read as the default would quietly reopen limits the owner closed.
 *    A new policy key is therefore added as OPTIONAL, so an older stored row keeps parsing.
 *  - Nothing here is a response schema. The CLI parses the route's answer with the open schema of
 *    shared/contract/compute-admin.ts; this file never serves a client's parse.
 *  - An issue names a field and a zod code and never a value. A field name that is not a plain
 *    identifier (a key of the partner-client record the caller chose) is `?`.
 */

import type { z } from "zod";
import {
  type ComputePolicy,
  ComputePolicySchema,
  DEFAULT_COMPUTE_POLICY,
} from "../../../shared/contract/compute.js";
import { ACTIVE_ACCOUNT_STATUSES } from "./account-tier.js";

/** The longest stored policy, in characters; the table refuses more. */
export const POLICY_MAX_CHARS = 65536;

/** The longest note. */
export const POLICY_NOTE_MAX = 500;

/** A stored policy row that the strict schema cannot parse: the read path fails closed (HTTP 503). */
export class ComputePolicyUnreadable extends Error {
  constructor(readonly version: number) {
    super(`compute policy version ${version} cannot be read`);
    this.name = "ComputePolicyUnreadable";
  }
}

/** A policy as the routes answer: which version, who set it, and when. */
export interface PolicyView {
  /** NULL while no version has been set: the policy is then the default. */
  version: number | null;
  is_default: boolean;
  policy: ComputePolicy;
  set_by: number | null;
  note: string | null;
  created_at: string | null;
}

interface PolicyRow {
  version: number;
  policy_json: string;
  set_by: number;
  note: string | null;
  created_at: string;
}

export const POLICY_CURRENT_SQL = `SELECT version, policy_json, set_by, note, created_at
  FROM compute_policy ORDER BY version DESC LIMIT 1`;

export const POLICY_BY_VERSION_SQL = `SELECT version, policy_json, set_by, note, created_at
  FROM compute_policy WHERE version = ?1`;

function view(row: PolicyRow): PolicyView {
  let parsed: z.SafeParseReturnType<unknown, ComputePolicy>;
  try {
    parsed = ComputePolicySchema.safeParse(JSON.parse(row.policy_json));
  } catch {
    throw new ComputePolicyUnreadable(row.version);
  }
  if (!parsed.success) throw new ComputePolicyUnreadable(row.version);
  return {
    version: row.version,
    is_default: false,
    policy: parsed.data,
    set_by: row.set_by,
    note: row.note,
    created_at: row.created_at,
  };
}

/**
 * The policy in force: the highest stored version, parsed strictly, or the default when no version
 * has ever been set. A stored row that cannot be parsed throws `ComputePolicyUnreadable`; the
 * default is never a stand-in for it.
 */
export async function getPolicy(db: D1Database): Promise<PolicyView> {
  const row = await db.prepare(POLICY_CURRENT_SQL).first<PolicyRow>();
  if (!row) {
    return {
      version: null,
      is_default: true,
      policy: DEFAULT_COMPUTE_POLICY,
      set_by: null,
      note: null,
      created_at: null,
    };
  }
  return view(row);
}

/** One stored version, parsed strictly (the answer of a write names the version it made). */
export async function getPolicyVersion(
  db: D1Database,
  version: number,
): Promise<PolicyView | null> {
  const row = await db.prepare(POLICY_BY_VERSION_SQL).bind(version).first<PolicyRow>();
  return row ? view(row) : null;
}

/**
 * The new version, only if `?3` is an owner's id: `?1` the policy JSON, `?2` the note. The role is
 * read in this statement, with the account not deleted and in an active status, so a caller that
 * skipped the route's check, and an owner whose account was ended, still cannot write a version.
 */
export const POLICY_INSERT_SQL = `INSERT INTO compute_policy (policy_json, set_by, note)
  SELECT ?1, u.id, ?2 FROM users u
   WHERE u.id = ?3 AND u.role = 'owner' AND u.deleted_at IS NULL
     AND u.status IN (${ACTIVE_ACCOUNT_STATUSES.map((s) => `'${s}'`).join(", ")})`;

/** The audit row of that version, written only if the insert before it was: who and which version. */
export const AUDIT_POLICY_SET_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT ?1, 'compute.policy.set', 'compute_policy', CAST(p.version AS TEXT),
         json_object('version', p.version)
    FROM compute_policy p WHERE p.version = last_insert_rowid() AND changes() > 0`;

/** One thing wrong with a policy: where (a path of plain field names) and zod's code, never the value. */
export interface PolicyIssue {
  path: string;
  code: string;
  /** Only for a rule the schema words itself (`custom`), which holds no caller text. */
  message?: string;
}

/** A zod path as field names; anything that is not a plain identifier is `?`. */
export function fieldPath(path: ReadonlyArray<string | number>): string {
  return path
    .map((s) => (typeof s === "number" || /^[A-Za-z0-9_]{1,40}$/.test(s) ? String(s) : "?"))
    .join(".");
}

/** A path under a prefix: the prefix alone for a problem at the root, and `prefix.path` otherwise. */
const under = (prefix: string | undefined, path: string): string =>
  [prefix ?? "", path].filter((p) => p !== "").join(".");

/**
 * The issues of a zod failure, without a value, at most 20, each path under `prefix` when one is
 * given (a route names a field of its body: `policy.defaultGrantMilli.cpu`). The one copy.
 */
export function issuesOf(error: z.ZodError, prefix?: string): PolicyIssue[] {
  return error.issues.slice(0, 20).map((i) => ({
    path: under(prefix, fieldPath(i.path)),
    code: i.code,
    ...(i.code === "custom" ? { message: i.message } : {}),
  }));
}

export type PutPolicyResult =
  | { ok: true; version: number }
  | { ok: false; code: "not_owner" }
  | { ok: false; code: "invalid_note" }
  | { ok: false; code: "invalid_policy"; issues: PolicyIssue[] };

/**
 * Write the next version of the policy, as `ownerId`, with an optional note. The input is checked
 * with the strict schema; an invalid one names the fields (under `issuePrefix` when one is given)
 * and writes nothing. The version and its audit row are one batch. A caller that is not an owner
 * (`not_owner`), or whose account was deleted or is not active, writes nothing either.
 */
export async function putPolicy(
  db: D1Database,
  ownerId: number,
  input: unknown,
  note?: string | null,
  issuePrefix?: string,
): Promise<PutPolicyResult> {
  const text = note ?? null;
  if (
    text !== null &&
    (typeof text !== "string" || text.length < 1 || text.length > POLICY_NOTE_MAX)
  ) {
    return { ok: false, code: "invalid_note" };
  }
  const parsed = ComputePolicySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "invalid_policy", issues: issuesOf(parsed.error, issuePrefix) };
  }
  const json = JSON.stringify(parsed.data);
  if (json.length > POLICY_MAX_CHARS) {
    return {
      ok: false,
      code: "invalid_policy",
      issues: [{ path: under(issuePrefix, ""), code: "too_large" }],
    };
  }
  const results = await db.batch([
    db.prepare(POLICY_INSERT_SQL).bind(json, text, ownerId),
    db.prepare(AUDIT_POLICY_SET_SQL).bind(ownerId),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return { ok: false, code: "not_owner" };
  const version = results[0]?.meta?.last_row_id;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new Error("a policy version that was just written has no id");
  }
  return { ok: true, version };
}
