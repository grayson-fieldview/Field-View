import { db, pool } from "../server/db";
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

  console.log("Session 22 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS timesheet_enabled boolean NOT NULL DEFAULT false
    `);
    console.log("✓ users.timesheet_enabled");

    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS hourly_rate_cents integer
    `);
    console.log("✓ users.hourly_rate_cents");

    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE time_entry_source AS ENUM ('manual', 'auto_geofence', 'edited');
      EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    console.log("✓ time_entry_source enum");

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS time_entries (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id varchar NOT NULL REFERENCES accounts(id),
        user_id varchar NOT NULL REFERENCES users(id),
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        clock_in timestamptz NOT NULL,
        clock_out timestamptz,
        source time_entry_source NOT NULL DEFAULT 'manual',
        notes text,
        rate_cents_snapshot integer,
        edited_by_user_id varchar REFERENCES users(id),
        edited_at timestamptz,
        original_clock_in timestamptz,
        original_clock_out timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ time_entries table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS time_entries_account_user_clock_in_idx
        ON time_entries (account_id, user_id, clock_in DESC)
    `);
    console.log("✓ time_entries_account_user_clock_in_idx");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS time_entries_account_project_clock_in_idx
        ON time_entries (account_id, project_id, clock_in DESC)
    `);
    console.log("✓ time_entries_account_project_clock_in_idx");

    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_active_per_user
        ON time_entries (user_id) WHERE clock_out IS NULL
    `);
    console.log("✓ time_entries_one_active_per_user (partial unique)");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='users' AND column_name IN ('timesheet_enabled','hourly_rate_cents')
     ORDER BY column_name
  `);
  console.log("users new columns:", cols.rows);

  const teCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name='time_entries'
     ORDER BY ordinal_position
  `);
  console.log("time_entries columns:", teCols.rows);

  const idx = await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename='time_entries' ORDER BY indexname
  `);
  console.log("time_entries indexes:", idx.rows);

  await pool.end();
}

run().catch((e) => { console.error(e); process.exit(1); });
