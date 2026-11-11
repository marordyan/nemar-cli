# Incident: 53 published dataset repos deleted (nemarDatasets) — 2026-06


> **STATUS: HISTORICAL.** Incident record (2026-06). Retained as forensics; see ADR 0008.
> Current decisions live in [`.context/decisions/`](decisions/README.md); where this document and an ADR disagree, the ADR wins.

Tracked in nemarOrg/nemar-cli#883. Surfaced during the #869 HED backfill.

## What happened
53 **published** datasets (concept DOI + version manifests) had their **GitHub repos
deleted**, while their **D1 records and S3 data fully survive**. The 54th in the set,
`nm099999`, is the disposable E2E test dataset (ignore).

## Forensics (GitHub org Audit Log: action=repo.destroy)
- actor: **the owner's GitHub account**, user_agent: **NEMAR-API** (the backend's own UA string),
  `programmatic_access_type`: classic PAT, **token_id `<token id>`** (scopes incl. `delete_repo`).
- `request_method: delete`, `request_category: api`, repos public.
- Timestamps: ~**03:00:1X UTC daily** (e.g. nm000346 @ 2026-06-26 03:00:15Z,
  nm000237 @ 2026-06-24 03:00:16Z), a few per day spread across the week — STILL ongoing.

## ROOT CAUSE (CONFIRMED 2026-07-01): zombie Workers on the retired personal CF account
- The **production** SCCN Worker is innocent: its `scheduled_cleanup` audit rows show
  `deleted:0, datasets:[]` every day (incl. every deletion date). hallu + mcm crontabs/
  launchd clean. No org GitHub Actions delete repos.
- The deleter was **two leftover NEMAR backend Workers on the retired *personal* Cloudflare
  account** (`<contact email>`, `<account id>`): `nemar-api` +
  `nemar-api-dev`, serving legacy `api.osc.earth/nemar`. Never torn down after the SCCN
  migration (#314). Each had cron `0 3 * * *` (UTC → the `03:00:1X` fingerprint) and the old
  admin PAT (`<token id>`) as `GITHUB_ADMIN_PAT` (→ UA `NEMAR-API`; stopped on PAT rotation).
- Why prod data survived: their delete-cascade destroyed the **shared GitHub** repo (live PAT)
  while the S3 + D1 cascade steps hit the **dead personal account** → prod S3+D1 untouched.
- Ruled out as the exact selector: neither personal D1 still contains nm000192-346 and both
  compute stale-count 0 post-hoc, so the precise per-id selection query couldn't be
  reconstructed after teardown. Immaterial — the deployment is gone.

## RESOLUTION (2026-07-01)
- Removed crons, then deleted all 4 `nemar-*` Workers + both nemar D1s (`nemar-db`,
  `nemar-db-dev`) + both Vectorize indexes from the personal account. `osa-worker`,
  hed-bot/hedit, `wg-mesh`, `printlab`, and the 3 non-nemar R2 buckets left intact.
  Verified `api.osc.earth/nemar/*` → 404, `/osa/` → 200.
- Hardening: 53 repos restored; org `members_can_delete_repositories=false`,
  `default_repository_permission=read`. Documented on #314 (retirement epic) + #883.
- Secret hygiene follow-up: rotate any secret shared with prod that lived on the personal
  account (GitHub PAT already done); track under #885 (Infisical).

## Data safety
All 53 verified RECOVERABLE: each has intact `s3://nemar/<id>/version/*.json` (full
file→annex-key manifest), `objects/`, `archives/v*.zip` (complete snapshot), and `zarr/`.

## Recovery (in order)
1. **STOP it first:** revoke PAT `token_id <token id>` (GitHub → Developer settings).
   Otherwise restored repos are re-deleted at the next 03:00 UTC.
2. **Find the cron:** `ssh hallu "crontab -l"`, `ssh mcm "crontab -l"` — look for a daily
   `0 3 * * *` (or `0 20` PT) script doing `gh repo delete` / these MOABB ids.
3. **Restore the repos** (GitHub deleted-repo restore is UI-only — no API): Org → Settings
   → Deleted repositories → Restore each (90-day window open; preserves git history).
   Fallback for any past-window: reconstruct from `archives/v*.zip` (complete snapshot).
4. Then reset NULL HED rows + re-run `nemar admin hed-sweep` so they classify.

## Affected ids (53 published; all DOI 10.82901/nemar.nm0001xx)
nm000192 nm000194 nm000195 nm000196 nm000197 nm000198 nm000199 nm000200 nm000201
nm000202 nm000203 nm000204 nm000205 nm000206 nm000208 nm000209 nm000210 nm000211
nm000212 nm000213 nm000214 nm000215 nm000216 nm000217 nm000218 nm000219 nm000221
nm000222 nm000223 nm000227 nm000230 nm000231 nm000234 nm000235 nm000236 nm000237
nm000239 nm000240 nm000242 nm000243 nm000244 nm000245 nm000246 nm000247 nm000248
nm000249 nm000270 nm000271 nm000272 nm000342 nm000344 nm000345 nm000346
(content = BCI/MOABB benchmark + 2025 datasets + Castillos VEP; a coherent batch.)
