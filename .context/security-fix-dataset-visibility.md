# Security Fix: Dataset Visibility and Privacy Filtering

> **Decision recorded:** [ADR 0017 - Dataset visibility is enforced server-side](decisions/0017-dataset-visibility-is-filtered-server-side.md).

**Date:** 2026-01-27
**Issue:** All users could see all datasets, including private datasets they don't own
**Severity:** Critical - Privacy/Security Vulnerability

## Problem

The `nemar dataset list` command showed ALL datasets (including private ones) to ALL users, regardless of authentication or ownership. This was a critical security issue where users could see:
- Private datasets belonging to other users
- Dataset names, descriptions, owners, and metadata
- Information that should be restricted

### Example of the Issue

```bash
$ nemar whoami
Authenticated
  Username: <user B>
  Email:    <contact email>

$ nemar dataset list
Datasets (12):  # Shows ALL datasets, including private ones owned by others!

ID          Name                            Owner        Status
---------------------------------------------------------------
nm099999    E2E Test Dataset                <owner>      active
nm000151    R3_mini_L100_bdf                <user B>     active
nm000150    BIDS_test                       <user B>     active
nm000149    My second NEMAR EEG Dataset...  <user C>     active  # SHOULD NOT SEE
nm000148    My NEMAR EEG Dataset ds0026...  <user C>     active  # SHOULD NOT SEE
nm000147    BIDS_test                       <owner>      active  # SHOULD NOT SEE
...
```

## Root Cause

1. **Missing Database Column**: The `datasets` table had no `visibility` column to track public/private state
2. **No Backend Filtering**: The `/datasets` list endpoint returned all datasets without checking:
   - Dataset visibility
   - User authentication status
   - User permissions (owner vs non-owner)

## Solution

### 1. Database Migration (0006_dataset_visibility.sql)

Added a `visibility` column to the `datasets` table:

```sql
ALTER TABLE datasets ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
  CHECK (visibility IN ('private', 'public'));

CREATE INDEX IF NOT EXISTS idx_datasets_visibility ON datasets(visibility);
```

**Key decisions:**
- Default to `'private'` for all existing and new datasets (safe default)
- Admins can manually change visibility to `'public'` when appropriate
- Independent from `status` (lifecycle state) - a dataset can be `active+private`, `active+public`, etc.

### 2. Backend Filtering (datasets.ts)

Updated the `GET /datasets` endpoint with proper visibility filtering:

**For `--mine` flag (user's own datasets):**
- Requires authentication
- Shows only datasets owned by the authenticated user
- Includes all visibility levels (private, public, sandbox)

**For public catalog (no `--mine` flag):**
- **Unauthenticated users**: Only public datasets
- **Authenticated non-admin users**: Only public datasets (use `--mine` to see your private datasets)
- **Admin users**: All datasets (public + private from all users)
- Always excludes sandbox datasets from public listings

```typescript
if (mine) {
  if (!user) {
    return c.json({ error: "Authentication required to view your datasets" }, 401);
  }
  query += " AND d.owner_user_id = ?";
  params.push(user.id);
} else {
  // Exclude sandbox from public catalog
  query += " AND (d.is_sandbox = 0 OR d.is_sandbox IS NULL)";

  // Filter by visibility
  if (!user) {
    query += " AND d.visibility = 'public'";  // Unauthenticated
  } else if (!user.is_admin) {
    query += " AND d.visibility = 'public'";  // Non-admin
  }
  // Admin: no additional filter (sees all)
}
```

### 3. Publication Workflow Updates (admin.ts)

Updated both publication workflow endpoints to set `visibility = 'public'` when making a dataset public:

1. **Automated publication workflow** (`POST /admin/datasets/:id/publish/approve`):
   - When `repo_public` step completes, also updates database visibility

2. **Manual visibility change** (`PATCH /admin/datasets/:id/visibility`):
   - Updates both GitHub repo visibility AND database visibility column

```typescript
// After making GitHub repo public
await db
  .prepare("UPDATE datasets SET visibility = 'public' WHERE dataset_id = ?")
  .bind(datasetId)
  .run();
```

### 4. TypeScript Type Update (api.ts)

Updated the `Dataset` interface to include the new field:

```typescript
export interface Dataset {
  id: number;
  dataset_id: string;
  name: string;
  description: string | null;
  owner_username: string;
  status: string;
  visibility: "public" | "private";  // NEW
  github_repo: string | null;
  concept_doi: string | null;
  created_at: string;
}
```

## Testing Checklist

After deploying the migration and code changes:

### 1. Database Migration
- [ ] Run migration 0006 on production D1 database
- [ ] Verify all existing datasets have `visibility = 'private'`
- [ ] Verify index was created on `visibility` column

### 2. Backend Testing
- [ ] Test unauthenticated `nemar dataset list` - should only show public datasets
- [ ] Test authenticated non-admin `nemar dataset list` - should only show public datasets
- [ ] Test authenticated non-admin `nemar dataset list --mine` - should show only their datasets (private + public)
- [ ] Test admin `nemar dataset list` - should show all datasets
- [ ] Test admin `nemar dataset list --mine` - should show only their datasets

### 3. Publication Workflow
- [ ] Create a private dataset
- [ ] Verify `nemar dataset list` (as non-owner) does NOT show it
- [ ] Run publication workflow to make it public
- [ ] Verify database `visibility` column was updated to `'public'`
- [ ] Verify `nemar dataset list` (as non-owner) now SHOWS it

### 4. Manual Visibility Change
- [ ] Use `nemar admin dataset visibility <id> public` to make a dataset public
- [ ] Verify both GitHub repo and database are updated
- [ ] Use `nemar admin dataset visibility <id> private` to make it private again
- [ ] Verify both are updated

## Impact

**Before fix:**
- All users could see all private datasets
- Serious privacy and security vulnerability

**After fix:**
- Users can only see:
  - Their own datasets (with `--mine`)
  - Public datasets (without `--mine`)
- Admins can see all datasets
- Default to private for new datasets
- Proper isolation between users

## Files Modified

1. `backend/src/db/migrations/0006_dataset_visibility.sql` (NEW)
2. `backend/src/routes/datasets.ts` (list endpoint filtering)
3. `backend/src/routes/admin.ts` (publication workflow + manual visibility change)
4. `src/lib/api.ts` (TypeScript type)

## Migration Instructions

1. Deploy migration:
   ```bash
   # Apply migration to D1 database
   wrangler d1 migrations apply nemar-db --remote
   ```

2. Deploy backend:
   ```bash
   cd backend
   npm run deploy
   ```

3. Verify existing datasets are private:
   ```bash
   wrangler d1 execute nemar-db --remote --command "SELECT dataset_id, visibility FROM datasets LIMIT 10"
   ```

4. Test with non-admin user that they can't see private datasets

## Notes

- All existing datasets will default to `visibility = 'private'`
- Admins must explicitly make datasets public via:
  - Publication workflow (`nemar admin dataset publish approve <id>`)
  - Manual command (`nemar admin dataset visibility <id> public`)
- The `status` field (active/archived/deleted) is independent from `visibility`
- Sandbox datasets are always excluded from public catalog regardless of visibility
