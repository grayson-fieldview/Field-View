/**
 * Migration — ai_usage_events table (per-provider-call AI cost telemetry)
 *
 * Creates an append-only event table without changing ai_usage or any
 * existing metering behavior.
 *
 * Safety rails (house migration pattern):
 *   - Single transaction; IF NOT EXISTS on every DDL statement.
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_ai_usage_events.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_ai_usage_events.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addAiUsageEvents(): Promise<void> {
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

  const normalizedHost = host.toLowerCase();
  const isRds =
    normalizedHost === "rds.amazonaws.com" ||
    normalizedHost.endsWith(".rds.amazonaws.com");
  const isNeon =
    normalizedHost === "neon.tech" ||
    normalizedHost.endsWith(".neon.tech");
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

  console.log(`[add_ai_usage_events] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_ai_usage_events] 1/3 CREATE TABLE ai_usage_events ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS ai_usage_events (
        id serial PRIMARY KEY,
        account_id varchar NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        feature text NOT NULL,
        provider text NOT NULL,
        model text NOT NULL,
        input_tokens integer,
        output_tokens integer,
        cache_creation_tokens integer,
        cache_read_tokens integer,
        audio_seconds numeric(12,3),
        image_count integer,
        success boolean NOT NULL,
        error_code text,
        provider_request_id text,
        cost_usd numeric(10,6),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("[add_ai_usage_events] 2/3 INDEX (account_id, created_at) ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS ai_usage_events_account_created_idx
        ON ai_usage_events (account_id, created_at)
    `);
    console.log("[add_ai_usage_events] 3/3 INDEX (feature, created_at) ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS ai_usage_events_feature_created_idx
        ON ai_usage_events (feature, created_at)
    `);
  });

  console.log("[add_ai_usage_events] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addAiUsageEvents()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_ai_usage_events] FAILED:", err?.message || err);
      process.exit(1);
    });
}