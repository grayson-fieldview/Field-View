/**
 * Migration — per-account AI credits.
 *
 * Adds the immutable account cycle anchor, the one-row-per-account balance
 * table, and the append-only credit ledger. Existing accounts are anchored to
 * their creation timestamp (or migration time when creation is absent).
 *
 * Safety rails (house migration pattern):
 *   - Single transaction; IF NOT EXISTS on table/column/index DDL.
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_ai_credits.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_ai_credits.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addAiCredits(): Promise<void> {
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

  console.log(`[add_ai_credits] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_ai_credits] 1/8 ADD accounts.credits_anchor_at ...");
    await tx.execute(sql`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS credits_anchor_at timestamptz
    `);

    console.log("[add_ai_credits] 2/8 BACKFILL accounts.credits_anchor_at ...");
    await tx.execute(sql`
      UPDATE accounts
      SET credits_anchor_at = COALESCE(created_at AT TIME ZONE 'UTC', now())
      WHERE credits_anchor_at IS NULL
    `);

    // ADD COLUMN IF NOT EXISTS may encounter a partially-created nullable
    // column from an interrupted manual run. These idempotent ALTERs restore
    // the intended invariant for both existing and future accounts.
    console.log("[add_ai_credits] 3/8 ENFORCE accounts.credits_anchor_at invariant ...");
    await tx.execute(sql`
      ALTER TABLE accounts
        ALTER COLUMN credits_anchor_at SET DEFAULT now(),
        ALTER COLUMN credits_anchor_at SET NOT NULL
    `);

    console.log("[add_ai_credits] 4/8 CREATE TABLE account_credit_balances ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS account_credit_balances (
        account_id varchar PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        cycle_start timestamptz NOT NULL,
        monthly_remaining integer NOT NULL,
        purchased_remaining integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    console.log("[add_ai_credits] 5/8 CREATE TABLE credit_ledger ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id serial PRIMARY KEY,
        account_id varchar NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        user_id varchar REFERENCES users(id) ON DELETE SET NULL,
        delta integer NOT NULL,
        kind text NOT NULL,
        bucket text,
        feature text,
        ref_type text,
        ref_id integer,
        idempotency_key text,
        cycle_start timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    console.log("[add_ai_credits] 6/8 ADD credit_ledger.bucket for partial prior runs ...");
    await tx.execute(sql`
      ALTER TABLE credit_ledger
        ADD COLUMN IF NOT EXISTS bucket text
    `);

    console.log("[add_ai_credits] 7/8 CREATE UNIQUE INDEX credit ledger idempotency ...");
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_idempotency_key_unique
        ON credit_ledger (idempotency_key)
    `);

    console.log("[add_ai_credits] 8/8 CREATE INDEX credit ledger account/time ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS credit_ledger_account_created_idx
        ON credit_ledger (account_id, created_at)
    `);
  });

  console.log("[add_ai_credits] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addAiCredits()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_ai_credits] FAILED:", err?.message || err);
      process.exit(1);
    });
}