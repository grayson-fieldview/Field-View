/**
 * Migration — report_status enum: add 'generating' and 'failed'
 *
 * Groundwork for creating walkthrough report rows up-front in a
 * 'generating' status (truthful in-progress entries on clients) with a
 * 'failed' terminal state for the generation-failure path. This script
 * ONLY extends the enum — no route or write-path uses either value yet.
 *
 * PG12+ allows ALTER TYPE ... ADD VALUE inside a transaction, BUT the new
 * value cannot be USED (written/compared) in the same transaction that
 * adds it. This script therefore never references either value beyond the
 * ADD VALUE statements themselves.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guard (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_report_status_generating_failed.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_report_status_generating_failed.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addReportStatusGeneratingFailed(): Promise<void> {
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

  console.log(
    `[add_report_status_generating_failed] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_report_status_generating_failed] 1/2 ALTER TYPE report_status ADD VALUE 'generating' ...");
    await tx.execute(sql`
      ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'generating'
    `);
    console.log("[add_report_status_generating_failed] 2/2 ALTER TYPE report_status ADD VALUE 'failed' ...");
    await tx.execute(sql`
      ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'failed'
    `);
  });

  console.log("[add_report_status_generating_failed] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addReportStatusGeneratingFailed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_report_status_generating_failed] FAILED:", err?.message || err);
      process.exit(1);
    });
}
