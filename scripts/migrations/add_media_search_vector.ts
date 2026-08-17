/**
 * Migration — media full-text search vector
 *
 * Adds a DB-owned generated column media.search_vector (tsvector, STORED)
 * plus a GIN index, for full-text photo search. Expression weights:
 *   A  ai_caption   — excluding the "UNCLEAR" sentinel (via CASE; still
 *                     immutable: texteq / coalesce / to_tsvector('simple',..)
 *                     / setweight / || are all IMMUTABLE)
 *   A  caption      (user-authored)
 *   B  tags         (via media_tags_text(); see below)
 *   C  original_name
 *
 * 'simple' config (two-arg to_tsvector) — no stemming: job-site captions are
 * full of product names/abbreviations where English stemming hurts, and the
 * one-arg form isn't allowed in a generated column anyway (not IMMUTABLE).
 *
 * media_tags_text(text[]): array_to_string() is only STABLE, so it cannot
 * appear in a generated-column expression. This trivial SQL wrapper is
 * declared IMMUTABLE (safe: pure text joining, no collation/config lookups)
 * — the standard Postgres workaround.
 *
 * No backfill needed: ADD COLUMN ... GENERATED ALWAYS AS ... STORED computes
 * the value for every existing row during the ALTER (full table rewrite —
 * milliseconds at ~4.4k rows). Captions are write-once (aiCaptions.ts writes
 * only WHERE ai_caption IS NULL), so no staleness story; any UPDATE
 * recomputes the vector automatically.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guards (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_media_search_vector.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_media_search_vector.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addMediaSearchVector(): Promise<void> {
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
    `[add_media_search_vector] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_media_search_vector] 1/3 media_tags_text() ...");
    // IMMUTABLE wrapper: array_to_string is STABLE, which a generated column
    // rejects. CREATE OR REPLACE is the IF-NOT-EXISTS equivalent for
    // functions (idempotent; body is fixed).
    await tx.execute(sql`
      CREATE OR REPLACE FUNCTION media_tags_text(text[]) RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE
      AS $fn$ SELECT coalesce(array_to_string($1, ' '), '') $fn$
    `);

    console.log("[add_media_search_vector] 2/3 media.search_vector ...");
    await tx.execute(sql`
      ALTER TABLE media ADD COLUMN IF NOT EXISTS search_vector tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('simple',
          CASE WHEN ai_caption = 'UNCLEAR' THEN '' ELSE coalesce(ai_caption, '') END
        ), 'A')
        || setweight(to_tsvector('simple', coalesce(caption, '')), 'A')
        || setweight(to_tsvector('simple', media_tags_text(tags)), 'B')
        || setweight(to_tsvector('simple', coalesce(original_name, '')), 'C')
      ) STORED
    `);

    console.log("[add_media_search_vector] 3/3 GIN index ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS media_search_vector_idx
      ON media USING gin (search_vector)
    `);
  });

  console.log("[add_media_search_vector] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addMediaSearchVector()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_media_search_vector] FAILED:", err?.message || err);
      process.exit(1);
    });
}
