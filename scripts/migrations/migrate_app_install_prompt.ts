/**
 * Migration — Mobile App Install Prompt
 *
 * Adds:
 *   1. accounts.first_mobile_upload_at (nullable timestamp) — set-once flag
 *      flipped when any team member persists media via the mobile app
 *      (X-FieldView-Client header). Suppresses the install prompt/banner.
 *   2. app_install_prompt_events table — append-only telemetry for the
 *      install-prompt modal/banner (shown / clicked_ios / clicked_android /
 *      dismissed), modeled on showcase_views.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Entire migration runs in a single db.transaction().
 *   - All DDL uses IF NOT EXISTS guards — safe to re-run (idempotent).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing; it only executes
 *     when invoked directly (npx tsx scripts/migrations/migrate_app_install_prompt.ts).
 *   - Logs the DB host (never the password) and mode before any DB call.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/migrate_app_install_prompt.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/migrate_app_install_prompt.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function migrateAppInstallPrompt(): Promise<void> {
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

  // Log host + mode BEFORE any DB call. Never log the connection string.
  console.log(
    `[migrate_app_install_prompt] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  // Import db only after the guards pass so a bad env fails before connecting.
  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[migrate_app_install_prompt] 1/3 accounts.first_mobile_upload_at ...");
    await tx.execute(sql`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS first_mobile_upload_at timestamp
    `);

    console.log("[migrate_app_install_prompt] 2/3 app_install_prompt_events table ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS app_install_prompt_events (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        account_id varchar NOT NULL REFERENCES accounts(id),
        user_id varchar NOT NULL REFERENCES users(id),
        surface text NOT NULL,
        action text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);

    console.log("[migrate_app_install_prompt] 3/3 index ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS app_install_prompt_events_account_created_idx
        ON app_install_prompt_events (account_id, created_at)
    `);
  });

  console.log("[migrate_app_install_prompt] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  migrateAppInstallPrompt()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate_app_install_prompt] FAILED:", err?.message || err);
      process.exit(1);
    });
}
