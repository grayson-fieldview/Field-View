/**
 * Migration — timestamp/address overlay settings
 *
 *   - accounts.photo_overlay_enabled boolean NOT NULL DEFAULT false
 *   - projects.photo_overlay_enabled boolean NULL (NULL = inherit account)
 *
 * Phase 1 scope: report PDF overlay only (drawn at render time via
 * react-pdf layout — no image processing, no derived files). Resolution
 * precedence lives in shared/photoOverlay.ts.
 *
 * Safety rails (same pattern as other prod migration scripts in scripts/):
 *   - Single transaction; IF NOT EXISTS guards (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_photo_overlay_settings.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_photo_overlay_settings.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addPhotoOverlaySettings(): Promise<void> {
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
    `[add_photo_overlay_settings] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`,
  );

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_photo_overlay_settings] 1/2 ALTER TABLE accounts ADD COLUMN IF NOT EXISTS photo_overlay_enabled ...");
    await tx.execute(sql`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS photo_overlay_enabled boolean NOT NULL DEFAULT false
    `);
    console.log("[add_photo_overlay_settings] 2/2 ALTER TABLE projects ADD COLUMN IF NOT EXISTS photo_overlay_enabled ...");
    await tx.execute(sql`
      ALTER TABLE projects ADD COLUMN IF NOT EXISTS photo_overlay_enabled boolean
    `);
  });

  console.log("[add_photo_overlay_settings] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addPhotoOverlaySettings()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_photo_overlay_settings] FAILED:", err?.message || err);
      process.exit(1);
    });
}
