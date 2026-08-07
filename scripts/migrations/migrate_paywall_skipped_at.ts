/**
 * Migration — add accounts.paywall_skipped_at
 *
 * Nullable set-once UX-suppression timestamp (same pattern as
 * first_mobile_upload_at): stamped when the account owner skips the
 * /choose-plan paywall, suppressing it thereafter. Never read in any
 * authorization path. No index needed — only ever read by account PK.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS on every DDL statement (idempotent).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually BEFORE deploying the code:
 *   Dev (Neon):  npx tsx scripts/migrations/migrate_paywall_skipped_at.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/migrate_paywall_skipped_at.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function migratePaywallSkippedAt(): Promise<void> {
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

  console.log(`[migrate_paywall_skipped_at] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS paywall_skipped_at timestamp
    `);
  });

  console.log("[migrate_paywall_skipped_at] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  migratePaywallSkippedAt()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate_paywall_skipped_at] FAILED:", err?.message || err);
      process.exit(1);
    });
}
