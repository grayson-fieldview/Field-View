/**
 * Cleanup — hard-delete test accounts (PROD, manual, reviewed IDs only)
 *
 * Hard-deletes the accounts listed in ACCOUNT_IDS below, plus their users and
 * every dependent row, child-first. The FK graph has NO cascades from
 * accounts (all account-level FKs are NO ACTION) and mostly NO ACTION FKs
 * from users, so the order below is load-bearing — do not reorder.
 *
 * Deletion order rationale:
 *   1. Leaf rows keyed by media/task/checklist/showcase (comments,
 *      annotations, task_photos, showcase_photos, checklist_items, ...).
 *   2. time_entries BEFORE projects (projects FK is ON DELETE RESTRICT),
 *      and pending_geofence_* BEFORE time_entries (they reference them).
 *   3. Project-scoped tables (media, tasks, checklists, reports,
 *      shared_galleries, project_files, project_assignments).
 *   4. Account-scoped tables (showcases, calendar, invitations, api_keys,
 *      report_templates, account_tags, telemetry).
 *   5. sessions rows whose passport user is one of the deleted users
 *      (no FK — dead sids would otherwise 401-loop those clients).
 *   6. users, then accounts.
 *
 * Every table is existence-checked via to_regclass() first: prod RDS and dev
 * Neon are known to drift, and a missing optional table (e.g. a telemetry
 * table not yet migrated) must not abort the transaction. A missing CORE
 * table (users/accounts/projects) still fails loudly.
 *
 * Safety rails (per scripts/migrations/ standards):
 *   - Single db.transaction() — all-or-nothing.
 *   - DATABASE_URL host MUST contain rds.amazonaws.com (prod-only script;
 *     dev/Neon is refused — run against dev by relaxing nothing, this
 *     script is not for dev).
 *   - ALLOW_PROD_MIGRATION=yes required.
 *   - Entry-point guard: importing this file does nothing.
 *   - Host logged without credentials.
 *
 * DO NOT run automatically. Run manually after reviewing ACCOUNT_IDS:
 *   ALLOW_PROD_MIGRATION=yes DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *     npx tsx scripts/migrations/cleanup_test_accounts.ts
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { sql } from "drizzle-orm";

// ─── REVIEW BEFORE RUNNING ──────────────────────────────────────────────────
// Hardcoded, explicitly reviewed list of account IDs to hard-delete.
// EMPTY by default so an accidental run deletes nothing.
const ACCOUNT_IDS: string[] = [
  // "acct-id-1",
  // "acct-id-2",
];
// ────────────────────────────────────────────────────────────────────────────

export async function cleanupTestAccounts(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — refusing to run.");

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL — refusing to run.");
  }
  // Strict DNS suffix match — .includes() would let a hostile hostname like
  // "rds.amazonaws.com.attacker.example" pass the prod-only rail.
  if (!host.endsWith(".rds.amazonaws.com")) {
    throw new Error(
      `DATABASE_URL host "${host}" is not *.rds.amazonaws.com — this script targets production RDS only, refusing to run.`,
    );
  }
  if (process.env.ALLOW_PROD_MIGRATION !== "yes") {
    throw new Error("Target is production RDS. Set ALLOW_PROD_MIGRATION=yes to proceed.");
  }
  if (ACCOUNT_IDS.length === 0) {
    throw new Error("ACCOUNT_IDS is empty — nothing to delete. Edit the reviewed list first.");
  }

  console.log(`[cleanup_test_accounts] host=${host} accounts=${ACCOUNT_IDS.length}`);

  const { db } = await import("../../server/db");

  await db.transaction(async (tx) => {
    const ids = ACCOUNT_IDS;

    const exists = async (table: string): Promise<boolean> => {
      // Table may be schema-qualified (e.g. "stripe.customers"); default public.
      const qualified = table.includes(".") ? table : "public." + table;
      const r: any = await tx.execute(
        sql`SELECT to_regclass(${qualified}) IS NOT NULL AS present`,
      );
      return !!r.rows?.[0]?.present;
    };

    // Runs a DELETE and logs its row count. `core` tables must exist;
    // optional tables are skipped with a warning when absent (dev/prod drift).
    const del = async (
      table: string,
      where: ReturnType<typeof sql>,
      opts: { core?: boolean } = {},
    ): Promise<void> => {
      if (!(await exists(table))) {
        if (opts.core) throw new Error(`Core table "${table}" missing — aborting.`);
        console.warn(`[cleanup_test_accounts] SKIP ${table} (table does not exist)`);
        return;
      }
      const r: any = await tx.execute(sql`DELETE FROM ${sql.raw(table)} WHERE ${where}`);
      console.log(`[cleanup_test_accounts] ${table}: ${r.rowCount ?? 0} deleted`);
    };

    // Scope subqueries — resolved inside SQL so no huge ID lists round-trip.
    const inAccounts = (col: string) => sql`${sql.raw(col)} = ANY(${ids})`;
    const uids = sql`(SELECT id FROM users WHERE account_id = ANY(${ids}))`;
    const pids = sql`(SELECT id FROM projects WHERE account_id = ANY(${ids}))`;
    const mids = sql`(SELECT id FROM media WHERE project_id IN ${pids})`;
    const tids = sql`(SELECT id FROM tasks WHERE project_id IN ${pids})`;
    const clids = sql`(SELECT id FROM checklists WHERE project_id IN ${pids})`;
    const scids = sql`(SELECT id FROM showcases WHERE account_id = ANY(${ids}))`;

    // 1 — media/task/checklist/showcase leaves
    await del("comments", sql`media_id IN ${mids}`);
    await del("media_annotations", sql`media_id IN ${mids}`);
    await del("task_photos", sql`task_id IN ${tids} OR media_id IN ${mids}`);
    await del("showcase_photos", sql`showcase_id IN ${scids} OR media_id IN ${mids}`);
    await del("showcase_views", inAccounts("account_id"));
    await del("checklist_items", sql`checklist_id IN ${clids}`);
    await del("checklist_sections", sql`checklist_id IN ${clids}`);

    // 2 — geofence + time entries (BEFORE projects: time_entries is RESTRICT)
    await del("pending_geofence_enters", inAccounts("account_id"));
    await del("pending_geofence_exits", inAccounts("account_id"));
    await del("time_entries", inAccounts("account_id"));

    // 3 — project-scoped
    await del("media", sql`project_id IN ${pids}`);
    await del("tasks", sql`project_id IN ${pids}`);
    await del("checklists", sql`project_id IN ${pids}`);
    await del("reports", inAccounts("account_id"));
    await del("shared_galleries", sql`project_id IN ${pids}`);
    await del("project_files", sql`project_id IN ${pids}`);
    await del("project_assignments", sql`project_id IN ${pids}`);

    // 4 — account-scoped
    await del("showcases", inAccounts("account_id"));
    await del("showcase_settings", inAccounts("account_id"));
    await del("calendar_events", inAccounts("account_id"));
    await del("calendar_connections", inAccounts("account_id"));
    await del("invitations", inAccounts("account_id"));
    await del("api_keys", inAccounts("account_id"));
    await del("report_templates", inAccounts("account_id"));
    await del("checklist_templates", inAccounts("account_id"));
    await del("account_tags", inAccounts("account_id"));
    await del("app_install_prompt_events", inAccounts("account_id"));

    // 5 — auth leaves + sessions (no FK; sess->passport->user is the sid owner)
    await del("email_verification_tokens", sql`user_id IN ${uids}`);
    await del("password_reset_tokens", sql`user_id IN ${uids}`);
    // Cast to text: sess->>... yields text, users.id is uuid in prod.
    await del(
      "sessions",
      sql`sess->'passport'->>'user' IN (SELECT id::text FROM users WHERE account_id = ANY(${ids}))`,
    );

    // 5b — Stripe-connector mirror tables (stripe schema). All FK accounts.id
    // with NO ACTION, so surviving rows block the accounts delete. All
    // optional (to_regclass-checked) — absent tables just skip. Data column
    // is _account_id except the two connector-internal tables.
    const stripeMirrorTables = [
      "stripe.checkout_session_line_items",
      "stripe.checkout_sessions",
      "stripe.subscription_items",
      "stripe.subscription_schedules",
      "stripe.subscriptions",
      "stripe.invoices",
      "stripe.credit_notes",
      "stripe.charges",
      "stripe.refunds",
      "stripe.disputes",
      "stripe.early_fraud_warnings",
      "stripe.reviews",
      "stripe.payment_intents",
      "stripe.payment_methods",
      "stripe.setup_intents",
      "stripe.tax_ids",
      "stripe.customers",
      "stripe.plans",
      "stripe.prices",
      "stripe.products",
      "stripe.features",
    ];
    for (const t of stripeMirrorTables) {
      await del(t, sql`_account_id = ANY(${ids})`);
    }
    await del("stripe._managed_webhooks", inAccounts("account_id"));
    await del("stripe._sync_status", inAccounts("account_id"));

    // 6 — parents last
    await del("projects", inAccounts("account_id"), { core: true });
    await del("users", inAccounts("account_id"), { core: true });
    await del("accounts", sql`id = ANY(${ids})`, { core: true });
  });

  console.log("[cleanup_test_accounts] done.");
}

// Entry-point guard — never auto-executes on import.
const isDirectExecution =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  cleanupTestAccounts()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[cleanup_test_accounts] FAILED:", err?.message || err);
      process.exit(1);
    });
}
