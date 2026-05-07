import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

// Session 35 — signup v2 schema additions.
//
// Background: the redesigned 2-step signup flow collects additional profile
// data after account creation. Step 1 stays minimal (company name + email +
// password + terms). Step 2 (post-verification, on first login) captures
// first/last name, phone, industry, company size + TCPA. To support that
// without breaking existing rows we add four nullable columns:
//
//   users.phone                  varchar  (free-form contact phone)
//   users.profile_completed_at   timestamp (gate for the step-2 prompt)
//   accounts.industry            varchar  (e.g. "Roofing", "HVAC", ...)
//   accounts.company_size        varchar  (bucket label, e.g. "6-20")
//
// Mirrored in shared/models/auth.ts (users + accounts) for drizzle-kit
// awareness. All four columns are nullable — existing accounts and users
// remain valid; the frontend treats null profile_completed_at as "needs
// step 2".

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
      "Set the flag explicitly to confirm this is intentional."
    );
  }

  const host = url.match(/@([^/?]+)/)?.[1] ?? "unknown";
  console.log(`Target DB host: ${host}`);
  console.log(`Mode: ${isRds ? "PRODUCTION RDS" : "Neon dev"}`);
  if (isRds) console.log("⚠️  PROD migration — ALLOW_PROD_MIGRATION=yes confirmed");

  console.log("Session 35 migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar
    `);
    console.log("✓ users.phone");

    await tx.execute(sql`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed_at timestamp
    `);
    console.log("✓ users.profile_completed_at");

    await tx.execute(sql`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS industry varchar
    `);
    console.log("✓ accounts.industry");

    await tx.execute(sql`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS company_size varchar
    `);
    console.log("✓ accounts.company_size");
  });

  console.log("\nTransaction committed. Verifying...");

  const userCols = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='users'
       AND column_name IN ('phone', 'profile_completed_at')
     ORDER BY column_name
  `);
  console.log("users new columns:", userCols.rows);

  const accountCols = await db.execute(sql`
    SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name='accounts'
       AND column_name IN ('industry', 'company_size')
     ORDER BY column_name
  `);
  console.log("accounts new columns:", accountCols.rows);

  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
