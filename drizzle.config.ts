import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

let dbUrl = process.env.DATABASE_URL;
if (dbUrl.includes("rds.amazonaws.com") && !dbUrl.includes("sslmode=")) {
  dbUrl += (dbUrl.includes("?") ? "&" : "?") + "sslmode=no-verify";
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
  },
});
