/**
 * Migration — live-mode shared galleries
 *
 *   shared_galleries.is_live boolean NOT NULL DEFAULT false
 *
 * Live galleries resolve their photos from the project at request time;
 * snapshot galleries (the default, and all existing rows) keep serving the
 * mediaIds captured at creation. No backfill — DEFAULT false preserves
 * today's behavior for every existing link.
 *
 * Safety rails (house pattern):
 *   - Single transaction; IF NOT EXISTS guard (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_gallery_live_mode.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_gallery_live_mode.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addGalleryLiveMode(): Promise<void> {
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

  console.log(`[add_gallery_live_mode] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_gallery_live_mode] 1/1 ALTER TABLE shared_galleries ADD is_live ...");
    await tx.execute(sql`
      ALTER TABLE shared_galleries
        ADD COLUMN IF NOT EXISTS is_live boolean NOT NULL DEFAULT false
    `);
  });

  console.log("[add_gallery_live_mode] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addGalleryLiveMode()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_gallery_live_mode] FAILED:", err?.message || err);
      process.exit(1);
    });
}
