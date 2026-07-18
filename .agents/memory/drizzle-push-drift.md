---
name: Drizzle db:push drift
description: Why npm run db:push cannot be used in this repo and what to do instead
---
`npm run db:push` hangs on an interactive prompt because the dev database has legacy `report_templates` columns (type/content/findings/recommendations) that drizzle wants to rename/drop (template_config rename question).
**Why:** pre-existing schema drift that was intentionally never reconciled; answering the prompt could destroy legacy data.
**How to apply:** when adding tables/enums/indexes, generate the DDL yourself and run it with raw `psql "$DATABASE_URL"`. Keep `shared/schema.ts` as source of truth for types only.
