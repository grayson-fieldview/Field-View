import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

// Session 45 — auto-clock-in dwell verification (mirrors S32a pending_geofence_exits).
//
// Adds:
//   • enum  pending_enter_status                   ('pending'|'fired'|'cancelled'|'failed')
//   • table pending_geofence_enters                (debounce queue for auto-clock-in)
//   • idx   pending_geofence_enters_status_fires_at_idx        (cron primary query)
//   • idx   pending_geofence_enters_user_project_status_idx    (cancellation/lookup)
//   • uniq  pending_geofence_enters_one_pending_per_user_project (partial, status='pending')
//
// Structural deviations from pending_geofence_exits worth noting:
//   1. No `time_entry_id` column. There's no active session at enter-time; the
//      partial unique index keys on (user_id, project_id) instead.
//   2. New `created_time_entry_id` column (FK to time_entries ON DELETE SET NULL).
//      Populated when the cron fires the row successfully — gives /auto-undo a
//      precise pointer to the time_entries row this debounce produced, without
//      relying on a fragile timestamp join.
//
// Pure additive migration — does NOT touch pending_geofence_exits, time_entries,
// users, or any existing index. Rollback is a single transactional drop:
//   BEGIN;
//     DROP TABLE IF EXISTS pending_geofence_enters;
//     DROP TYPE  IF EXISTS pending_enter_status;
//   COMMIT;

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

  console.log("Session 45 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE pending_enter_status AS ENUM ('pending', 'fired', 'cancelled', 'failed');
      EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    console.log("✓ pending_enter_status enum");

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS pending_geofence_enters (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id varchar NOT NULL REFERENCES accounts(id),
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        enter_detected_at timestamptz NOT NULL DEFAULT now(),
        fires_at timestamptz NOT NULL,
        status pending_enter_status NOT NULL DEFAULT 'pending',
        cancelled_at timestamptz,
        fired_at timestamptz,
        notes text,
        created_time_entry_id varchar REFERENCES time_entries(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ pending_geofence_enters table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS pending_geofence_enters_status_fires_at_idx
        ON pending_geofence_enters (status, fires_at)
    `);
    console.log("✓ status_fires_at_idx (cron primary query)");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS pending_geofence_enters_user_project_status_idx
        ON pending_geofence_enters (user_id, project_id, status)
    `);
    console.log("✓ user_project_status_idx (cancellation lookup)");

    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS pending_geofence_enters_one_pending_per_user_project
        ON pending_geofence_enters (user_id, project_id) WHERE status = 'pending'
    `);
    console.log("✓ one_pending_per_user_project partial uniq idx");
  });

  // Verify
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name='pending_geofence_enters'
     ORDER BY ordinal_position
  `);
  console.log("pending_geofence_enters columns:", cols.rows);

  const idx = await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename='pending_geofence_enters' ORDER BY indexname
  `);
  console.log("pending_geofence_enters indexes:", idx.rows);

  const enumVals = await db.execute(sql`
    SELECT enumlabel FROM pg_enum
     JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
     WHERE typname='pending_enter_status' ORDER BY enumsortorder
  `);
  console.log("pending_enter_status values:", enumVals.rows);

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
