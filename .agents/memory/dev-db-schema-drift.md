---
name: Dev Neon DB lags shared/schema.ts
description: The Replit dev database is not migrated in lockstep with schema changes; expect missing columns/tables when testing older flows.
---

# Dev DB schema drift

The dev (Neon) database regularly lags `shared/schema.ts`: whole tables
(`api_keys`) and columns (`accounts.industry`, `reports.account_id`,
`reports.share_token`, …) have been missing while prod already had them.

**Why:** migrations are applied to prod (Vercel/RDS) during deploys but nobody
runs them against the Replit dev DB, so registration/login/report flows break
in dev with "column … does not exist" even though the code is correct.

**How to apply:** when a dev-only 500 mentions a missing column/relation,
diff `information_schema.columns` against `shared/schema.ts` and `ALTER TABLE
ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` in the dev DB — this
is dev-env repair, not a prod migration. Don't "fix" the code to match the
stale dev DB.
