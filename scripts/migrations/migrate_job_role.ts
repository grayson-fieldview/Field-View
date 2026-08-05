// Migration: add users.job_role — a PERSON attribute collected during
// onboarding (web + mobile). NOT a permission: users.role
// (admin/standard/restricted) is entirely separate and untouched.
// Nullable, no default, no backfill — existing users legitimately have no
// value and onboarding is skippable.
//
// Run:   npx tsx scripts/migrations/migrate_job_role.ts
// Prod:  ALLOW_PROD_MIGRATION=yes npx tsx scripts/migrations/migrate_job_role.ts

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
      "Set the flag explicitly to confirm this is intentional."
    );
  }

  const host = url.match(/@([^/?]+)/)?.[1] ?? "unknown";
  console.log(`Target DB host: ${host}`);
  console.log(`Mode: ${isRds ? "PRODUCTION RDS" : "Neon dev"}`);
  if (isRds) console.log("⚠️  PROD migration — ALLOW_PROD_MIGRATION=yes confirmed");

  console.log("job_role migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS job_role varchar
    `);
    console.log("✓ users.job_role");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='users' AND column_name='job_role'
  `);
  console.log("users.job_role:", cols.rows);
  if (cols.rows.length !== 1) {
    throw new Error("Verification failed: users.job_role not found after migration");
  }

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
