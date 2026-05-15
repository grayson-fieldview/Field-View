import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

// Session 46 — account-level default photo aspect ratio (capture preference).
//
// Adds:
//   • enum   photo_aspect_ratio                  ('4_3'|'1_1'|'16_9')
//   • column accounts.default_photo_aspect_ratio NOT NULL DEFAULT '4_3'
//     (existing rows are backfilled to '4_3' atomically by the DEFAULT clause
//     during ALTER — Postgres applies the default to existing rows in a single
//     table rewrite when the column is added with NOT NULL DEFAULT.)
//
// Pure additive migration — does NOT touch any existing column, FK, index, or
// table. No data deleted. No row-level changes outside the new column backfill.
//
// Wire ↔ DB translation: HTTP JSON uses colons ('4:3' etc.); DB enum uses
// underscores. Storage layer (server/storage.ts) is the single translation
// boundary. Migration touches only the DB form.
//
// Rollback (single transactional drop):
//   BEGIN;
//     ALTER TABLE accounts DROP COLUMN IF EXISTS default_photo_aspect_ratio;
//     DROP TYPE  IF EXISTS photo_aspect_ratio;
//   COMMIT;

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

  console.log("Session 46 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE photo_aspect_ratio AS ENUM ('4_3', '1_1', '16_9');
      EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    console.log("✓ photo_aspect_ratio enum");

    await tx.execute(sql`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS default_photo_aspect_ratio photo_aspect_ratio
        NOT NULL DEFAULT '4_3'
    `);
    console.log("✓ accounts.default_photo_aspect_ratio column (existing rows backfilled to '4_3')");
  });

  // Verify
  const cols = await db.execute(sql`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='accounts' AND column_name='default_photo_aspect_ratio'
  `);
  console.log("accounts.default_photo_aspect_ratio:", cols.rows);

  const enumVals = await db.execute(sql`
    SELECT enumlabel FROM pg_enum
     JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
     WHERE typname='photo_aspect_ratio' ORDER BY enumsortorder
  `);
  console.log("photo_aspect_ratio values:", enumVals.rows);

  const sample = await db.execute(sql`
    SELECT default_photo_aspect_ratio, count(*)::int AS n
      FROM accounts GROUP BY default_photo_aspect_ratio
  `);
  console.log("Backfill distribution:", sample.rows);

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
