/**
 * Migration — project_contacts.contact_type default "other" → "owner"
 *
 *   ALTER TABLE project_contacts ALTER COLUMN contact_type SET DEFAULT 'owner'
 *
 * Column-default change only. Existing rows keep their current values —
 * no backfill (SET DEFAULT never rewrites existing rows). Matches the
 * schema/zod defaults changed in shared/schema.ts in the same commit.
 *
 * Safety rails (house pattern):
 *   - Single transaction; SET DEFAULT is idempotent, safe to re-run.
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/set_contact_type_default_owner.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/set_contact_type_default_owner.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function setContactTypeDefaultOwner(): Promise<void> {
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

  console.log(`[set_contact_type_default_owner] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[set_contact_type_default_owner] 1/1 ALTER COLUMN contact_type SET DEFAULT 'owner' ...");
    await tx.execute(sql`
      ALTER TABLE project_contacts
        ALTER COLUMN contact_type SET DEFAULT 'owner'
    `);
  });

  console.log("[set_contact_type_default_owner] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  setContactTypeDefaultOwner()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[set_contact_type_default_owner] FAILED:", err?.message || err);
      process.exit(1);
    });
}
