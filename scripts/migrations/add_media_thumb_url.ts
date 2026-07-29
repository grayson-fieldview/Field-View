/**
 * Migration — add nullable media.thumb_url
 *
 * Server-generated 400px JPEG rendition URL (CloudFront). Nullable and
 * additive: filled by deferred generation after registration or by
 * scripts/migrations/backfill_media_thumbnails.ts; clients render
 * thumbUrl ?? url, so null is always safe.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; ADD COLUMN IF NOT EXISTS (idempotent).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_media_thumb_url.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_media_thumb_url.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addMediaThumbUrl(): Promise<void> {
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

  console.log(`[add_media_thumb_url] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE media ADD COLUMN IF NOT EXISTS thumb_url text`);
    const check = await tx.execute(sql`
      SELECT count(*) AS n FROM information_schema.columns
      WHERE table_name = 'media' AND column_name = 'thumb_url'
    `);
    const n = (check as any).rows?.[0]?.n ?? (check as any)[0]?.n;
    if (Number(n) !== 1) throw new Error("thumb_url column not present after ALTER — rolling back.");
    console.log("[add_media_thumb_url] thumb_url column present. Done.");
  });
}

// Entry-point guard: only run when executed directly.
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  addMediaThumbUrl()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_media_thumb_url] FAILED:", err);
      process.exit(1);
    });
}
