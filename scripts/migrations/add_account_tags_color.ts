/**
 * Migration — account_tags: add nullable color column
 *
 * Tag colors (Option A): account_tags is the account-scoped tag vocabulary;
 * media.tags stays text[] and clients resolve a tag's color by name lookup
 * against /api/tags. color is nullable — existing tags render with the
 * current default badge styling until a color is chosen. Values are
 * constrained to a fixed hex palette at the API layer (shared/tagColors.ts),
 * not in the database.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guard (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_account_tags_color.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_account_tags_color.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addAccountTagsColor(): Promise<void> {
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
    `[add_account_tags_color] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_account_tags_color] 1/1 ALTER TABLE account_tags ADD COLUMN IF NOT EXISTS color text ...");
    await tx.execute(sql`
      ALTER TABLE account_tags ADD COLUMN IF NOT EXISTS color text
    `);
  });

  console.log("[add_account_tags_color] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addAccountTagsColor()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_account_tags_color] FAILED:", err?.message || err);
      process.exit(1);
    });
}
