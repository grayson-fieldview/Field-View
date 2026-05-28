// Session 46 — Meta Pixel + Conversions API attribution columns.
//
// Adds the five columns needed to persist Meta/Facebook attribution at signup
// so the CAPI helper can fan out Subscribe / Purchase events days or weeks
// later (from the Stripe webhook context, where no browser cookies exist)
// with the same fbp / fbc / fbclid that were captured on the landing page.
//
//   users.signup_utm_content   — ?utm_content captured on landing
//   users.signup_utm_term      — ?utm_term captured on landing
//   users.signup_fbclid        — raw fbclid query param captured on landing
//   users.signup_fbp           — Meta browser cookie (_fbp) at signup time
//   users.signup_fbc           — Meta click cookie (_fbc) at signup time,
//                                format: fb.1.<unix_ms>.<fbclid>
//
// Complements the S45 columns (signup_referrer, signup_utm_source/medium/
// campaign). All five new columns are nullable varchar — we never reject a
// signup for missing attribution, and historic users will just have NULLs.
//
// Run sequence (per project policy — see replit.md):
//   1. Snapshot RDS
//   2. Whitelist Replit egress IP on the RDS security group
//   3. ALLOW_PROD_MIGRATION=yes DATABASE_URL=<prod> npx tsx \
//        script/migrations/migrate_session46_meta_capi_attribution.ts
//   4. Verify schema in TablePlus (columns exist, all nullable)
//   5. Promote Vercel deploy (only AFTER verify)
//   6. Remove Replit IP from RDS SG
//
// All ALTER statements use IF NOT EXISTS so reruns are safe.

import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

async function run() {
  const url = process.env.DATABASE_URL ?? "";
  const isRds = url.includes("rds.amazonaws.com");
  const isNeon = url.includes("neon.tech");

  if (!isRds && !isNeon) {
    throw new Error("DATABASE_URL must be RDS or Neon. Refusing to run.");
  }

  if (isRds && process.env.ALLOW_PROD_MIGRATION !== "yes") {
    throw new Error(
      "Refusing to run against prod RDS without ALLOW_PROD_MIGRATION=yes. " +
        "Set the flag explicitly to confirm this is intentional.",
    );
  }

  const host = url.match(/@([^/?]+)/)?.[1] ?? "unknown";
  console.log(`Target DB host: ${host}`);
  console.log(`Mode: ${isRds ? "PRODUCTION RDS" : "Neon dev"}`);
  if (isRds) console.log("⚠️  PROD migration — ALLOW_PROD_MIGRATION=yes confirmed");

  console.log("Session 46 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_utm_content varchar`);
    console.log("✓ users.signup_utm_content");

    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_utm_term varchar`);
    console.log("✓ users.signup_utm_term");

    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_fbclid varchar`);
    console.log("✓ users.signup_fbclid");

    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_fbp varchar`);
    console.log("✓ users.signup_fbp");

    await tx.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_fbc varchar`);
    console.log("✓ users.signup_fbc");
  });

  console.log("\nTransaction committed. Verifying...");
  const userCols = await db.execute(sql`
    SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_name='users'
       AND column_name IN (
         'signup_utm_content',
         'signup_utm_term',
         'signup_fbclid',
         'signup_fbp',
         'signup_fbc'
       )
     ORDER BY column_name
  `);
  console.log("users new columns:", userCols.rows);

  if (userCols.rows.length !== 5) {
    throw new Error(
      `Expected 5 new columns, found ${userCols.rows.length}. Refusing to exit cleanly.`,
    );
  }
  for (const row of userCols.rows as Array<{ is_nullable: string; column_name: string }>) {
    if (row.is_nullable !== "YES") {
      throw new Error(`Column ${row.column_name} is NOT nullable — expected nullable.`);
    }
  }
  console.log("✓ All 5 columns present and nullable.");

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
