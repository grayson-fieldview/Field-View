import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const connectionConfig: pg.PoolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: process.env.VERCEL ? 1 : 10,
  idleTimeoutMillis: 10000,
};

if (process.env.DATABASE_URL?.includes("rds.amazonaws.com")) {
  connectionConfig.ssl = { rejectUnauthorized: false };
}

export const pool = new Pool(connectionConfig);
export const db = drizzle(pool, { schema });
