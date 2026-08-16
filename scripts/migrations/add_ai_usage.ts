/**
 * Migration — ai_usage table (AI generation metering)
 *
 * Creates ai_usage: one row per (account, feature, period_month) with a
 * counter, incremented via INSERT ... ON CONFLICT DO UPDATE after each
 * successful AI report generation (server/lib/aiReports.ts). Purely
 * additive — no existing tables touched.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guards (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_ai_usage.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_ai_usage.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addAiUsage(): Promise<void> {
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

  console.log(`[add_ai_usage] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_ai_usage] 1/3 CREATE TABLE ai_usage ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        account_id varchar NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        feature text NOT NULL,
        period_month text NOT NULL,
        count integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("[add_ai_usage] 2/3 UNIQUE INDEX (account_id, feature, period_month) ...");
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_account_feature_period_uniq
        ON ai_usage (account_id, feature, period_month)
    `);
    console.log("[add_ai_usage] 3/3 INDEX (account_id) ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS ai_usage_account_id_idx ON ai_usage (account_id)
    `);
  });

  console.log("[add_ai_usage] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addAiUsage()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_ai_usage] FAILED:", err?.message || err);
      process.exit(1);
    });
}
