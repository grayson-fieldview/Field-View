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

  console.log("Email verification codes migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS verification_code VARCHAR(6)
    `);
    console.log("✓ users.verification_code");

    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS verification_code_expires_at TIMESTAMP
    `);
    console.log("✓ users.verification_code_expires_at");

    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS verification_code_attempts INTEGER DEFAULT 0 NOT NULL
    `);
    console.log("✓ users.verification_code_attempts");

    await tx.execute(sql`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS verification_code_sent_at TIMESTAMP
    `);
    console.log("✓ users.verification_code_sent_at");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='users'
       AND column_name IN (
         'verification_code',
         'verification_code_expires_at',
         'verification_code_attempts',
         'verification_code_sent_at'
       )
     ORDER BY column_name
  `);
  console.log("New columns:", cols.rows);

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
