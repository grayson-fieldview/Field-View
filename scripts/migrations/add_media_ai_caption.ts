/**
 * Migration — media AI caption columns
 *
 * Adds three nullable columns to media for AI-generated photo captions
 * (server/lib/aiCaptions.ts): ai_caption (the sentence, or the literal
 * "UNCLEAR" sentinel for unusable photos), ai_caption_generated_at, and
 * ai_caption_model. Purely additive — no backfill, no existing-column
 * changes; media.caption (user-authored) is untouched. No index: the only
 * scan is the backfill's one-off `ai_caption IS NULL` pass.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guards (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_media_ai_caption.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_media_ai_caption.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addMediaAiCaption(): Promise<void> {
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
    `[add_media_ai_caption] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_media_ai_caption] 1/3 media.ai_caption ...");
    await tx.execute(sql`
      ALTER TABLE media ADD COLUMN IF NOT EXISTS ai_caption text
    `);
    console.log("[add_media_ai_caption] 2/3 media.ai_caption_generated_at ...");
    await tx.execute(sql`
      ALTER TABLE media ADD COLUMN IF NOT EXISTS ai_caption_generated_at timestamp
    `);
    console.log("[add_media_ai_caption] 3/3 media.ai_caption_model ...");
    await tx.execute(sql`
      ALTER TABLE media ADD COLUMN IF NOT EXISTS ai_caption_model text
    `);
  });

  console.log("[add_media_ai_caption] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addMediaAiCaption()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_media_ai_caption] FAILED:", err?.message || err);
      process.exit(1);
    });
}
