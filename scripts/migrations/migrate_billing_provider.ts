/**
 * Migration — add accounts.billing_provider + accounts.apple_original_transaction_id
 * ahead of Apple In-App Purchase support.
 *
 * Schema changes (accounts):
 *   - billing_provider varchar NOT NULL DEFAULT 'stripe'
 *   - apple_original_transaction_id varchar NULL
 *   - PARTIAL unique index on apple_original_transaction_id
 *     (WHERE apple_original_transaction_id IS NOT NULL) so the many NULL
 *     Stripe rows are exempt from uniqueness.
 *
 * Backfill: intentionally NONE. Every existing account is Stripe-billed, and
 * ADD COLUMN ... NOT NULL DEFAULT 'stripe' stamps 'stripe' onto all existing
 * rows at DDL time (Postgres 11+ does this as a cheap catalog-only change).
 * No UPDATE is needed or wanted.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS on every DDL statement (idempotent).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually BEFORE deploying code that uses
 * these columns:
 *   Dev (Neon):  npx tsx scripts/migrations/migrate_billing_provider.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/migrate_billing_provider.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function migrateBillingProvider(): Promise<void> {
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
  console.log(`[migrate_billing_provider] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    // NOT NULL DEFAULT 'stripe' backfills all existing rows implicitly —
    // every current account is Stripe-billed, so no explicit UPDATE backfill
    // is performed (intentional; see file header).
    await tx.execute(sql`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS billing_provider varchar NOT NULL DEFAULT 'stripe'
    `);
    await tx.execute(sql`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS apple_original_transaction_id varchar
    `);
    // Partial unique index: uniqueness only among non-NULL values. Named to
    // match the drizzle uniqueIndex() declaration in shared/models/auth.ts so
    // a future db:push sees it as already present.
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_apple_original_transaction_id_unique
        ON accounts (apple_original_transaction_id)
        WHERE apple_original_transaction_id IS NOT NULL
    `);

    // Verification: print the resulting column definitions + index.
    const cols = await tx.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'accounts'
        AND column_name IN ('billing_provider', 'apple_original_transaction_id')
      ORDER BY column_name
    `);
    const colRows = (cols as any).rows ?? (cols as any);
    if (!colRows || colRows.length !== 2) {
      throw new Error("Expected both new accounts columns present after ALTER — rolling back.");
    }
    console.log("[migrate_billing_provider] columns:", colRows);

    const idx = await tx.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'accounts'
        AND indexname = 'accounts_apple_original_transaction_id_unique'
    `);
    const idxRow = (idx as any).rows?.[0] ?? (idx as any)[0];
    if (!idxRow) {
      throw new Error("accounts_apple_original_transaction_id_unique index not present after CREATE — rolling back.");
    }
    console.log("[migrate_billing_provider] index:", idxRow);
    console.log("[migrate_billing_provider] Done.");
  });
}

// Entry-point guard: only run when executed directly.
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  migrateBillingProvider()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate_billing_provider] FAILED:", err);
      process.exit(1);
    });
}
