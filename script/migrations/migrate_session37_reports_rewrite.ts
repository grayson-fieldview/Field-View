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

  console.log("Session 37 reports-rewrite migration starting...");

  await db.transaction(async (tx) => {
    // 1. Drop old flat tables (zero prod data per spec).
    //    report_status enum is preserved — new reports table reuses it.
    await tx.execute(sql`DROP TABLE IF EXISTS report_templates CASCADE`);
    console.log("✓ dropped report_templates (old flat shape)");

    await tx.execute(sql`DROP TABLE IF EXISTS reports CASCADE`);
    console.log("✓ dropped reports (old flat shape)");

    // 2. Create new structured reports table (account_id varchar — accounts.id is uuid).
    await tx.execute(sql`
      CREATE TABLE reports (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        account_id varchar NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        title text NOT NULL,
        description text,
        cover_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        status report_status NOT NULL DEFAULT 'draft',
        created_by_id varchar REFERENCES users(id),
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ created reports (new structured shape)");

    await tx.execute(sql`CREATE INDEX reports_project_id_idx ON reports (project_id)`);
    await tx.execute(sql`CREATE INDEX reports_account_id_idx ON reports (account_id)`);
    console.log("✓ reports indexes (project_id, account_id)");

    // 3. Create report_sections.
    await tx.execute(sql`
      CREATE TABLE report_sections (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        report_id integer NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        title text NOT NULL,
        summary text,
        sort_order integer NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ created report_sections");

    await tx.execute(sql`
      CREATE INDEX report_sections_report_sort_idx
        ON report_sections (report_id, sort_order)
    `);
    console.log("✓ report_sections_report_sort_idx");

    // 4. Create report_section_photos.
    await tx.execute(sql`
      CREATE TABLE report_section_photos (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        section_id integer NOT NULL REFERENCES report_sections(id) ON DELETE CASCADE,
        media_id integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        caption text,
        description text,
        sort_order integer NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ created report_section_photos");

    await tx.execute(sql`
      CREATE INDEX report_section_photos_section_sort_idx
        ON report_section_photos (section_id, sort_order)
    `);
    console.log("✓ report_section_photos_section_sort_idx");

    // 5. Create new report_templates (templateConfig jsonb shape).
    await tx.execute(sql`
      CREATE TABLE report_templates (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        account_id varchar NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        title text NOT NULL,
        template_config jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_by_id varchar REFERENCES users(id),
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("✓ created report_templates (new templateConfig shape)");

    await tx.execute(sql`
      CREATE INDEX report_templates_account_id_idx
        ON report_templates (account_id)
    `);
    console.log("✓ report_templates_account_id_idx");

    // 6. Add branding columns to accounts (Stage 1 — table only, no UI yet).
    await tx.execute(sql`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS company_logo_url varchar,
        ADD COLUMN IF NOT EXISTS company_legal_name text,
        ADD COLUMN IF NOT EXISTS company_address text
    `);
    console.log("✓ accounts: company_logo_url, company_legal_name, company_address");
  });

  console.log("\nTransaction committed. Verifying...");

  for (const tbl of ["reports", "report_sections", "report_section_photos", "report_templates"]) {
    const cols = await db.execute(sql`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = ${tbl}
       ORDER BY ordinal_position
    `);
    console.log(`\n${tbl} columns:`, cols.rows);
  }

  const acctCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name = 'accounts'
       AND column_name IN ('company_logo_url', 'company_legal_name', 'company_address')
     ORDER BY column_name
  `);
  console.log("\naccounts new columns:", acctCols.rows);

  const idx = await db.execute(sql`
    SELECT tablename, indexname
      FROM pg_indexes
     WHERE tablename IN ('reports', 'report_sections', 'report_section_photos', 'report_templates')
     ORDER BY tablename, indexname
  `);
  console.log("\nindexes:", idx.rows);

  await pool.end();
  console.log("\n✅ Session 37 migration complete");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
