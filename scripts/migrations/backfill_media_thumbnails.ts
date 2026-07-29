/**
 * Backfill — generate thumbnail renditions for existing media rows
 *
 * Selects image rows WHERE thumb_url IS NULL and runs the exact same
 * generation code as the deferred upload path (server/lib/thumbnails.ts):
 * getObjectStream → sharp (HEIC via WASM heic-decode) → 400px JPEG q70 →
 * photos/thumbs/{basename}.jpg with immutable Cache-Control → set thumb_url.
 *
 * Resumable + idempotent by construction: only NULL rows are selected, each
 * success sets thumb_url immediately, failures log and stay null — safe to
 * re-run any number of times; a re-run picks up exactly where it left off.
 * Videos / non-image mime types are excluded by the WHERE clause.
 * Expected volume: ~3,216 image rows in prod (74 HEIC — the slow path).
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - DATABASE_URL host must be *.rds.amazonaws.com (prod) or *.neon.tech (dev).
 *   - RDS additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - DRY_RUN=yes reports counts (incl. HEIC breakdown) and exits, no writes.
 *   - Entry-point guard: importing this file does nothing.
 *   - NOTE: also needs AWS_* env for S3 access (same as the server).
 *
 * DO NOT run automatically. Run manually:
 *   Dry run:     DRY_RUN=yes npx tsx scripts/migrations/backfill_media_thumbnails.ts
 *   Dev (Neon):  npx tsx scripts/migrations/backfill_media_thumbnails.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/backfill_media_thumbnails.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function backfillMediaThumbnails(): Promise<void> {
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

  const dryRun = process.env.DRY_RUN === "yes";
  console.log(
    `[backfill_thumbs] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"} dryRun=${dryRun}`,
  );

  const { db } = await import("../../server/db");

  const pending = await db.execute(sql`
    SELECT id, url, mime_type
    FROM media
    WHERE thumb_url IS NULL AND mime_type LIKE 'image/%'
    ORDER BY id
  `);
  const rows: Array<{ id: number; url: string; mime_type: string }> =
    (pending as any).rows ?? (pending as any);
  const heicCount = rows.filter(
    (r) => r.mime_type === "image/heic" || r.mime_type === "image/heif" || /\.hei[cf]$/i.test(r.url),
  ).length;
  console.log(
    `[backfill_thumbs] pending: ${rows.length} image rows without thumb_url (${heicCount} HEIC — slow path)`,
  );

  if (dryRun) {
    console.log("[backfill_thumbs] DRY_RUN=yes — no writes performed.");
    return;
  }

  const { generateThumbnail } = await import("../../server/lib/thumbnails");

  let ok = 0;
  let failed = 0;
  const failedIds: number[] = [];
  const started = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // Sequential on purpose: predictable memory/S3 load, trivially resumable.
    const success = await generateThumbnail({ id: r.id, url: r.url, mimeType: r.mime_type });
    if (success) ok++;
    else {
      failed++;
      failedIds.push(r.id);
    }
    if ((i + 1) % 25 === 0 || i + 1 === rows.length) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`[backfill_thumbs] ${i + 1}/${rows.length} processed (ok=${ok} failed=${failed}) ${elapsed}s elapsed`);
    }
  }

  console.log(`[backfill_thumbs] done. ok=${ok} failed=${failed}` +
    (failedIds.length ? ` failed ids (thumb_url left null, re-run to retry): ${failedIds.join(", ")}` : ""));
}

// Entry-point guard: only run when executed directly.
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  backfillMediaThumbnails()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill_thumbs] FAILED:", err);
      process.exit(1);
    });
}
