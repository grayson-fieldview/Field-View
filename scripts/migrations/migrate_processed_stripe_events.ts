/**
 * Migration — processed_stripe_events (webhook dedupe)
 *
 * Adds the processed_stripe_events table: event-id keyed dedupe used ONLY by
 * the customer.subscription.trial_will_end webhook handler (it triggers a
 * customer-facing pre-charge email via GHL, so a Stripe redelivery must not
 * fire it twice). Mechanism: INSERT ... ON CONFLICT (event_id) DO NOTHING —
 * first processing wins, replays no-op.
 *
 * Purely additive — no backfill, no existing-table changes.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guards (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/migrate_processed_stripe_events.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/migrate_processed_stripe_events.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function migrateProcessedStripeEvents(): Promise<void> {
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
    `[migrate_processed_stripe_events] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[migrate_processed_stripe_events] 1/1 processed_stripe_events table ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS processed_stripe_events (
        event_id varchar PRIMARY KEY,
        event_type text NOT NULL,
        processed_at timestamp NOT NULL DEFAULT now()
      )
    `);
  });

  console.log("[migrate_processed_stripe_events] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  migrateProcessedStripeEvents()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate_processed_stripe_events] FAILED:", err?.message || err);
      process.exit(1);
    });
}
