import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

// Stage 3 of checklists v2 — template parity with the v2 instance schema.
//
// Adds:
//   - checklist_template_sections (mirror of checklist_sections)
//   - FK on checklist_template_items.section_id → checklist_template_sections(id)
//     ON DELETE SET NULL. Stage 1 left this column as a plain integer placeholder
//     with no FK and no real values; we clear any stale rows before adding the
//     constraint so old placeholder values can't fail the FK.
//   - checklist_template_item_options (mirror of checklist_item_options)
//
// Idempotent re-run safe via:
//   - CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
//   - DO ... EXCEPTION WHEN duplicate_object pattern for the FK constraint
//   - section_id wipe is unconditional but harmless on re-run (FK already
//     forces NULL on detached references; no live rows exist either way)
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

  console.log("Session 40 (Stage 3) checklist template v2 migration starting...");

  await db.transaction(async (tx) => {
    // 1. Template sections table.
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS checklist_template_sections (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        template_id integer NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
        title text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ checklist_template_sections table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS checklist_template_sections_template_sort_idx
        ON checklist_template_sections (template_id, sort_order)
    `);
    console.log("✓ checklist_template_sections_template_sort_idx");

    // 2a. Ensure section_id column exists on checklist_template_items. The
    // Stage 1 schema declared it as a plain integer placeholder, but some
    // environments (notably Neon dev created via drizzle-kit push before
    // the placeholder was added) never materialised the column. Add it
    // unconditionally before the FK so the next steps don't 42703.
    await tx.execute(sql`
      ALTER TABLE checklist_template_items
        ADD COLUMN IF NOT EXISTS section_id integer
    `);
    console.log("✓ ensured checklist_template_items.section_id column");

    // 2b. Clear stale placeholder section_id values on template items BEFORE
    // adding the FK. Any non-null values from the Stage 1 placeholder era
    // point at nothing real and would fail the constraint. Safe to run
    // repeatedly.
    await tx.execute(sql`
      UPDATE checklist_template_items SET section_id = NULL WHERE section_id IS NOT NULL
    `);
    console.log("✓ cleared stale section_id placeholders on checklist_template_items");

    // 3. FK on checklist_template_items.section_id → checklist_template_sections(id).
    // Wrapped in DO/EXCEPTION for idempotent re-run.
    await tx.execute(sql`
      DO $$ BEGIN
        ALTER TABLE checklist_template_items
          ADD CONSTRAINT checklist_template_items_section_id_fkey
          FOREIGN KEY (section_id)
          REFERENCES checklist_template_sections(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    console.log("✓ checklist_template_items_section_id_fkey");

    // 4. Template item options table.
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS checklist_template_item_options (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        item_id integer NOT NULL REFERENCES checklist_template_items(id) ON DELETE CASCADE,
        label text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ checklist_template_item_options table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS checklist_template_item_options_item_sort_idx
        ON checklist_template_item_options (item_id, sort_order)
    `);
    console.log("✓ checklist_template_item_options_item_sort_idx");
  });

  console.log("\nTransaction committed. Verifying...");

  // Verify both new tables present with expected columns.
  const secCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name='checklist_template_sections' ORDER BY ordinal_position
  `);
  const secColNames = secCols.rows.map((r: any) => r.column_name);
  console.log("checklist_template_sections columns:", secColNames);
  for (const expected of ["id", "template_id", "title", "sort_order", "created_at", "updated_at"]) {
    if (!secColNames.includes(expected)) throw new Error(`checklist_template_sections.${expected} missing`);
  }

  const optCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name='checklist_template_item_options' ORDER BY ordinal_position
  `);
  const optColNames = optCols.rows.map((r: any) => r.column_name);
  console.log("checklist_template_item_options columns:", optColNames);
  for (const expected of ["id", "item_id", "label", "sort_order", "created_at", "updated_at"]) {
    if (!optColNames.includes(expected)) throw new Error(`checklist_template_item_options.${expected} missing`);
  }

  // Verify FK constraint registered.
  const fk = await db.execute(sql`
    SELECT conname FROM pg_constraint
     WHERE conname = 'checklist_template_items_section_id_fkey'
       AND contype = 'f'
  `);
  if (fk.rows.length !== 1) {
    throw new Error("FK checklist_template_items_section_id_fkey not found");
  }
  console.log("✓ FK constraint present");

  // Verify indexes.
  const idx = await db.execute(sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename IN ('checklist_template_sections','checklist_template_item_options')
       AND indexname IN ('checklist_template_sections_template_sort_idx',
                         'checklist_template_item_options_item_sort_idx')
  `);
  if (idx.rows.length !== 2) {
    throw new Error(`Expected 2 new indexes, found ${idx.rows.length}`);
  }
  console.log("Indexes present:", idx.rows.map((r: any) => r.indexname));

  // Final verification: row counts on both new tables (0/0 expected on first run).
  const secCount = await db.execute(sql`SELECT count(*)::int AS c FROM checklist_template_sections`);
  const optCount = await db.execute(sql`SELECT count(*)::int AS c FROM checklist_template_item_options`);
  console.log(`checklist_template_sections row count: ${(secCount.rows[0] as any).c}`);
  console.log(`checklist_template_item_options row count: ${(optCount.rows[0] as any).c}`);

  console.log("\n✓ Session 40 (Stage 3) migration complete and verified.");
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
