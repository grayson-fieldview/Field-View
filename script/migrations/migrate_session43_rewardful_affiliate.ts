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

  console.log("Session 43 (Rewardful affiliate) migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS rewardful_affiliate_id varchar(64)
    `);
    console.log("✓ users.rewardful_affiliate_id column");

    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS rewardful_referral_url varchar(255)
    `);
    console.log("✓ users.rewardful_referral_url column");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
     WHERE table_name='users'
       AND column_name IN ('rewardful_affiliate_id','rewardful_referral_url')
     ORDER BY column_name
  `);
  console.log("users rewardful columns:", cols.rows);

  if (cols.rows.length !== 2) {
    throw new Error(
      `Verification FAILED: expected 2 rewardful columns, got ${cols.rows.length}.`
    );
  }

  await pool.end();
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
