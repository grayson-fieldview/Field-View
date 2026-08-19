/**
 * Migration — per-account AI business context
 *
 *   - accounts.ai_context text NULL
 *
 * Safety rails (same house pattern as other production migrations):
 *   - Single transaction; IF NOT EXISTS guard (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_account_ai_context.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_account_ai_context.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addAccountAiContext(): Promise<void> {
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
    `[add_account_ai_context] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_account_ai_context] ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_context ...");
    await tx.execute(sql`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_context text
    `);
  });

  console.log("[add_account_ai_context] done.");
}

const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addAccountAiContext()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_account_ai_context] FAILED:", err?.message || err);
      process.exit(1);
    });
}