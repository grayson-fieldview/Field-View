/**
 * Migration — reports.last_pdf_at (PDF export tracking)
 *
 * Adds a nullable timestamp set fire-and-forget by the AUTHENTICATED PDF
 * route (POST /api/reports/:id/pdf) after a successful export. The public
 * share route never writes it. Used to derive the report status badge
 * (Shared / Exported / Draft). Purely additive — no index.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guard (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_reports_last_pdf_at.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_reports_last_pdf_at.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addReportsLastPdfAt(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — refusing to run.");
  }

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
    throw new Error(
      "Target is a production RDS database. Set ALLOW_PROD_MIGRATION=yes to proceed.",
    );
  }

  console.log(`[add_reports_last_pdf_at] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_reports_last_pdf_at] 1/1 ALTER TABLE reports ADD COLUMN last_pdf_at ...");
    await tx.execute(sql`
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS last_pdf_at timestamp
    `);
  });

  console.log("[add_reports_last_pdf_at] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addReportsLastPdfAt()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_reports_last_pdf_at] FAILED:", err?.message || err);
      process.exit(1);
    });
}
