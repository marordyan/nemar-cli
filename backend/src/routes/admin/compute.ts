/**
 * The compute gateway's owner and admin routes: the policy and the allocation pools (epic #2005
 * phase A2, #2007; ADR 0118). The wire words and the shapes the CLI parses are in
 * shared/contract/compute-admin.ts.
 *
 *   GET  /compute/policy                              owner     the policy in force
 *   PUT  /compute/policy                              owner     the next version (audited)
 *   GET  /compute/pools                               admin     a page of pools
 *   GET  /compute/pools/by-id/:accountId              admin     one account's pools
 *   POST /compute/pools/by-id/:accountId/grant        admin     SU into an account's pool
 *   POST /compute/pools/by-id/:accountId/adjust       admin     a correction of its grant (a charge: owner)
 *   POST /compute/pools/platform/:key/grant           owner     SU into a platform budget
 *   POST /compute/pools/platform/:key/adjust          owner     a correction of a platform budget
 *   GET  /compute/status                              admin     the switches, Tapis, storage (phase A4)
 *
 * Admin-only through the router's middleware; the owner-only routes check the role here, before the
 * body is read, and say so (403, `owner_only`). A grant and an adjustment need an `Idempotency-Key`
 * header, which the ledger stores behind the kind and the actor (`adminKey`), so a repeat of one
 * grants once and a second administrator's same key is their own request. Every refusal is
 * `{ error: <sentence>, code: <word> }`; an invalid body names the fields and never echoes a value.
 * Every write is audited in the same batch as its ledger entry (`compute.policy.set`,
 * `compute.pool.grant`, `compute.pool.adjust`). One request moves at most 2^40 milli-SU
 * (`COMPUTE_REQUEST_MILLI_MAX`), and a total that would pass 2^53 - 1 is a 409 `would_exceed_limit`.
 *
 * INTERIM OWNER RULES, easy to loosen: a correction of an account's CHARGE is the owner's (an
 * administrator may correct a grant). THE `people` BUDGET RECORDS CONSUMPTION ONLY (the owner's
 * decision of 2026-11-04, option A): an adjustment that RAISES the charge of an account's pool
 * raises the `people` budget of the same word with it, and one that LOWERS it moves the person's
 * pool alone and leaves the budget's consumption as it was, so nothing an administrator does to a
 * person's pool gives budget back (the only entries that lower the budget are a job's final
 * settlement and the owner's own correction of the platform budget, which is that pool's own entry
 * and names no budget; the table would take either, and the ledger service refuses a lowering
 * correction that names the budget). A platform pool is its own budget, and a correction of a grant
 * names none. A grant to a deleted account is refused; its pools are still read and its grant
 * corrected, for the record.
 *
 * Nothing here mails anyone, calls GitHub, or is a cron.
 */

import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { type COMPUTE_LEDGER_REASONS, COMPUTE_WORD_RE } from "../../../../shared/compute-state";
import { COMPUTE_POOLS, type ComputePool } from "../../../../shared/contract/compute";
import {
  COMPUTE_ADJUST_TARGETS,
  COMPUTE_ADMIN_ERROR_STATUS,
  COMPUTE_IDEMPOTENCY_KEY_RE,
  COMPUTE_PEOPLE_BUDGET,
  COMPUTE_POOLS_PAGE_MAX,
  COMPUTE_POOL_HOLDER_KINDS,
  COMPUTE_REQUEST_MILLI_MAX,
  type ComputeAdminErrorCode,
  type ComputeLedgerEntryView,
  type ComputePoolView,
  isComputePlatformKey,
} from "../../../../shared/contract/compute-admin";
import {
  ComputeLedgerError,
  type LedgerRow,
  type PoolRow,
  accountPools,
  adjustPool,
  adminKey,
  availableMilli,
  ensurePool,
  findEntryByKey,
  getPool,
  grantPool,
  listPools,
  platformPool,
} from "../../services/compute-ledger";
import {
  ComputePolicyUnreadable,
  type PolicyIssue,
  fieldPath,
  getPolicy,
  getPolicyVersion,
  issuesOf,
  putPolicy,
} from "../../services/compute-policy";
import { computeStatus } from "../../services/compute-status";
import type { Bindings, Variables } from "../../types/bindings";
import type { AdminRouter } from "./shared";

