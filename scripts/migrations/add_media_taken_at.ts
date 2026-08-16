/**
 * Migration — media.taken_at (capture time) + (project_id, taken_at) index
 *
 * Adds a nullable timestamp holding the CAPTURE time as reported by the
 * client, distinct from created_at (server registration time — the offline
 * upload queue can register photos hours after capture). Null for all
 * existing rows and for clients that don't send it; readers prefer
 * takenAt ?? createdAt. NO backfill — there is no reliable capture time to
 * recover for existing rows.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guards (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_media_taken_at.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_media_taken_at.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addMediaTakenAt(): Promise<void> {
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

  console.log(`[add_media_taken_at] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_media_taken_at] 1/2 ALTER TABLE media ADD COLUMN taken_at ...");
    await tx.execute(sql`
      ALTER TABLE media ADD COLUMN IF NOT EXISTS taken_at timestamp
    `);
    console.log("[add_media_taken_at] 2/2 CREATE INDEX media_project_taken_at_idx ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS media_project_taken_at_idx ON media (project_id, taken_at)
    `);
  });

  console.log("[add_media_taken_at] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addMediaTakenAt()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_media_taken_at] FAILED:", err?.message || err);
      process.exit(1);
    });
}
