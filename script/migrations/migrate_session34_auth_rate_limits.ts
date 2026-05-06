import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

// Session 34 — create auth_rate_limits on prod RDS.
//
// Background: rate-limiter-flexible's RateLimiterPostgres is supposed to
// auto-create its backing table on first use (see node_modules/rate-limiter-
// flexible/lib/RateLimiterPostgres.js:_createTable). On prod RDS the
// runtime app user lacks CREATE TABLE privilege OR the auto-create races
// across cold starts, so the library logs "Table is not created yet at
// RateLimiterPostgres._upsert" and silently fails open — login attempts
// are unbounded. This migration creates the table out-of-band with a
// privileged migration user so the runtime path becomes a no-op.
//
// Schema MUST match the library's _getCreateTableStmt exactly:
//   key varchar(255) PRIMARY KEY
//   points integer NOT NULL DEFAULT 0
//   expire bigint
// Mirrored in shared/schema.ts (authRateLimits) for drizzle-kit awareness.

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

  console.log("Session 34 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key varchar(255) PRIMARY KEY,
        points integer NOT NULL DEFAULT 0,
        expire bigint
      )
    `);
    console.log("✓ auth_rate_limits table");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='auth_rate_limits'
     ORDER BY ordinal_position
  `);
  console.log("auth_rate_limits columns:", cols.rows);

  const pk = await db.execute(sql`
    SELECT a.attname AS column_name, i.indexname
      FROM pg_indexes i
      JOIN pg_class c ON c.relname = i.indexname
      JOIN pg_index x ON x.indexrelid = c.oid
      JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY(x.indkey)
     WHERE i.tablename='auth_rate_limits' AND x.indisprimary
  `);
  console.log("auth_rate_limits primary key:", pk.rows);

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
