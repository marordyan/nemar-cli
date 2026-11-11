# ADR 0008: All Cloudflare infrastructure lives in the SCCN account

**Status:** accepted
**Date:** 2026-05-18
**Owner:** Seyed Yahya Shirazi

## Context

NEMAR's Workers, D1, and Pages projects were originally created under a personal Cloudflare account (`neuromechanist`). Production infrastructure for a shared research resource cannot depend on an individual's personal account for billing, access, or continuity.

## Decision

All Cloudflare resources run in the **SCCN** account. Every operation goes through `npx cfman wrangler --account sccn` with `backend/wrangler-sccn.toml`. The personal account is retired.

## Consequences

- Continuity and billing sit with the institution rather than a person.
- `CLOUDFLARE_API_TOKEN` must be unset when using cfman, or it overrides the account selection silently.
- D1 and migration commands additionally need `CLOUDFLARE_ACCOUNT_ID` passed explicitly, otherwise they fail with an opaque auth 10000.
- The root `wrangler.jsonc` refers to a **different** worker; using it by accident deploys the wrong thing.
- **Retiring an account is not the same as tearing it down.** Zombie Workers left running on the retired personal account deleted 53 production dataset repos daily for an extended period before anyone noticed (#883). Decommissioning must include deleting the old workers and revoking their tokens, not merely ceasing to deploy to them.

## Alternatives considered

- **Keep the personal account for dev, SCCN for prod:** two accounts to keep in sync and exactly the split that produced the #883 incident. Rejected.

## Receipts

- `.context/` infra notes; `https://docs.nemar.org/admin/operations/systems-inventory/` and `.rules/environments.md` (formerly AGENTS.md "Backend Infrastructure")
- #883 — zombie personal-account workers destroying prod repos, resolved 2026-07-01
