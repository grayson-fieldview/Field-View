/**
 * Migration — Task Photo Requirements
 *
 * Adds:
 *   1. tasks.required_photo_count (integer NOT NULL DEFAULT 0) — minimum
 *      number of attached photos required before a task can transition to
 *      status 'done'. DEFAULT 0 = no requirement, so every existing task and
 *      every existing client (web + installed mobile builds) is unaffected.
 *   2. task_photos join table — photo ↔ task association, mirroring
 *      checklist_item_photos. UNIQUE (task_id, media_id) prevents duplicate
 *      attaches; ON DELETE CASCADE on both FKs (deleting a task or a media
 *      row removes the join rows — a completed task falling below its
 *      requirement afterwards does NOT reopen; nothing recomputes status).
 *
 * Both changes are additive with defaults — no backfill required.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Entire migration runs in a single db.transaction().
 *   - All DDL uses IF NOT EXISTS guards — safe to re-run (idempotent).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing; it only executes
 *     when invoked directly (npx tsx scripts/migrations/migrate_task_photo_requirements.ts).
 *   - Logs the DB host (never the password) and mode before any DB call.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/migrate_task_photo_requirements.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/migrate_task_photo_requirements.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function migrateTaskPhotoRequirements(): Promise<void> {
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

  // Log host + mode BEFORE any DB call. Never log the connection string.
  console.log(
    `[migrate_task_photo_requirements] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  // Import db only after the guards pass so a bad env fails before connecting.
  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[migrate_task_photo_requirements] 1/3 tasks.required_photo_count ...");
    await tx.execute(sql`
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS required_photo_count integer NOT NULL DEFAULT 0
    `);

    console.log("[migrate_task_photo_requirements] 2/3 task_photos table ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS task_photos (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        task_id integer NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        media_id integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT task_photos_task_media_uniq UNIQUE (task_id, media_id)
      )
    `);

    console.log("[migrate_task_photo_requirements] 3/3 index ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS task_photos_task_sort_idx
        ON task_photos (task_id, sort_order)
    `);
  });

  console.log("[migrate_task_photo_requirements] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  migrateTaskPhotoRequirements()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate_task_photo_requirements] FAILED:", err?.message || err);
      process.exit(1);
    });
}