export type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

export const SENTENCES: Record<ComputeAdminErrorCode, string> = {
  invalid_body: "The request body is not valid.",
  invalid_query: "The query is not valid.",
  idempotency_key_required: "An Idempotency-Key header is required.",
  idempotency_key_invalid: "Idempotency-Key is 8 to 100 letters, digits or . _ -.",
  idempotency_conflict: "That Idempotency-Key was used for a different request.",
  owner_only: "Only an owner can do that.",
  account_not_found: "There is no such account.",
  pool_not_found: "There is no such pool.",
  would_go_negative: "That would make a stored total negative, so nothing was written.",
  would_exceed_limit:
    "That would take a stored total past the largest NEMAR keeps, so nothing was written.",
  policy_unreadable: "The stored policy cannot be read, so nothing is served from it.",
  internal: "The compute routes failed unexpectedly.",
  job_not_found: "There is no such job.",
  hold_exists: "That is already under a hold.",
  hold_not_found: "There is no such active hold.",
  target_not_found: "There is nothing like that to hold.",
  acknowledgement_required:
    "This needs the explicit acknowledgement that the report is confirmed not recorded at ACCESS.",
  report_not_found: "There is no failed ACCESS report for that job.",
  invalid_reason: "A reason is 8 to 200 characters with no control character.",
  record_missing: "That record is not there.",
  compute_disabled: "Compute storage is not configured.",
  audit_failed: "The audit row could not be written, so nothing was read.",
};

export function refuse(c: Ctx, code: ComputeAdminErrorCode, error?: string, extra: object = {}) {
  return c.json(
    { error: error ?? SENTENCES[code], code, ...extra },
    COMPUTE_ADMIN_ERROR_STATUS[code],
  );
}

/** A 400 that names the fields and what is wrong with each, never what was sent. */
export function invalidBody(c: Ctx, fields: PolicyIssue[]) {
  const named = fields.slice(0, 5).map((f) => `${f.path || "body"}: ${f.code}`);
  return refuse(c, "invalid_body", `The request body is not valid: ${named.join("; ")}`, {
    fields,
  });
}

/** An error the service threw, as the route answers it; null when it is not one this knows. */
function ledgerRefusal(c: Ctx, err: unknown) {
  if (err instanceof ComputeLedgerError) {
    if (err.code === "idempotency_conflict") return refuse(c, "idempotency_conflict");
    if (err.code === "pool_not_found") return refuse(c, "pool_not_found");
  }
  if (err instanceof ComputePolicyUnreadable) return refuse(c, "policy_unreadable");
  return null;
}

export function fail(c: Ctx, err: unknown) {
  const known = ledgerRefusal(c, err);
  if (known) return known;
  console.error(
    "[admin/compute] unexpected failure:",
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  );
  return refuse(c, "internal");
}

export const requireOwner: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (
  c,
  next,
) => {
  if (c.get("user").role !== "owner") return refuse(c, "owner_only");
  await next();
};

// --- Views -----------------------------------------------------------------------------------

