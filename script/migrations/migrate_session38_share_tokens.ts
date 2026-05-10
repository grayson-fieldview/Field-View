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

  console.log("Session 38 migration starting (reports.share_token)...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE reports
        ADD COLUMN IF NOT EXISTS share_token varchar(32)
    `);
    console.log("✓ reports.share_token column");

    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS reports_share_token_unique
        ON reports (share_token)
        WHERE share_token IS NOT NULL
    `);
    console.log("✓ reports_share_token_unique (partial unique)");
  });

  console.log("\nTransaction committed. Verifying...");

  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, character_maximum_length
      FROM information_schema.columns
     WHERE table_name='reports' AND column_name='share_token'
  `);
  console.log("reports.share_token:", cols.rows);
  if (cols.rows.length !== 1) {
    throw new Error("Verification failed: reports.share_token column not found");
  }

  const idx = await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename='reports' AND indexname='reports_share_token_unique'
  `);
  console.log("reports_share_token_unique:", idx.rows);
  if (idx.rows.length !== 1) {
    throw new Error("Verification failed: reports_share_token_unique index not found");
  }

  console.log("\n✓ Session 38 migration complete and verified.");
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
