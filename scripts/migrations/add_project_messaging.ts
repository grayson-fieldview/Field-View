/**
 * Migration — project messaging + notifications
 *
 *   project_messages      — one thread per project; mentions varchar[]
 *   project_thread_reads  — per-user-per-thread last-read watermark
 *   notifications         — personally-directed inbox rows (mentions,
 *                           task assignments) with nullable read_at
 *
 * No backfill — all three tables start empty.
 *
 * Safety rails (house pattern):
 *   - Single transaction; IF NOT EXISTS guards (idempotent, safe to re-run).
 *   - DATABASE_URL host must contain rds.amazonaws.com (prod) or neon.tech
 *     (dev); anything else is refused.
 *   - RDS (prod) additionally requires ALLOW_PROD_MIGRATION=yes.
 *   - Entry-point guard: importing this file does nothing.
 *
 * DO NOT run automatically. Run manually:
 *   Dev (Neon):  npx tsx scripts/migrations/add_project_messaging.ts
 *   Prod (RDS):  ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *                  npx tsx scripts/migrations/add_project_messaging.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

export async function addProjectMessaging(): Promise<void> {
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

  console.log(`[add_project_messaging] host=${host} mode=${isRds ? "PROD (RDS)" : "DEV (Neon)"}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    console.log("[add_project_messaging] 1/5 CREATE TABLE project_messages ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS project_messages (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id),
        content text NOT NULL,
        mentions varchar[] NOT NULL DEFAULT '{}',
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS project_messages_project_created_idx
        ON project_messages (project_id, created_at)
    `);

    console.log("[add_project_messaging] 2/5 CREATE TABLE project_thread_reads ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS project_thread_reads (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        last_read_at timestamp NOT NULL
      )
    `);
    await tx.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS project_thread_reads_project_user_idx
        ON project_thread_reads (project_id, user_id)
    `);

    console.log("[add_project_messaging] 3/5 CREATE TABLE notifications ...");
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS notifications (
        id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        user_id varchar NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id varchar NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        type text NOT NULL,
        project_id integer REFERENCES projects(id) ON DELETE CASCADE,
        message_id integer REFERENCES project_messages(id) ON DELETE CASCADE,
        task_id integer REFERENCES tasks(id) ON DELETE CASCADE,
        actor_user_id varchar REFERENCES users(id),
        read_at timestamp,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("[add_project_messaging] 4/5 notifications (user_id, created_at) index ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS notifications_user_created_idx
        ON notifications (user_id, created_at)
    `);
    console.log("[add_project_messaging] 5/5 notifications partial unread index ...");
    await tx.execute(sql`
      CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
        ON notifications (user_id) WHERE read_at IS NULL
    `);
  });

  console.log("[add_project_messaging] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  addProjectMessaging()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[add_project_messaging] FAILED:", err?.message || err);
      process.exit(1);
    });
}
