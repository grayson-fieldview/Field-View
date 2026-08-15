/**
 * Backfill — generate AI captions for existing media rows
 *
 * Selects rows WHERE ai_caption IS NULL (supported image mime types only)
 * and runs the exact same generation code as the deferred upload path
 * (server/lib/aiCaptions.ts): Claude vision via URL image source → one
 * plain sentence (or the "UNCLEAR" sentinel) → set ai_caption /
 * ai_caption_generated_at / ai_caption_model.
 *
 * Resumable + idempotent by construction: only NULL rows are selected, each
 * success writes immediately, failures log and stay null — safe to re-run
 * any number of times; a re-run picks up exactly where it left off.
 * HEIC/video/unsupported mime types are excluded by the WHERE clause.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - DATABASE_URL host must be *.rds.amazonaws.com (prod) or *.neon.tech (dev).
 *   - RDS additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - --dry-run prints what would be captioned and exits, no writes/API calls.
 *   - --limit=N caps rows per run (default 100) so spend is bounded per run.
 *   - Entry-point guard: importing this file does nothing.
 *   - NOTE: also needs ANTHROPIC_API_KEY (same as the server).
 *
 * DO NOT run automatically. Run manually:
 *   Dry run:     npx tsx scripts/migrations/backfill_media_ai_captions.ts --dry-run
 *   Dev (Neon):  npx tsx scripts/migrations/backfill_media_ai_captions.ts --limit=100
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/backfill_media_ai_captions.ts --limit=100
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";
import pLimit from "p-limit";

// Rough per-photo spend estimate for the running total: claude-haiku-4-5,
// one ~1-2MP image (~1.2-1.6k input tokens) + system prompt + <=150 output
// tokens ≈ $0.002-0.003. Use the upper bound so the printed estimate is
// conservative.
const EST_COST_PER_PHOTO_USD = 0.003;
const DEFAULT_LIMIT = 100;

function parseArgs(): { dryRun: boolean; limit: number } {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  let limit = DEFAULT_LIMIT;
  for (const a of args) {
    if (a === "--dry-run") continue;
    // Any supplied --limit (or unknown flag) must be valid — a malformed
    // value must NOT silently fall back to the default spend budget.
    const m = /^--limit=(\d+)$/.exec(a);
    if (m) {
      limit = parseInt(m[1], 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error(`--limit must be a positive integer (got "${m[1]}")`);
      }
    } else {
      throw new Error(`Unrecognized argument "${a}" (expected --dry-run or --limit=N)`);
    }
  }
  return { dryRun, limit };
}

export async function backfillMediaAiCaptions(): Promise<void> {
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

  const { dryRun, limit } = parseArgs();
  console.log(
    `[backfill_ai_captions] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"} dryRun=${dryRun} limit=${limit}`,
  );

  const { db } = await import("../../server/db");

  // heic/heif rows are only captionable via their JPEG thumbnail rendition,
  // so they require thumb_url IS NOT NULL; native vision mimes use url.
  const pending = await db.execute(sql`
    SELECT id, url, mime_type, thumb_url
    FROM media
    WHERE ai_caption IS NULL
      AND (
        mime_type IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp')
        OR (mime_type IN ('image/heic', 'image/heif') AND thumb_url IS NOT NULL)
      )
    ORDER BY id
    LIMIT ${sql.raw(String(limit))}
  `);
  const rows: Array<{ id: number; url: string; mime_type: string; thumb_url: string | null }> =
    (pending as any).rows ?? (pending as any);

  // Pre-run summary: rows to caption by mime type, plus how many heic/heif
  // rows are being skipped for a missing thumbnail rendition.
  const skippedHeic = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM media
    WHERE ai_caption IS NULL
      AND mime_type IN ('image/heic', 'image/heif')
      AND thumb_url IS NULL
  `);
  const skippedHeicCount: number =
    ((skippedHeic as any).rows ?? (skippedHeic as any))[0]?.n ?? 0;
  const byMime = new Map<string, number>();
  for (const r of rows) byMime.set(r.mime_type, (byMime.get(r.mime_type) ?? 0) + 1);
  console.log(`[backfill_ai_captions] pending this run: ${rows.length} rows (capped at ${limit})`);
  for (const [mime, n] of [...byMime.entries()].sort()) {
    console.log(`[backfill_ai_captions]   ${mime}: ${n}`);
  }
  console.log(
    `[backfill_ai_captions]   heic/heif skipped for null thumb_url (all pending, not just this run): ${skippedHeicCount}`,
  );

  if (dryRun) {
    for (const r of rows) {
      const src = r.mime_type === "image/heic" || r.mime_type === "image/heif" ? "thumbUrl" : "url";
      console.log(
        `[backfill_ai_captions] would caption media ${r.id} (${r.mime_type}) from ${src}: ${src === "thumbUrl" ? r.thumb_url : r.url}`,
      );
    }
    console.log(
      `[backfill_ai_captions] --dry-run — no writes/API calls. Estimated spend for these ${rows.length} rows: ~$${(rows.length * EST_COST_PER_PHOTO_USD).toFixed(2)}`,
    );
    return;
  }

  const { generateCaption } = await import("../../server/lib/aiCaptions");
  const { db: db2 } = await import("../../server/db");
  const { media } = await import("../../shared/schema");
  const { eq } = await import("drizzle-orm");

  const limiter = pLimit(5);
  let ok = 0;
  let failed = 0;
  const failedIds: number[] = [];
  const started = Date.now();

  await Promise.all(
    rows.map((r) =>
      limiter(async () => {
        const rowStarted = Date.now();
        const success = await generateCaption({
          id: r.id,
          url: r.url,
          mimeType: r.mime_type,
          thumbUrl: r.thumb_url,
          aiCaption: null,
        });
        const elapsed = Date.now() - rowStarted;
        if (success) {
          ok++;
          // Read back what was written so every result line shows the caption.
          const [row] = await db2
            .select({ aiCaption: media.aiCaption })
            .from(media)
            .where(eq(media.id, r.id));
          console.log(`[backfill_ai_captions] media ${r.id} ok ${elapsed}ms: ${row?.aiCaption}`);
        } else {
          failed++;
          failedIds.push(r.id);
          console.log(
            `[backfill_ai_captions] media ${r.id} FAILED ${elapsed}ms (ai_caption left null — re-run to retry; see log above for the error)`,
          );
        }
        // Running total + accrued spend as rows complete, so a long or
        // interrupted run always shows progress and cost so far.
        const done = ok + failed;
        console.log(
          `[backfill_ai_captions] progress: ${done}/${rows.length} (ok=${ok} failed=${failed}) — est. spend so far: ~$${(ok * EST_COST_PER_PHOTO_USD).toFixed(2)}`,
        );
      }),
    ),
  );

  const totalSeconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `[backfill_ai_captions] done in ${totalSeconds}s. ok=${ok} failed=${failed}` +
      (failedIds.length ? ` failed ids: ${failedIds.join(", ")}` : "") +
      ` — estimated spend this run: ~$${(ok * EST_COST_PER_PHOTO_USD).toFixed(2)}`,
  );
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  backfillMediaAiCaptions()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill_ai_captions] FAILED:", err?.message || err);
      process.exit(1);
    });
}
