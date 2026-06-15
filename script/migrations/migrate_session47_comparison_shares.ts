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

  console.log("Session 47 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS comparison_shares (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        token varchar(32) NOT NULL,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        before_media_id integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        after_media_id integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        before_label text,
        after_label text,
        created_by_id varchar REFERENCES users(id),
        created_at timestamp DEFAULT now() NOT NULL
      )
    `);
    console.log("✓ comparison_shares table");

    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS comparison_shares_token_idx
        ON comparison_shares (token)
    `);
    console.log("✓ comparison_shares_token_idx (unique)");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='comparison_shares'
     ORDER BY ordinal_position
  `);
  console.log("comparison_shares columns:", cols.rows);

  if (cols.rows.length === 0) {
    throw new Error("Verification FAILED: comparison_shares table not found after migration.");
  }

  const idx = await db.execute(sql`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE tablename='comparison_shares' AND indexname='comparison_shares_token_idx'
  `);
  console.log("comparison_shares_token_idx:", idx.rows);

  if (idx.rows.length === 0) {
    throw new Error("Verification FAILED: comparison_shares_token_idx not found after migration.");
  }

  const total = await db.execute(sql`SELECT count(*)::int AS n FROM comparison_shares`);
  console.log("comparison_shares row count (expected 0):", total.rows);

  await pool.end();
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
