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

  console.log("Session 42 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS share_token varchar(32)
    `);
    console.log("✓ projects.share_token column");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS projects_share_token_idx
        ON projects (share_token)
        WHERE share_token IS NOT NULL
    `);
    console.log("✓ projects_share_token_idx (partial, WHERE share_token IS NOT NULL)");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='projects' AND column_name='share_token'
  `);
  console.log("projects.share_token:", cols.rows);

  if (cols.rows.length === 0) {
    throw new Error("Verification FAILED: share_token column not found after migration.");
  }

  const idx = await db.execute(sql`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE tablename='projects' AND indexname='projects_share_token_idx'
  `);
  console.log("projects_share_token_idx:", idx.rows);

  if (idx.rows.length === 0) {
    throw new Error("Verification FAILED: projects_share_token_idx not found after migration.");
  }

  const total = await db.execute(sql`SELECT count(*)::int AS n FROM projects`);
  console.log("projects row count:", total.rows);

  const withToken = await db.execute(sql`
    SELECT count(*)::int AS n FROM projects WHERE share_token IS NOT NULL
  `);
  console.log("projects with non-null share_token (expected 0):", withToken.rows);

  await pool.end();
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
