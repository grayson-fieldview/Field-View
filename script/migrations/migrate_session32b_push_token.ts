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

  console.log("Session 32b migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS expo_push_token varchar(255)
    `);
    console.log("✓ users.expo_push_token");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
     WHERE table_name='users' AND column_name='expo_push_token'
  `);
  console.log("users.expo_push_token:", cols.rows);

  if (cols.rows.length === 0) {
    throw new Error("Verification FAILED: expo_push_token column not found after migration.");
  }

  await pool.end();
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
