/**
 * Migration — media_annotations dedupe + unique index
 *
 * The web client used to POST a brand-new media_annotations row on every
 * save from the plain "Annotate" entry point, so a (media_id, user_id) pair
 * could accumulate multiple rows. Mobile renders one row per user (newest),
 * making older strokes invisible there while web showed the union — silent
 * divergence, no actual data loss.
 *
 * Two steps, one transaction:
 *   1. Collapse duplicate rows per (media_id, user_id): union the stroke
 *      arrays in created_at order (row id tiebreak), dedupe strokes by their
 *      'id' field keeping the first occurrence (strokes without an 'id' are
 *      never collapsed), keep the EARLIEST created_at and LATEST updated_at,
 *      write the merged set into the earliest row, delete the rest.
 *   2. CREATE UNIQUE INDEX ... (media_id, user_id) — makes divergence a
 *      constraint violation instead of a client convention. Must run after
 *      the merge in the same transaction.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guard on the index (idempotent —
 *     re-running with no duplicates is a no-op).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/migrate_media_annotations_dedupe.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/migrate_media_annotations_dedupe.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function migrateMediaAnnotationsDedupe(): Promise<void> {
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
    `[migrate_media_annotations_dedupe] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    // Pre-flight report: how many groups / rows are affected.
    const report = await tx.execute(sql`
      SELECT
        count(*)                                   AS dup_groups,
        COALESCE(sum(cnt), 0)                      AS rows_in_groups,
        COALESCE(sum(cnt - 1), 0)                  AS rows_to_delete
      FROM (
        SELECT media_id, user_id, count(*) AS cnt
        FROM media_annotations
        GROUP BY media_id, user_id
        HAVING count(*) > 1
      ) g
    `);
    const stats = (report as any).rows?.[0] ?? (report as any)[0] ?? {};
    console.log(
      `[migrate_media_annotations_dedupe] duplicate groups=${stats.dup_groups} rows in groups=${stats.rows_in_groups} rows to delete=${stats.rows_to_delete}`,
    );

    // 1/3 — merge strokes into the earliest row per (media_id, user_id).
    console.log("[migrate_media_annotations_dedupe] 1/3 merging duplicate rows ...");
    await tx.execute(sql`
      WITH dup_groups AS (
        SELECT media_id, user_id
        FROM media_annotations
        GROUP BY media_id, user_id
        HAVING count(*) > 1
      ),
      exploded AS (
        SELECT r.media_id, r.user_id, r.id AS row_id,
               s.stroke, s.ord,
               row_number() OVER (
                 PARTITION BY r.media_id, r.user_id
                 ORDER BY r.created_at, r.id, s.ord
               ) AS global_ord,
               COALESCE(s.stroke->>'id', r.id::text || ':' || s.ord::text) AS dedupe_key
        FROM media_annotations r
        JOIN dup_groups d ON d.media_id = r.media_id AND d.user_id = r.user_id
        CROSS JOIN LATERAL jsonb_array_elements(r.strokes) WITH ORDINALITY AS s(stroke, ord)
      ),
      deduped AS (
        SELECT DISTINCT ON (media_id, user_id, dedupe_key)
               media_id, user_id, stroke, global_ord
        FROM exploded
        ORDER BY media_id, user_id, dedupe_key, global_ord
      ),
      merged AS (
        SELECT media_id, user_id, jsonb_agg(stroke ORDER BY global_ord) AS strokes
        FROM deduped
        GROUP BY media_id, user_id
      ),
      meta AS (
        SELECT r.media_id, r.user_id,
               min(r.created_at) AS min_created,
               max(r.updated_at) AS max_updated
        FROM media_annotations r
        JOIN dup_groups d ON d.media_id = r.media_id AND d.user_id = r.user_id
        GROUP BY r.media_id, r.user_id
      ),
      keepers AS (
        SELECT DISTINCT ON (r.media_id, r.user_id) r.id, r.media_id, r.user_id
        FROM media_annotations r
        JOIN dup_groups d ON d.media_id = r.media_id AND d.user_id = r.user_id
        ORDER BY r.media_id, r.user_id, r.created_at, r.id
      )
      UPDATE media_annotations m
      SET strokes    = COALESCE(mg.strokes, '[]'::jsonb),
          created_at = mt.min_created,
          updated_at = mt.max_updated
      FROM keepers k
      JOIN meta mt ON mt.media_id = k.media_id AND mt.user_id = k.user_id
      LEFT JOIN merged mg ON mg.media_id = k.media_id AND mg.user_id = k.user_id
      WHERE m.id = k.id
    `);

    // 2/3 — delete the now-merged extra rows.
    console.log("[migrate_media_annotations_dedupe] 2/3 deleting merged duplicates ...");
    await tx.execute(sql`
      WITH dup_groups AS (
        SELECT media_id, user_id
        FROM media_annotations
        GROUP BY media_id, user_id
        HAVING count(*) > 1
      ),
      keepers AS (
        SELECT DISTINCT ON (r.media_id, r.user_id) r.id, r.media_id, r.user_id
        FROM media_annotations r
        JOIN dup_groups d ON d.media_id = r.media_id AND d.user_id = r.user_id
        ORDER BY r.media_id, r.user_id, r.created_at, r.id
      )
      DELETE FROM media_annotations m
      USING keepers k
      WHERE m.media_id = k.media_id
        AND m.user_id  = k.user_id
        AND m.id <> k.id
    `);

    // 3/3 — unique index: divergence becomes impossible, not conventional.
    console.log("[migrate_media_annotations_dedupe] 3/3 unique index ...");
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS media_annotations_media_user_uniq
        ON media_annotations (media_id, user_id)
    `);
  });

  console.log("[migrate_media_annotations_dedupe] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  migrateMediaAnnotationsDedupe()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate_media_annotations_dedupe] FAILED:", err?.message || err);
      process.exit(1);
    });
}
