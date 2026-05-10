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

  // Pre-flight: confirm PG >= 11 so ADD COLUMN ... NOT NULL DEFAULT does not
  // rewrite the table. RDS is almost certainly modern but the check is cheap.
  const ver = await db.execute(sql`SELECT current_setting('server_version_num')::int AS v`);
  const verNum = (ver.rows[0] as { v: number }).v;
  console.log(`Postgres server_version_num=${verNum}`);
  if (verNum < 110000) {
    throw new Error(`Postgres ${verNum} too old; require >= 11 for fast ADD COLUMN DEFAULT.`);
  }

  console.log("Session 39 migration starting (checklists v2)...");

  await db.transaction(async (tx) => {
    // 1. Field-type enum (multiple_choice deferred to Stage 2 via ALTER TYPE ADD VALUE).
    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE checklist_field_type AS ENUM ('yes_no', 'rating', 'text');
      EXCEPTION WHEN duplicate_object THEN null; END $$
    `);
    console.log("✓ checklist_field_type enum");

    // 2. Sections table.
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS checklist_sections (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        checklist_id integer NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
        title text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ checklist_sections table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS checklist_sections_checklist_sort_idx
        ON checklist_sections (checklist_id, sort_order)
    `);
    console.log("✓ checklist_sections_checklist_sort_idx");

    // 3. Additive columns on checklist_items (all default-safe / nullable).
    await tx.execute(sql`
      ALTER TABLE checklist_items
        ADD COLUMN IF NOT EXISTS section_id          integer REFERENCES checklist_sections(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS field_type          checklist_field_type NOT NULL DEFAULT 'yes_no',
        ADD COLUMN IF NOT EXISTS notes               text,
        ADD COLUMN IF NOT EXISTS assigned_to_user_id varchar REFERENCES users(id),
        ADD COLUMN IF NOT EXISTS photos_required     boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS value_bool          boolean,
        ADD COLUMN IF NOT EXISTS value_rating        integer,
        ADD COLUMN IF NOT EXISTS value_text          text,
        ADD COLUMN IF NOT EXISTS selected_option_id  integer,
        ADD COLUMN IF NOT EXISTS completed_at        timestamp
    `);
    console.log("✓ checklist_items new columns");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS checklist_items_section_idx
        ON checklist_items (section_id)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS checklist_items_assigned_idx
        ON checklist_items (assigned_to_user_id)
        WHERE assigned_to_user_id IS NOT NULL
    `);
    console.log("✓ checklist_items section + assigned indexes");

    // 4. Backfill: legacy `checked` → value_bool, completed_at if checked.
    // WHERE value_bool IS NULL guard makes this idempotent — re-runs cannot
    // clobber a deliberate later edit.
    //
    // IMPORTANT: legacy `checked=false` maps to `value_bool=NULL` (not false).
    // The yes_no field-type semantics define completion as "answered" — any
    // non-null bool counts. A legacy unchecked row was *unanswered*, not a
    // deliberate "No" answer, so we must leave value_bool NULL or a benign
    // PATCH later (label/notes/sort) would auto-flip it to completed via the
    // state machine in storage.updateChecklistItem.
    await tx.execute(sql`
      UPDATE checklist_items
         SET value_bool   = CASE WHEN checked THEN true ELSE NULL END,
             completed_at = CASE WHEN checked THEN now() ELSE NULL END
       WHERE value_bool IS NULL
    `);
    console.log("✓ checklist_items backfill (checked → value_bool, completed_at)");

    // 5. Mirror on checklist_template_items (no value_*, no assigned_to,
    // no completed_at — templates carry authoring shape only).
    await tx.execute(sql`
      ALTER TABLE checklist_template_items
        ADD COLUMN IF NOT EXISTS section_id      integer,
        ADD COLUMN IF NOT EXISTS field_type      checklist_field_type NOT NULL DEFAULT 'yes_no',
        ADD COLUMN IF NOT EXISTS notes           text,
        ADD COLUMN IF NOT EXISTS photos_required boolean NOT NULL DEFAULT false
    `);
    console.log("✓ checklist_template_items new columns");
  });

  console.log("\nTransaction committed. Verifying...");

  // Verify enum exists with exactly 3 labels.
  const enumRows = await db.execute(sql`
    SELECT enumlabel FROM pg_enum
      JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
     WHERE pg_type.typname = 'checklist_field_type'
     ORDER BY enumsortorder
  `);
  const labels = enumRows.rows.map((r: any) => r.enumlabel);
  console.log("checklist_field_type labels:", labels);
  if (labels.length !== 3 || !labels.includes("yes_no") || !labels.includes("rating") || !labels.includes("text")) {
    throw new Error("Verification failed: checklist_field_type enum missing expected labels");
  }

  // Verify checklist_sections.
  const secCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name='checklist_sections' ORDER BY ordinal_position
  `);
  const secColNames = secCols.rows.map((r: any) => r.column_name);
  console.log("checklist_sections columns:", secColNames);
  for (const expected of ["id", "checklist_id", "title", "sort_order", "created_at", "updated_at"]) {
    if (!secColNames.includes(expected)) throw new Error(`checklist_sections.${expected} missing`);
  }

  // Verify checklist_items new columns.
  const itemCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='checklist_items'
       AND column_name IN ('section_id','field_type','notes','assigned_to_user_id',
                           'photos_required','value_bool','value_rating','value_text',
                           'selected_option_id','completed_at')
     ORDER BY column_name
  `);
  console.log("checklist_items new columns:", itemCols.rows);
  if (itemCols.rows.length !== 10) {
    throw new Error(`Expected 10 new checklist_items columns, found ${itemCols.rows.length}`);
  }

  // Verify checklist_template_items new columns.
  const tplCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name='checklist_template_items'
       AND column_name IN ('section_id','field_type','notes','photos_required')
  `);
  if (tplCols.rows.length !== 4) {
    throw new Error(`Expected 4 new checklist_template_items columns, found ${tplCols.rows.length}`);
  }
  console.log("checklist_template_items new columns:", tplCols.rows.map((r: any) => r.column_name));

  // Verify backfill parity. Should be 0.
  const drift = await db.execute(sql`
    SELECT count(*)::int AS n FROM checklist_items
     WHERE checked = true AND (value_bool IS NOT TRUE OR completed_at IS NULL)
  `);
  const driftN = (drift.rows[0] as { n: number }).n;
  console.log(`Backfill drift rows: ${driftN}`);
  if (driftN !== 0) {
    throw new Error(`Backfill failed: ${driftN} checked=true rows missing value_bool or completed_at`);
  }

  // Verify indexes.
  const idx = await db.execute(sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename IN ('checklist_sections','checklist_items')
       AND indexname IN ('checklist_sections_checklist_sort_idx',
                         'checklist_items_section_idx',
                         'checklist_items_assigned_idx')
  `);
  if (idx.rows.length !== 3) {
    throw new Error(`Expected 3 new indexes, found ${idx.rows.length}`);
  }
  console.log("Indexes present:", idx.rows.map((r: any) => r.indexname));

  console.log("\n✓ Session 39 migration complete and verified.");
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
