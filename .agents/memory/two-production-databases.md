---
name: Two "production" databases — Replit's is stale
description: Real prod is AWS RDS behind Vercel; Replit's production DB tool queries a stale abandoned DB
---
Real production for this app is AWS RDS, configured only in Vercel's env (`DATABASE_URL` containing `rds.amazonaws.com`). The Replit "production database" (queried via `executeSql environment:"production"`) is a stale abandoned deployment DB whose data froze around March 2026 — it is NOT what app.field-view.com uses.

**Why:** A schema diff against the Replit prod DB falsely showed months of live features (timesheets, email verification, billing columns) as "missing," leading to wrong publish/grandfathering advice.

**How to apply:** Never diff or reason about real prod using Replit's production DB tools. Prod schema changes go through the established convention: additive script in `script/migrations/` with the RDS guard (`ALLOW_PROD_MIGRATION=yes`, RDS SG IP whitelist, snapshot first), run manually by the user with DATABASE_URL pointed at RDS. The RDS connection string is not available in this workspace.
