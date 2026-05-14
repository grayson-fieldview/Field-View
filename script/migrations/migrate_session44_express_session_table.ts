import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

// S44: Provision the express-session backing table on prod RDS.
//
// connect-pg-simple is already wired in server/replit_integrations/auth/
// replitAuth.ts with `tableName: "sessions"` and
// `createTableIfMissing: false`. If the underlying table is missing in
// prod RDS, every session write silently errors and users get logged out
// on the next request — visible as "force-quit + reopen logs me out"
// even with a valid signed cookie.
//
// This migration is idempotent (IF NOT EXISTS on both DDL statements)
// so it's safe to run against any environment whose code path uses the
// "sessions" table. In dev the table already exists and this is a
// no-op verification.
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

  console.log("Session 44 (express-session table) migration starting...");

  await db.transaction(async (tx) => {
    // Standard connect-pg-simple schema. Table name MUST match the
    // `tableName` option in replitAuth.ts (currently "sessions").
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS "sessions" (
        "sid"    varchar       NOT NULL COLLATE "default",
        "sess"   json          NOT NULL,
        "expire" timestamp(6)  NOT NULL,
        CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
      )
    `);
    console.log('✓ "sessions" table');

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS "IDX_sessions_expire"
        ON "sessions" ("expire")
    `);
    console.log('✓ IDX_sessions_expire index');
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema='public' AND table_name='sessions'
     ORDER BY ordinal_position
  `);
  console.log("sessions columns:", cols.rows);

  if (cols.rows.length === 0) {
    throw new Error('Verification FAILED: "sessions" table not found.');
  }

  const idx = await db.execute(sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename='sessions' AND indexname='IDX_sessions_expire'
  `);
  console.log("sessions indexes:", idx.rows);

  if (idx.rows.length === 0) {
    throw new Error('Verification FAILED: IDX_sessions_expire not found.');
  }

  const total = await db.execute(sql`SELECT count(*)::int AS n FROM "sessions"`);
  console.log("sessions row count:", total.rows);

  await pool.end();
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
