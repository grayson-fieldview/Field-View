// Session 45 — Customer.io integration schema.
//
// Adds the columns needed for Phase 1+ Customer.io person-attribute sync
// and idempotent completion-event detection:
//
//   users.signup_referrer       — Document.referrer captured at /api/register
//   users.signup_utm_source     — ?utm_source captured at /api/register
//   users.signup_utm_medium     — ?utm_medium captured at /api/register
//   users.signup_utm_campaign   — ?utm_campaign captured at /api/register
//     (Phase 1 ships the columns; Phase 3 ships the frontend capture.)
//   users.last_active_at        — touched by server/middleware/touch-last-active.ts
//     on every authenticated request, throttled to 1 write/user/60s.
//   checklists.completed_at     — set ONCE when the last unanswered item
//     transitions to answered. Drives the idempotent checklist_completed
//     CIO event (never re-fires on re-edit).
//   tasks.completed_at          — set ONCE on status NULL→done transition.
//     Drives the idempotent task_completed CIO event.
//
// Run sequence (per project policy — see replit.md):
//   1. Snapshot RDS
//   2. Whitelist Replit egress IP on the RDS security group
//   3. ALLOW_PROD_MIGRATION=yes DATABASE_URL=<prod> npx tsx \
//        script/migrations/migrate_session45_customerio_integration.ts
//   4. Verify schema in TablePlus
//   5. Promote Vercel deploy
//   6. Remove Replit IP from RDS SG
//
// All ALTER statements use IF NOT EXISTS so reruns are safe.

import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

async function run() {
  const url = process.env.DATABASE_URL ?? "";
  const isRds = url.includes("rds.amazonaws.com");
  const isNeon = url.includes("neon.tech");

  if (!isRds && !isNeon) {
    throw new Error("DATABASE_URL must be RDS or Neon. Refusing to run.");
  }

  if (isRds && process.env.ALLOW_PROD_MIGRATION !== "yes") {
    throw new Error(
      "Refusing to run against prod RDS without ALLOW_PROD_MIGRATION=yes. " +
        "Set the flag explicitly to confirm this is intentional.",
    );
  }

  const host = url.match(/@([^/?]+)/)?.[1] ?? "unknown";
  console.log(`Target DB host: ${host}`);
  console.log(`Mode: ${isRds ? "PRODUCTION RDS" : "Neon dev"}`);
  if (isRds) console.log("⚠️  PROD migration — ALLOW_PROD_MIGRATION=yes confirmed");

  console.log("Session 45 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_referrer varchar`);
    console.log("✓ users.signup_referrer");

    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_utm_source varchar`);
    console.log("✓ users.signup_utm_source");

    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_utm_medium varchar`);
    console.log("✓ users.signup_utm_medium");

    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_utm_campaign varchar`);
    console.log("✓ users.signup_utm_campaign");

    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at timestamp`);
    console.log("✓ users.last_active_at");

    await tx.execute(sql`ALTER TABLE checklists ADD COLUMN IF NOT EXISTS completed_at timestamp`);
    console.log("✓ checklists.completed_at");

    await tx.execute(sql`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at timestamp`);
    console.log("✓ tasks.completed_at");
  });

  console.log("\nTransaction committed. Verifying...");
  const userCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name='users'
       AND column_name IN ('signup_referrer','signup_utm_source','signup_utm_medium','signup_utm_campaign','last_active_at')
     ORDER BY column_name
  `);
  console.log("users new columns:", userCols.rows);

  const checklistCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name='checklists' AND column_name='completed_at'
  `);
  console.log("checklists.completed_at:", checklistCols.rows);

  const taskCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name='tasks' AND column_name='completed_at'
  `);
  console.log("tasks.completed_at:", taskCols.rows);

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
