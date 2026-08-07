/**
 * Migration — add accounts.google_play_purchase_token ahead of Google Play
 * Billing (Android IAP) support.
 *
 * Schema changes (accounts):
 *   - google_play_purchase_token varchar NULL
 *   - PARTIAL unique index on google_play_purchase_token
 *     (WHERE google_play_purchase_token IS NOT NULL) so the many NULL
 *     Stripe/Apple rows are exempt from uniqueness — mirrors
 *     accounts_apple_original_transaction_id_unique exactly.
 *
 * Backfill: intentionally NONE. No existing account is Google-billed; the
 * column starts NULL everywhere. billing_provider is a plain varchar, so the
 * 'google' value needs no schema change.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS on every DDL statement (idempotent).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually BEFORE deploying code that uses
 * this column:
 *   Dev (Neon):  npx tsx scripts/migrations/migrate_google_play_billing.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/migrate_google_play_billing.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function migrateGooglePlayBilling(): Promise<void> {
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

  // Log host (never credentials) and mode BEFORE any DB call.
  console.log(`[migrate_google_play_billing] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS google_play_purchase_token varchar
    `);
    // Partial unique index: uniqueness only among non-NULL values. Named to
    // match the drizzle uniqueIndex() declaration in shared/models/auth.ts so
    // a future db:push sees it as already present.
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_google_play_purchase_token_unique
        ON accounts (google_play_purchase_token)
        WHERE google_play_purchase_token IS NOT NULL
    `);

    // Verification: print the resulting column definition + index.
    const cols = await tx.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'accounts'
        AND column_name = 'google_play_purchase_token'
    `);
    const colRows = (cols as any).rows ?? (cols as any);
    if (!colRows || colRows.length !== 1) {
      throw new Error("Expected accounts.google_play_purchase_token present after ALTER — rolling back.");
    }
    console.log("[migrate_google_play_billing] columns:", colRows);

    const idx = await tx.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'accounts'
        AND indexname = 'accounts_google_play_purchase_token_unique'
    `);
    const idxRow = (idx as any).rows?.[0] ?? (idx as any)[0];
    if (!idxRow) {
      throw new Error("accounts_google_play_purchase_token_unique index not present after CREATE — rolling back.");
    }
    console.log("[migrate_google_play_billing] index:", idxRow);
    console.log("[migrate_google_play_billing] Done.");
  });
}

// Entry-point guard: only run when executed directly.
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  migrateGooglePlayBilling()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate_google_play_billing] FAILED:", err);
      process.exit(1);
    });
}