function poolView(row: PoolRow): ComputePoolView {
  return {
    id: row.id,
    holder_kind: row.holder_kind,
    holder_ref: row.holder_ref,
    pool: row.pool,
    granted_milli: row.granted_milli,
    held_milli: row.held_milli,
    charged_milli: row.charged_milli,
    available_milli: availableMilli(row),
    frozen: row.frozen !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function entryView(row: LedgerRow): ComputeLedgerEntryView {
  return {
    id: row.id,
    kind: row.kind,
    pool_id: row.pool_id,
    budget_pool_id: row.budget_pool_id,
    granted_delta_milli: row.granted_delta_milli,
    held_delta_milli: row.held_delta_milli,
    charged_delta_milli: row.charged_delta_milli,
    job_id: row.job_id,
    hold_ref: row.hold_ref,
    reason: row.reason,
    actor_user_id: row.actor_user_id,
    created_at: row.created_at,
  };
}

// --- Bodies ----------------------------------------------------------------------------------

const poolWord = z.enum(COMPUTE_POOLS);
const reasonWord = z.string().regex(COMPUTE_WORD_RE);
/** A whole number of milli-SU, either sign, at most one request's worth. */
const movedMilli = z.number().int().min(-COMPUTE_REQUEST_MILLI_MAX).max(COMPUTE_REQUEST_MILLI_MAX);

const putPolicyBody = z.object({ policy: z.unknown(), note: z.string().optional() }).strict();

const grantBody = z
  .object({
    pool: poolWord,
    amount_milli: z.number().int().min(1).max(COMPUTE_REQUEST_MILLI_MAX),
    reason: reasonWord.optional(),
  })
  .strict();

const adjustBody = z
  .object({
    pool: poolWord,
    target: z.enum(COMPUTE_ADJUST_TARGETS),
    delta_milli: movedMilli.refine((n) => n !== 0, {
      message: "an adjustment of 0 changes nothing",
    }),
    reason: reasonWord,
  })
  .strict();

const listQuery = z.object({
  holder_kind: z.enum(COMPUTE_POOL_HOLDER_KINDS).optional(),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(COMPUTE_POOLS_PAGE_MAX).default(50),
});

/** The body as JSON, or null when it is not JSON (an empty body included). */
export async function readJson(c: Ctx): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** The `Idempotency-Key` header, or the refusal to answer with. */
function idempotencyKey(c: Ctx): { key: string } | { refusal: Response } {
  const raw = c.req.header("Idempotency-Key");
  if (raw === undefined || raw === "") return { refusal: refuse(c, "idempotency_key_required") };
  if (!COMPUTE_IDEMPOTENCY_KEY_RE.test(raw))
    return { refusal: refuse(c, "idempotency_key_invalid") };
  return { key: raw };
}

const ACCOUNT_ID_RE = /^[1-9]\d{0,14}$/;

/** What a grant says when its administrator names no reason. */
const ADMIN_GRANT_REASON: (typeof COMPUTE_LEDGER_REASONS)[number] = "admin_grant";

/**
 * Whether an account is there. A deleted account (its row tombstoned, `deleted_at` set) is not,
 * unless `includeDeleted`: its pools and entries stay and are read and corrected for the record,
 * but nothing new is granted to it.
 */
async function accountExists(db: D1Database, id: number, includeDeleted = false): Promise<boolean> {
  const row = await db
    .prepare("SELECT deleted_at FROM users WHERE id = ?1")
    .bind(id)
    .first<{ deleted_at: string | null }>();
  return row !== null && (includeDeleted || row.deleted_at === null);
}

// --- The grant and the adjustment, for an account's pool and for a platform pool --------------

type Holder = { kind: "account"; id: number } | { kind: "platform"; key: string };

/** Whether a pool is the one a holder's pool of a word is. */
function isPoolOf(pool: PoolRow, holder: Holder, word: ComputePool): boolean {
  return holder.kind === "account"
    ? pool.holder_kind === "account" && pool.holder_ref === String(holder.id) && pool.pool === word
    : pool.holder_kind === "platform" && pool.holder_ref === holder.key && pool.pool === word;
}

/**
 * The pool a write is about, or the refusal: an account's is made on its first grant (`create`), a
 * platform's must exist. A deleted account is not granted to, but its pools are found to be
 * corrected. `prior` is the pool of an earlier entry that holds this request's key: for an account,
 * when it is the pool asked for nothing is made, and when it is not the key is reused for another
 * request and nothing is made either (a platform pool is never made, so there the ledger's own
 * comparison of the request answers).
 */
async function targetPool(
  c: Ctx,
  holder: Holder,
  word: ComputePool,
  create: boolean,
  prior?: PoolRow | null,
): Promise<PoolRow | Response> {
  const db = c.env.DB;
  if (holder.kind === "account") {
    if (!(await accountExists(db, holder.id, !create))) return refuse(c, "account_not_found");
    if (prior !== undefined && prior !== null) {
      return isPoolOf(prior, holder, word) ? prior : refuse(c, "idempotency_conflict");
    }
    if (create) return ensurePool(db, "account", String(holder.id), word);
    const existing = (await accountPools(db, holder.id)).find((p) => p.pool === word);
    return existing ?? refuse(c, "pool_not_found");
  }
  // Only the platform's own budgets are there to find; nothing here makes one.
  const pool = isComputePlatformKey(holder.key) ? await platformPool(db, holder.key, word) : null;
  return pool ?? refuse(c, "pool_not_found");
}

async function grantRoute(c: Ctx, holder: Holder) {
  const idem = idempotencyKey(c);
  if ("refusal" in idem) return idem.refusal;
  const parsed = grantBody.safeParse(await readJson(c));
  if (!parsed.success) return invalidBody(c, issuesOf(parsed.error));
  const actor = c.get("user").id;
  const key = adminKey("grant", actor, idem.key);
  try {
    // The key is looked at FIRST: a key an earlier request used for another pool is a conflict, and
    // answering it must not make the pool this request names.
    const priorEntry = await findEntryByKey(c.env.DB, key);
    const prior = priorEntry ? await getPool(c.env.DB, priorEntry.pool_id) : null;
    const pool = await targetPool(c, holder, parsed.data.pool, true, prior);
    if (pool instanceof Response) return pool;
    const result = await grantPool(c.env.DB, {
      poolId: pool.id,
      amountMilli: parsed.data.amount_milli,
      actorUserId: actor,
      reason: parsed.data.reason ?? ADMIN_GRANT_REASON,
      idempotencyKey: key,
      audit: { userId: actor, action: "compute.pool.grant" },
    });
    if (!result.ok) return refuse(c, result.code);
    const after = (await getPool(c.env.DB, pool.id)) ?? pool;
    return c.json(
      { pool: poolView(after), entry: entryView(result.entry), replayed: result.replayed },
      result.replayed ? 200 : 201,
    );
  } catch (err) {
    return fail(c, err);
  }
}

async function adjustRoute(c: Ctx, holder: Holder) {
  const idem = idempotencyKey(c);
  if ("refusal" in idem) return idem.refusal;
  const parsed = adjustBody.safeParse(await readJson(c));
  if (!parsed.success) return invalidBody(c, issuesOf(parsed.error));
  const body = parsed.data;
  // Interim: an account's charge is corrected by an owner (a platform pool's route is owner-only
  // already). Easy to loosen: this rule says WHO may correct a charge, not what it does to the
  // budget, which is settled (option A): a correction upward still raises the `people` budget and
  // one downward leaves it.
  if (holder.kind === "account" && body.target === "charged" && c.get("user").role !== "owner") {
    return refuse(c, "owner_only");
  }
  try {
    const pool = await targetPool(c, holder, body.pool, false);
    if (pool instanceof Response) return pool;
    // The `people` budget records consumption only: a correction that RAISES what a person or a
    // partner was charged is counted against the budget of the same word, and one that LOWERS it
    // names no budget, so the person's pool falls and the budget's consumption stays. A platform pool
    // is its own budget, and a correction of a grant has none.
    let budgetPoolId: number | null = null;
    if (body.target === "charged" && body.delta_milli > 0 && pool.holder_kind !== "platform") {
      const budget = await platformPool(c.env.DB, COMPUTE_PEOPLE_BUDGET, body.pool);
      if (!budget) throw new Error("the platform people budget is missing");
      budgetPoolId = budget.id;
    }
    const result = await adjustPool(c.env.DB, {
      poolId: pool.id,
      budgetPoolId,
      ...(body.target === "granted"
        ? { grantedDeltaMilli: body.delta_milli }
        : { chargedDeltaMilli: body.delta_milli }),
      actorUserId: c.get("user").id,
      reason: body.reason,
      idempotencyKey: adminKey("adjust", c.get("user").id, idem.key),
      audit: { userId: c.get("user").id, action: "compute.pool.adjust" },
    });
    if (!result.ok) return refuse(c, result.code);
    const after = (await getPool(c.env.DB, pool.id)) ?? pool;
    return c.json(
      { pool: poolView(after), entry: entryView(result.entry), replayed: result.replayed },
      result.replayed ? 200 : 201,
    );
  } catch (err) {
    return fail(c, err);
  }
}

// --- Registration ----------------------------------------------------------------------------

export function registerComputeAdminRoutes(admin: AdminRouter): void {
  // Booleans and fixed words: what the Worker reads of the switches, whether Tapis and the storage are
  // configured, and one token mint and one health call. Read-only, and it never answers a secret.
  admin.get("/compute/status", async (c) => {
    try {
      return c.json(await computeStatus(c.env));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/policy", requireOwner, async (c) => {
    try {
      return c.json(await getPolicy(c.env.DB));
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.put("/compute/policy", requireOwner, async (c) => {
    const parsed = putPolicyBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, issuesOf(parsed.error));
    try {
      const result = await putPolicy(
        c.env.DB,
        c.get("user").id,
        parsed.data.policy,
        parsed.data.note,
        "policy",
      );
      if (!result.ok) {
        if (result.code === "not_owner") return refuse(c, "owner_only");
        if (result.code === "invalid_note") {
          return invalidBody(c, [{ path: "note", code: "invalid_string" }]);
        }
        return invalidBody(c, result.issues);
      }
      const written = await getPolicyVersion(c.env.DB, result.version);
      if (!written) throw new Error("a policy version that was just written could not be read");
      return c.json(written);
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/pools", async (c) => {
    const query = listQuery.safeParse(c.req.query());
    if (!query.success) {
      return refuse(
        c,
        "invalid_query",
        `The query is not valid: ${query.error.issues
          .slice(0, 5)
          .map((i) => `${fieldPath(i.path) || "query"}: ${i.code}`)
          .join("; ")}`,
      );
    }
    try {
      const page = await listPools(c.env.DB, {
        holderKind: query.data.holder_kind,
        after: query.data.after,
        limit: query.data.limit,
      });
      return c.json({ pools: page.pools.map(poolView), next_after: page.nextAfter });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.get("/compute/pools/by-id/:accountId", async (c) => {
    const raw = c.req.param("accountId");
    if (!ACCOUNT_ID_RE.test(raw)) return refuse(c, "account_not_found");
    const id = Number(raw);
    try {
      // Read for the record: a deleted account's pools stay readable.
      if (!(await accountExists(c.env.DB, id, true))) return refuse(c, "account_not_found");
      const pools = await accountPools(c.env.DB, id);
      return c.json({ account_id: id, pools: pools.map(poolView) });
    } catch (err) {
      return fail(c, err);
    }
  });

  admin.post("/compute/pools/by-id/:accountId/grant", async (c) => {
    const raw = c.req.param("accountId");
    if (!ACCOUNT_ID_RE.test(raw)) return refuse(c, "account_not_found");
    return grantRoute(c, { kind: "account", id: Number(raw) });
  });

  admin.post("/compute/pools/by-id/:accountId/adjust", async (c) => {
    const raw = c.req.param("accountId");
    if (!ACCOUNT_ID_RE.test(raw)) return refuse(c, "account_not_found");
    return adjustRoute(c, { kind: "account", id: Number(raw) });
  });

  admin.post("/compute/pools/platform/:key/grant", requireOwner, (c) =>
    grantRoute(c, { kind: "platform", key: c.req.param("key") }),
  );

  admin.post("/compute/pools/platform/:key/adjust", requireOwner, (c) =>
    adjustRoute(c, { kind: "platform", key: c.req.param("key") }),
  );
}
