// Read-only drift diagnostic: compares every pgTable/pgEnum declared in
// shared/models/auth.ts + shared/schema.ts against the actual dev Neon DB
// (public schema). Outputs a Markdown-style report to stdout.
//
// SAFETY: refuses to run if DATABASE_URL points at RDS. Read-only — no DDL,
// no DML. Run with: npx tsx script/diagnose_dev_drift.ts

import { getTableConfig, PgEnum, PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as authSchema from "../shared/models/auth";
import * as appSchema from "../shared/schema";

if (process.env.DATABASE_URL?.includes("rds.amazonaws.com")) {
  console.error("REFUSING: DATABASE_URL points at RDS. This is a dev-only diagnostic.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set.");
  process.exit(1);
}

interface DrizzleColumn {
  name: string;
  sqlType: string;
  notNull: boolean;
  hasDefault: boolean;
}
interface DrizzleTable {
  name: string;
  columns: DrizzleColumn[];
  source: string;
}
interface DbColumn {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
}

function collectTables(modules: Record<string, any>[], sourceLabels: string[]): DrizzleTable[] {
  const out: DrizzleTable[] = [];
  modules.forEach((mod, idx) => {
    for (const [, exp] of Object.entries(mod)) {
      if (exp && typeof exp === "object" && (exp as any)[Symbol.for("drizzle:IsDrizzleTable")]) {
        const cfg = getTableConfig(exp as PgTable);
        out.push({
          name: cfg.name,
          source: sourceLabels[idx],
          columns: cfg.columns.map((c) => ({
            name: c.name,
            sqlType: c.getSQLType(),
            notNull: c.notNull,
            hasDefault: c.hasDefault,
          })),
        });
      }
    }
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function collectEnums(modules: Record<string, any>[]): { name: string; values: string[] }[] {
  const out: { name: string; values: string[] }[] = [];
  for (const mod of modules) {
    for (const [, exp] of Object.entries(mod)) {
      if (exp && typeof exp === "function" && (exp as any).enumName && (exp as any).enumValues) {
        const e = exp as unknown as PgEnum<[string, ...string[]]>;
        out.push({ name: (e as any).enumName, values: (e as any).enumValues });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const drizzleTables = collectTables([authSchema, appSchema], ["shared/models/auth.ts", "shared/schema.ts"]);
  const drizzleEnums = collectEnums([authSchema, appSchema]);

  // ---- DB-side fetches ----
  const dbCols = await pool.query<DbColumn>(`
    SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name;
  `);
  const dbTablesQ = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    ORDER BY table_name;
  `);
  const dbEnumsQ = await pool.query<{ typname: string; values: string }>(`
    SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS values
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    GROUP BY t.typname
    ORDER BY t.typname;
  `);

  const dbTables = new Set(dbTablesQ.rows.map((r) => r.table_name));
  const dbEnums = new Map(dbEnumsQ.rows.map((r) => [r.typname, r.values.split(",")]));
  const dbColsByTable: Record<string, DbColumn[]> = {};
  for (const r of dbCols.rows) {
    (dbColsByTable[(r as any).table_name] ??= []).push(r);
  }

  // ---- Report ----
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);

  log("# Dev Neon Drift Report");
  log("");
  log(`- Drizzle tables declared: ${drizzleTables.length}`);
  log(`- Drizzle enums declared:  ${drizzleEnums.length}`);
  log(`- DB tables in public:     ${dbTables.size}`);
  log(`- DB enums in public:      ${dbEnums.size}`);
  log("");

  // 1. Missing tables
  const drizzleTableNames = new Set(drizzleTables.map((t) => t.name));
  const missingTables = drizzleTables.filter((t) => !dbTables.has(t.name));
  const extraTables = [...dbTables].filter((t) => !drizzleTableNames.has(t) && t !== "sessions");

  log("## 1. Tables missing in dev DB (declared in Drizzle, absent in DB)");
  if (missingTables.length === 0) log("_None._");
  for (const t of missingTables) {
    log(`- **${t.name}** (${t.source}) — ${t.columns.length} columns`);
  }
  log("");

  log("## 2. Tables in dev DB but NOT in Drizzle (orphans — flag, do not drop)");
  if (extraTables.length === 0) log("_None._");
  for (const t of extraTables) log(`- **${t}**`);
  log("");

  // 2. Missing enums
  const drizzleEnumNames = new Set(drizzleEnums.map((e) => e.name));
  const missingEnums = drizzleEnums.filter((e) => !dbEnums.has(e.name));
  const extraEnums = [...dbEnums.keys()].filter((n) => !drizzleEnumNames.has(n));
  const enumValueMismatch = drizzleEnums.filter((e) => {
    const dbVals = dbEnums.get(e.name);
    if (!dbVals) return false;
    return dbVals.join(",") !== e.values.join(",");
  });

  log("## 3. Enums missing in dev DB");
  if (missingEnums.length === 0) log("_None._");
  for (const e of missingEnums) log(`- **${e.name}** values=[${e.values.join(", ")}]`);
  log("");

  log("## 4. Enums in dev DB but NOT in Drizzle (orphans)");
  if (extraEnums.length === 0) log("_None._");
  for (const n of extraEnums) log(`- **${n}**`);
  log("");

  log("## 5. Enum value-set mismatches (name exists in both but values differ)");
  if (enumValueMismatch.length === 0) log("_None._");
  for (const e of enumValueMismatch) {
    log(`- **${e.name}** drizzle=[${e.values.join(", ")}] db=[${dbEnums.get(e.name)!.join(", ")}]`);
  }
  log("");

  // 3. Column-level diff per table that EXISTS in both
  log("## 6. Column drift (per table that exists in both Drizzle and DB)");
  log("");
  let cleanCount = 0;
  for (const t of drizzleTables) {
    if (!dbTables.has(t.name)) continue;
    const dbCols = dbColsByTable[t.name] ?? [];
    const dbColMap = new Map(dbCols.map((c) => [c.column_name, c]));
    const drizzleColMap = new Map(t.columns.map((c) => [c.name, c]));

    const missingInDb = t.columns.filter((c) => !dbColMap.has(c.name));
    const extraInDb = dbCols.filter((c) => !drizzleColMap.has(c.column_name));

    if (missingInDb.length === 0 && extraInDb.length === 0) {
      cleanCount++;
      continue;
    }

    log(`### \`${t.name}\` (${t.source})`);
    if (missingInDb.length > 0) {
      log(`  Missing in DB (need ADD COLUMN):`);
      for (const c of missingInDb) {
        const nn = c.notNull ? " NOT NULL" : "";
        const def = c.hasDefault ? " (has Drizzle default)" : "";
        log(`    - \`${c.name}\` ${c.sqlType}${nn}${def}`);
      }
    }
    if (extraInDb.length > 0) {
      log(`  In DB but NOT in Drizzle (flag, do not drop):`);
      for (const c of extraInDb) {
        log(`    - \`${c.column_name}\` ${c.data_type}${c.udt_name !== c.data_type ? ` (${c.udt_name})` : ""}${c.is_nullable === "NO" ? " NOT NULL" : ""}`);
      }
    }
    log("");
  }
  log(`_${cleanCount} table(s) had zero column drift and were omitted._`);

  console.log(lines.join("\n"));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
