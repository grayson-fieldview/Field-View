/**
 * Migration — add users.apple_id for Sign in with Apple
 *
 * Mirrors google_id / microsoft_id: nullable varchar with a UNIQUE
 * constraint (implemented as a unique index, which is exactly what
 * Postgres creates for inline UNIQUE — same end state as the drizzle
 * .unique() declarations for the other two provider columns).
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS on every DDL statement (idempotent).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually BEFORE deploying the code:
 *   Dev (Neon):  npx tsx scripts/migrations/migrate_apple_id.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/migrate_apple_id.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function migrateAppleId(): Promise<void> {
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

  console.log(`[migrate_apple_id] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id varchar
    `);
    // UNIQUE via index, matching how Postgres backs the inline UNIQUE on
    // google_id/microsoft_id. Named to match drizzle's .unique() convention
    // (users_apple_id_unique) so a future db:push sees it as already present.
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS users_apple_id_unique ON users (apple_id)
    `);

    // Verification: print the resulting column definition + index.
    const col = await tx.execute(sql`
      SELECT column_name, data_type, is_nullable, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'apple_id'
    `);
    const colRow = (col as any).rows?.[0] ?? (col as any)[0];
    if (!colRow) throw new Error("users.apple_id not present after ALTER — rolling back.");
    console.log("[migrate_apple_id] column:", colRow);

    const idx = await tx.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'users' AND indexname = 'users_apple_id_unique'
    `);
    const idxRow = (idx as any).rows?.[0] ?? (idx as any)[0];
    if (!idxRow) throw new Error("users_apple_id_unique index not present after CREATE — rolling back.");
    console.log("[migrate_apple_id] index:", idxRow);
    console.log("[migrate_apple_id] users.apple_id column + unique index present. Done.");
  });
}

// Entry-point guard: only run when executed directly.
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  migrateAppleId()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate_apple_id] FAILED:", err);
      process.exit(1);
    });
}
