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

  console.log("Session 23 (api_keys) migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id varchar NOT NULL REFERENCES accounts(id),
        name text NOT NULL,
        key_hash text NOT NULL UNIQUE,
        key_prefix text NOT NULL,
        last_four_chars text NOT NULL,
        created_by_id varchar NOT NULL REFERENCES users(id),
        last_used_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ api_keys table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx
        ON api_keys (key_hash)
    `);
    console.log("✓ api_keys_key_hash_idx");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS api_keys_account_id_idx
        ON api_keys (account_id)
    `);
    console.log("✓ api_keys_account_id_idx");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name='api_keys'
     ORDER BY ordinal_position
  `);
  console.log("api_keys columns:", cols.rows);

  const idx = await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename='api_keys' ORDER BY indexname
  `);
  console.log("api_keys indexes:", idx.rows);

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
