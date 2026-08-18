/**
 * Migration — structured client contacts
 *
 *   - contact_type / recap_frequency enums
 *   - contacts: account-scoped person directory (PII — never expose on
 *     public/share payloads)
 *   - project_contacts: (project, contact) join with per-project contact
 *     type + recap email prefs (unsubscribe_token stays nullable/unwritten
 *     until the recap feature lands)
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS / duplicate_object guards
 *     (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_contacts.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_contacts.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addContacts(): Promise<void> {
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

  console.log(`[add_contacts] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_contacts] 1/6 CREATE TYPE contact_type ...");
    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE contact_type AS ENUM ('owner', 'renter', 'property_manager', 'gc', 'other');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    console.log("[add_contacts] 2/6 CREATE TYPE recap_frequency ...");
    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE recap_frequency AS ENUM ('none', 'daily', 'weekly');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    console.log("[add_contacts] 3/6 CREATE TABLE contacts ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS contacts (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        account_id varchar NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        first_name text NOT NULL,
        last_name text,
        email text,
        phone text,
        address text,
        notes text,
        created_by_id varchar REFERENCES users(id),
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      )
    `);
    console.log("[add_contacts] 4/6 CREATE INDEX contacts_account_id_idx ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS contacts_account_id_idx ON contacts (account_id)
    `);
    console.log("[add_contacts] 5/6 CREATE TABLE project_contacts ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS project_contacts (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        contact_id integer NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        contact_type contact_type DEFAULT 'other' NOT NULL,
        recap_frequency recap_frequency DEFAULT 'none' NOT NULL,
        unsubscribe_token varchar(32),
        last_recap_sent_at timestamp,
        created_at timestamp DEFAULT now() NOT NULL
      )
    `);
    console.log("[add_contacts] 6/6 CREATE INDEXES on project_contacts ...");
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS project_contacts_project_contact_idx
        ON project_contacts (project_id, contact_id)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS project_contacts_contact_id_idx
        ON project_contacts (contact_id)
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS project_contacts_unsubscribe_token_idx
        ON project_contacts (unsubscribe_token) WHERE unsubscribe_token IS NOT NULL
    `);
  });

  console.log("[add_contacts] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addContacts()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_contacts] FAILED:", err?.message || err);
      process.exit(1);
    });
}
