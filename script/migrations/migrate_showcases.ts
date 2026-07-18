import { db } from "../../server/db";
import { sql } from "drizzle-orm";

// Showcases feature (public portfolio): 2 enums + 4 tables.
// Matches the dev Neon schema exactly (created there via raw SQL; verified
// against \d output). Additive only — no ALTERs or DROPs on existing objects.
//
// Run procedure (same as prior sessions):
//   1. Snapshot RDS
//   2. Whitelist Replit egress IP on the RDS security group
//   3. DATABASE_URL=<rds-url> ALLOW_PROD_MIGRATION=yes npx tsx script/migrations/migrate_showcases.ts
//   4. Verify output, then remove the Replit IP from the RDS SG

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

  console.log("Showcases migration starting...");

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE showcase_status AS ENUM ('draft', 'published');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    console.log("✓ showcase_status enum");

    await tx.execute(sql`
      DO $$ BEGIN
        CREATE TYPE showcase_pair_role AS ENUM ('before', 'after');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    console.log("✓ showcase_pair_role enum");

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS showcases (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        account_id varchar NOT NULL REFERENCES accounts(id),
        project_id integer REFERENCES projects(id) ON DELETE SET NULL,
        title text NOT NULL,
        slug text NOT NULL,
        description text,
        project_types text[] DEFAULT '{}'::text[] NOT NULL,
        products_used text[] DEFAULT '{}'::text[] NOT NULL,
        status showcase_status DEFAULT 'draft' NOT NULL,
        cover_media_id integer REFERENCES media(id) ON DELETE SET NULL,
        display_lat real,
        display_lng real,
        location_label text,
        published_at timestamp,
        created_by_id varchar REFERENCES users(id),
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      )
    `);
    console.log("✓ showcases table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS showcases_account_id_idx ON showcases (account_id)
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS showcases_account_slug_idx ON showcases (account_id, slug)
    `);
    console.log("✓ showcases indexes");

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS showcase_photos (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        showcase_id integer NOT NULL REFERENCES showcases(id) ON DELETE CASCADE,
        media_id integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        sort_order integer DEFAULT 0 NOT NULL,
        caption text,
        pair_group_id varchar(36),
        pair_role showcase_pair_role
      )
    `);
    console.log("✓ showcase_photos table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS showcase_photos_showcase_id_idx ON showcase_photos (showcase_id)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS showcase_photos_media_id_idx ON showcase_photos (media_id)
    `);
    console.log("✓ showcase_photos indexes");

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS showcase_settings (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        account_id varchar NOT NULL UNIQUE REFERENCES accounts(id),
        portfolio_enabled boolean DEFAULT false NOT NULL,
        portfolio_slug varchar(60) UNIQUE,
        display_name text,
        logo_url text,
        brand_color varchar(9),
        show_map boolean DEFAULT true NOT NULL,
        contact_cta_enabled boolean DEFAULT false NOT NULL,
        contact_cta_label text,
        contact_cta_url text,
        intro_text text,
        showcase_tags text[] DEFAULT '{}'::text[] NOT NULL,
        created_at timestamp DEFAULT now() NOT NULL,
        updated_at timestamp DEFAULT now() NOT NULL
      )
    `);
    console.log("✓ showcase_settings table");

    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS showcase_views (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        account_id varchar NOT NULL REFERENCES accounts(id),
        showcase_id integer REFERENCES showcases(id) ON DELETE CASCADE,
        viewed_at timestamp DEFAULT now() NOT NULL,
        referrer text
      )
    `);
    console.log("✓ showcase_views table");

    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS showcase_views_account_viewed_idx ON showcase_views (account_id, viewed_at)
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS showcase_views_showcase_id_idx ON showcase_views (showcase_id)
    `);
    console.log("✓ showcase_views indexes");
  });

  console.log("\nTransaction committed. Verifying...");
  const tables = await db.execute(sql`
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename LIKE 'showcase%'
     ORDER BY tablename
  `);
  console.log("showcase tables:", tables.rows.map((r: any) => r.tablename));
  if (tables.rows.length !== 4) {
    throw new Error(`Verification FAILED: expected 4 showcase tables, found ${tables.rows.length}`);
  }

  const enums = await db.execute(sql`
    SELECT typname FROM pg_type WHERE typtype = 'e' AND typname LIKE 'showcase%' ORDER BY typname
  `);
  console.log("showcase enums:", enums.rows.map((r: any) => r.typname));
  if (enums.rows.length !== 2) {
    throw new Error(`Verification FAILED: expected 2 showcase enums, found ${enums.rows.length}`);
  }

  console.log("\n✅ Showcases migration complete.");
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Migration failed:", e);
    process.exit(1);
  });
