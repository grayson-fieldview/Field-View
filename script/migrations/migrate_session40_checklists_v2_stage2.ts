import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

// Stage 2 of checklists v2.
//
// CRITICAL ORDERING:
//   Step A — runs OUTSIDE any transaction (top-level await).
//     Adds the 'multiple_choice' enum value via ALTER TYPE ADD VALUE.
//     Postgres (RDS PG <= 12 in particular) refuses ADD VALUE inside a tx
//     block, AND a freshly-added enum value is not visible for casts inside
//     the same tx in which it was added — so we keep this completely
//     separate from the main DDL transaction.
//   Step B — single tx for new tables, FK on selected_option_id, indexes.
//
// Idempotent re-run safe via:
//   - pre-flight pg_enum read before ALTER TYPE
//   - CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
//   - DO ... EXCEPTION WHEN duplicate_object pattern for the FK constraint
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

  const ver = await db.execute(sql`SELECT current_setting('server_version_num')::int AS v`);
  const verNum = (ver.rows[0] as { v: number }).v;
  console.log(`Postgres server_version_num=${verNum}`);
  if (verNum < 110000) {
    throw new Error(`Postgres ${verNum} too old; require >= 11.`);
  }

  console.log("Session 40 migration starting (checklists v2 stage 2)...");

  // ── Step A: ALTER TYPE ADD VALUE — OUTSIDE any transaction ────────────────
  // Pre-flight: read existing enum labels. Skip ADD VALUE if already present
  // (covers re-run after a partial success, AND avoids requiring PG 12+
  // `IF NOT EXISTS` syntax).
  const enumPre = await db.execute(sql`
    SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
     WHERE pg_type.typname = 'checklist_field_type'
  `);
  const preLabels = enumPre.rows.map((r: any) => r.enumlabel);
  console.log(`Existing enum labels: ${JSON.stringify(preLabels)}`);

  if (!preLabels.includes("multiple_choice")) {
    // db.execute on the connection pool runs autocommit — no implicit tx.
    await db.execute(sql`ALTER TYPE checklist_field_type ADD VALUE 'multiple_choice'`);
    console.log("✓ ALTER TYPE checklist_field_type ADD VALUE 'multiple_choice'");
  } else {
    console.log("✓ multiple_choice already present, skipping ALTER TYPE");
  }

  // ── Step B: tables, indexes, FK — single transaction ──────────────────────
  await db.transaction(async (tx) => {
    // 1. Per-item options table (multiple_choice answer source).
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS checklist_item_options (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        item_id integer NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
        label text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ checklist_item_options table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS checklist_item_options_item_sort_idx
        ON checklist_item_options (item_id, sort_order)
    `);
    console.log("✓ checklist_item_options_item_sort_idx");

    // 2. Per-item photo joins. media row remains intact on detach.
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS checklist_item_photos (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        item_id integer NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
        media_id integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ checklist_item_photos table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS checklist_item_photos_item_sort_idx
        ON checklist_item_photos (item_id, sort_order)
    `);
    console.log("✓ checklist_item_photos_item_sort_idx");

    // 3. FK on checklist_items.selected_option_id → checklist_item_options(id).
    // Stage 1 left this as a plain integer column. All existing rows are NULL
    // (no Stage 1 code path writes to it), so the FK is safe to add. Wrapped
    // in DO/EXCEPTION for idempotent re-run.
    await tx.execute(sql`
      DO $$ BEGIN
        ALTER TABLE checklist_items
          ADD CONSTRAINT checklist_items_selected_option_id_fkey
          FOREIGN KEY (selected_option_id)
          REFERENCES checklist_item_options(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    console.log("✓ checklist_items_selected_option_id_fkey");
  });

  console.log("\nTransaction committed. Verifying...");

  // Verify enum has all 4 labels.
  const enumPost = await db.execute(sql`
    SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
     WHERE pg_type.typname = 'checklist_field_type'
     ORDER BY enumsortorder
  `);
  const postLabels = enumPost.rows.map((r: any) => r.enumlabel);
  console.log("checklist_field_type labels:", postLabels);
  for (const expected of ["yes_no", "rating", "text", "multiple_choice"]) {
    if (!postLabels.includes(expected)) {
      throw new Error(`Verification failed: enum missing label '${expected}'`);
    }
  }

  // Verify both new tables present with expected columns.
  const optCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name='checklist_item_options' ORDER BY ordinal_position
  `);
  const optColNames = optCols.rows.map((r: any) => r.column_name);
  console.log("checklist_item_options columns:", optColNames);
  for (const expected of ["id", "item_id", "label", "sort_order", "created_at", "updated_at"]) {
    if (!optColNames.includes(expected)) throw new Error(`checklist_item_options.${expected} missing`);
  }

  const phoCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name='checklist_item_photos' ORDER BY ordinal_position
  `);
  const phoColNames = phoCols.rows.map((r: any) => r.column_name);
  console.log("checklist_item_photos columns:", phoColNames);
  for (const expected of ["id", "item_id", "media_id", "sort_order", "created_at"]) {
    if (!phoColNames.includes(expected)) throw new Error(`checklist_item_photos.${expected} missing`);
  }
  if (phoColNames.includes("updated_at")) {
    throw new Error("checklist_item_photos must not have updated_at (immutable join row)");
  }

  // Verify FK constraint registered.
  const fk = await db.execute(sql`
    SELECT conname FROM pg_constraint
     WHERE conname = 'checklist_items_selected_option_id_fkey'
       AND contype = 'f'
  `);
  if (fk.rows.length !== 1) {
    throw new Error("FK checklist_items_selected_option_id_fkey not found");
  }
  console.log("✓ FK constraint present");

  // Verify indexes.
  const idx = await db.execute(sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename IN ('checklist_item_options','checklist_item_photos')
       AND indexname IN ('checklist_item_options_item_sort_idx',
                         'checklist_item_photos_item_sort_idx')
  `);
  if (idx.rows.length !== 2) {
    throw new Error(`Expected 2 new indexes, found ${idx.rows.length}`);
  }
  console.log("Indexes present:", idx.rows.map((r: any) => r.indexname));

  console.log("\n✓ Session 40 migration complete and verified.");
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
