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

  console.log("Session 32a migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE pending_exit_status AS ENUM ('pending', 'fired', 'cancelled', 'failed');
      EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    console.log("✓ pending_exit_status enum");

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS pending_geofence_exits (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id varchar NOT NULL REFERENCES accounts(id),
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        time_entry_id varchar NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
        exit_detected_at timestamptz NOT NULL DEFAULT now(),
        fires_at timestamptz NOT NULL,
        status pending_exit_status NOT NULL DEFAULT 'pending',
        cancelled_at timestamptz,
        fired_at timestamptz,
        notes text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ pending_geofence_exits table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS pending_geofence_exits_status_fires_at_idx
        ON pending_geofence_exits (status, fires_at)
    `);
    console.log("✓ status_fires_at_idx (cron primary query)");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS pending_geofence_exits_user_project_status_idx
        ON pending_geofence_exits (user_id, project_id, status)
    `);
    console.log("✓ user_project_status_idx (cancellation lookup)");

    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS pending_geofence_exits_one_pending_per_entry
        ON pending_geofence_exits (time_entry_id) WHERE status = 'pending'
    `);
    console.log("✓ one_pending_per_entry partial uniq idx");
  });

  // Verify
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name='pending_geofence_exits'
     ORDER BY ordinal_position
  `);
  console.log("pending_geofence_exits columns:", cols.rows);

  const idx = await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename='pending_geofence_exits' ORDER BY indexname
  `);
  console.log("pending_geofence_exits indexes:", idx.rows);

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
