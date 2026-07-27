/**
 * Backfill — fontSizeNorm on text annotation strokes
 *
 * Stored text strokes carry an absolute-px fontSize authored against the
 * full-size viewer's fitted-image box (calibration basis 600px — see
 * FONT_REFERENCE_HEIGHT in client/src/lib/annotation-svg.tsx). New writes
 * add fontSizeNorm = px / fittedRectHeight (0–1 fraction of image height).
 * This one-shot backfill converts existing rows:
 *
 *   fontSizeNorm = fontSize / 600
 *
 * ADDITIVE only: fontSize is left untouched (legacy mobile builds still
 * read/write it). Idempotent: strokes that already have fontSizeNorm are
 * skipped; non-text strokes and rows without text strokes are untouched.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - DATABASE_URL host must be *.rds.amazonaws.com (prod) or *.neon.tech (dev).
 *   - RDS additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - DRY_RUN=yes reports counts and exits without writing.
 *   - Single transaction; entry-point guard (importing does nothing).
 *
 * DO NOT run automatically. Run manually:
 *   Dry run:     DRY_RUN=yes npx tsx scripts/migrations/backfill_font_size_norm.ts
 *   Dev (Neon):  npx tsx scripts/migrations/backfill_font_size_norm.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/backfill_font_size_norm.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

const FONT_REFERENCE_HEIGHT = 600; // keep in sync with client/src/lib/annotation-svg.tsx

export async function backfillFontSizeNorm(): Promise<void> {
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
    `[backfill_font_size_norm] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"} dryRun=${dryRun}`,
  );

  const { db } = await import("../../server/db");

  // Pre-flight: rows containing at least one text stroke that still lacks fontSizeNorm.
  const preflight = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM media_annotations) AS total_rows,
      (SELECT count(*) FROM media_annotations
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(strokes) s WHERE s->>'type' = 'text')) AS rows_with_text,
      (SELECT count(*) FROM media_annotations
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(strokes) s
                      WHERE s->>'type' = 'text' AND s->'fontSizeNorm' IS NULL)) AS rows_needing_backfill,
      (SELECT coalesce(sum((SELECT count(*) FROM jsonb_array_elements(strokes) s
                            WHERE s->>'type' = 'text' AND s->'fontSizeNorm' IS NULL)), 0)
         FROM media_annotations) AS strokes_needing_backfill
  `);
  const p = (preflight as any).rows?.[0] ?? (preflight as any)[0];
  console.log(
    `[backfill_font_size_norm] pre-flight: total_rows=${p.total_rows} rows_with_text=${p.rows_with_text} rows_needing_backfill=${p.rows_needing_backfill} strokes_needing_backfill=${p.strokes_needing_backfill}`,
  );

  if (dryRun) {
    console.log("[backfill_font_size_norm] DRY_RUN=yes — no writes performed.");
    return;
  }

  await db.transaction(async (tx) => {
    // Rewrite only rows that need it; within each row, add fontSizeNorm only
    // to text strokes lacking it (fontSize may be absent in malformed strokes
    // — those are skipped rather than given a bogus norm). updated_at is NOT
    // touched: this is a representation backfill, not a user edit, and mobile
    // picks newest-per-user by timestamps.
    const result = await tx.execute(sql`
      UPDATE media_annotations
      SET strokes = (
        SELECT jsonb_agg(
          CASE
            WHEN s->>'type' = 'text'
             AND s->'fontSizeNorm' IS NULL
             AND jsonb_typeof(s->'fontSize') = 'number'
            THEN s || jsonb_build_object('fontSizeNorm', (s->>'fontSize')::numeric / ${FONT_REFERENCE_HEIGHT})
            ELSE s
          END
          ORDER BY ord
        )
        FROM jsonb_array_elements(strokes) WITH ORDINALITY AS t(s, ord)
      )
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(strokes) s
        WHERE s->>'type' = 'text' AND s->'fontSizeNorm' IS NULL
          AND jsonb_typeof(s->'fontSize') = 'number'
      )
    `);
    console.log(`[backfill_font_size_norm] rows updated: ${(result as any).rowCount ?? "(driver did not report)"}`);
  });

  console.log("[backfill_font_size_norm] done.");
}

// Entry-point guard: only run when executed directly.
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  backfillFontSizeNorm()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill_font_size_norm] FAILED:", err);
      process.exit(1);
    });
}
