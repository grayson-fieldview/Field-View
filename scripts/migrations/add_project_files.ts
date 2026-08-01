/**
 * Migration — create project_files table
 *
 * Project documents (work orders, change orders, permits) uploaded by office
 * staff and viewed by field crews. Modeled on the media table's conventions:
 * identity PK, FK -> projects with ON DELETE CASCADE, index on project_id.
 * Account scoping is derived via the project join — no account_id column,
 * matching media.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS on every DDL statement (idempotent).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually BEFORE deploying the code:
 *   Dev (Neon):  npx tsx scripts/migrations/add_project_files.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_project_files.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addProjectFiles(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — refusing to run.");

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL — refusing to run.");
  }

  const isRds = host.includes("rds.amazonaws.com");
  const isNeon = host.includes("neon.tech");
  if (!isRds && !isNeon) {
    throw new Error(
      `DATABASE_URL host "${host}" is neither *.rds.amazonaws.com nor *.neon.tech — refusing to run against an unrecognized database.`,
    );
  }
  if (isRds && process.env.ALLOW_PROD_MIGRATION !== "yes") {
    throw new Error("Target is a production RDS database. Set ALLOW_PROD_MIGRATION=yes to proceed.");
  }

  console.log(`[add_project_files] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS project_files (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        uploaded_by_id varchar REFERENCES users(id),
        filename text NOT NULL,
        original_name text NOT NULL,
        mime_type text NOT NULL,
        url text NOT NULL,
        size_bytes integer,
        created_at timestamp DEFAULT now() NOT NULL
      )
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS project_files_project_id_idx ON project_files (project_id)
    `);
    const check = await tx.execute(sql`
      SELECT count(*) AS n FROM information_schema.tables
      WHERE table_name = 'project_files'
    `);
    const n = (check as any).rows?.[0]?.n ?? (check as any)[0]?.n;
    if (Number(n) !== 1) throw new Error("project_files table not present after CREATE — rolling back.");
    console.log("[add_project_files] project_files table + index present. Done.");
  });
}

// Entry-point guard: only run when executed directly.
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  addProjectFiles()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_project_files] FAILED:", err);
      process.exit(1);
    });
}
