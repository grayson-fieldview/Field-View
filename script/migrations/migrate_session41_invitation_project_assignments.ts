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

  console.log("Session 41 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE invitations
        ADD COLUMN IF NOT EXISTS assigned_project_ids jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    console.log("✓ invitations.assigned_project_ids");
  });

  console.log("\nTransaction committed. Verifying...");
  const cols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='invitations' AND column_name='assigned_project_ids'
  `);
  console.log("invitations.assigned_project_ids:", cols.rows);

  if (cols.rows.length === 0) {
    throw new Error("Verification FAILED: assigned_project_ids column not found after migration.");
  }

  const total = await db.execute(sql`SELECT count(*)::int AS n FROM invitations`);
  console.log("invitations row count:", total.rows);

  const nonEmpty = await db.execute(sql`
    SELECT count(*)::int AS n FROM invitations WHERE assigned_project_ids != '[]'::jsonb
  `);
  console.log("invitations with non-empty assigned_project_ids:", nonEmpty.rows);

  await pool.end();
  console.log("Done.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
