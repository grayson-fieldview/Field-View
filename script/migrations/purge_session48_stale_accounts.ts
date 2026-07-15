/**
 * purge_session48_stale_accounts.ts
 *
 * Deletes:
 *   1. Both Southern Brush Painting accounts (any user email @southernbrushpainting.com)
 *   2. All accounts where NO user has ever logged in (every users.last_active_at IS NULL)
 *
 * Default mode is DRY RUN (read-only). Deletion requires CONFIRM_DELETE=yes.
 *
 * Schema corrections vs. the original draft:
 *   - accounts has `name`, not `company_name`.
 *   - media has NO account_id — it is project-scoped (media.project_id); all
 *     media lookups/deletes go through projects.
 *   - media has no s3_key column; it stores the full `url`. S3 keys are
 *     derived the same way server/s3.ts extractS3KeyFromUrl does (pathname of
 *     CloudFront/S3 URLs).
 *   - "timesheets" is actually `time_entries` and DOES reference account_id
 *     directly (it also has a project_id FK with ON DELETE RESTRICT, so it
 *     must be deleted before projects).
 *   - auth_rate_limits is intentionally NOT touched (owned by
 *     rate-limiter-flexible). `sessions` has no FK (opaque jsonb) — skipped.
 */

import { db, pool } from "../../server/db";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

function assertSafeTarget() {
  const isRds = DATABASE_URL.includes("rds.amazonaws.com");
  const isNeon = DATABASE_URL.includes("neon.tech");
  if (!isRds && !isNeon) {
    throw new Error("REFUSING TO RUN: DATABASE_URL is neither RDS nor Neon. Aborting.");
  }
  if (isRds && process.env.ALLOW_PROD_MIGRATION !== "yes") {
    throw new Error("REFUSING TO RUN against prod RDS without ALLOW_PROD_MIGRATION=yes");
  }
  const host = DATABASE_URL.split("@")[1]?.split("/")[0] ?? "(unparseable)";
  console.log(`[purge] target DB host: ${host}`);
  console.log(`[purge] mode: ${process.env.CONFIRM_DELETE === "yes" ? "DELETE" : "DRY RUN (read-only)"}`);
}

// Accounts that must never be deleted regardless of criteria.
const PROTECTED_EMAIL_PATTERNS = [
  "%@palmbeach-painters.com",
  "%@field-view.com",
];

// Mirrors server/s3.ts extractS3KeyFromUrl (without importing the S3 client).
function s3KeyFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("cloudfront.net")) return u.pathname.slice(1);
    if (u.hostname.includes(".s3.") && u.hostname.endsWith("amazonaws.com")) {
      return u.pathname.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  assertSafeTarget();

  const candidates = await db.execute(sql`
    WITH colin_accounts AS (
      SELECT DISTINCT a.id
      FROM accounts a
      JOIN users u ON u.account_id = a.id
      WHERE u.email ILIKE '%@southernbrushpainting.com'
    ),
    never_logged_in AS (
      SELECT a.id
      FROM accounts a
      WHERE NOT EXISTS (
        SELECT 1 FROM users u
        WHERE u.account_id = a.id AND u.last_active_at IS NOT NULL
      )
    ),
    combined AS (
      SELECT id FROM colin_accounts
      UNION
      SELECT id FROM never_logged_in
    ),
    protected_accounts AS (
      SELECT DISTINCT u.account_id AS id
      FROM users u
      WHERE u.account_id IS NOT NULL
        AND u.email ILIKE ANY(ARRAY[${sql.join(
          PROTECTED_EMAIL_PATTERNS.map((p) => sql`${p}`),
          sql`, `,
        )}])
    )
    SELECT
      a.id,
      a.name,
      a.created_at,
      (SELECT string_agg(u.email || COALESCE(' [last login: ' || u.last_active_at::text || ']', ' [never logged in]'), '; ')
         FROM users u WHERE u.account_id = a.id) AS user_emails,
      (SELECT COUNT(*) FROM users u WHERE u.account_id = a.id) AS user_count,
      (SELECT COUNT(*) FROM projects p WHERE p.account_id = a.id) AS project_count,
      (SELECT COUNT(*) FROM media m JOIN projects p ON p.id = m.project_id WHERE p.account_id = a.id) AS media_count
    FROM accounts a
    WHERE a.id IN (SELECT id FROM combined)
      AND a.id NOT IN (SELECT id FROM protected_accounts)
    ORDER BY a.created_at
  `);

  const rows = candidates.rows as any[];
  if (rows.length === 0) {
    console.log("[purge] No accounts matched. Nothing to do.");
    return;
  }

  console.log(`\n[purge] ===== KILL LIST: ${rows.length} account(s) =====`);
  for (const r of rows) {
    console.log(
      `  - ${r.id} | ${r.name ?? "(no name)"} | signed up ${r.created_at} | users: ${r.user_count} | projects: ${r.project_count} | media: ${r.media_count}`,
    );
    console.log(`      ${r.user_emails ?? "(no users)"}`);
  }

  const accountIds = rows.map((r) => r.id);

  const mediaRows = await db.execute(sql`
    SELECT m.id, p.account_id, m.url
    FROM media m
    JOIN projects p ON p.id = m.project_id
    WHERE p.account_id = ANY(${accountIds})
  `);
  const media = mediaRows.rows as any[];
  if (media.length > 0) {
    console.log(`\n[purge] ===== S3 KEYS TO DELETE MANUALLY (${media.length}) =====`);
    for (const m of media) {
      console.log(`  ${s3KeyFromUrl(m.url) ?? `(non-S3 url: ${m.url})`}`);
    }
  } else {
    console.log("\n[purge] No media rows — nothing to clean in S3.");
  }

  if (process.env.CONFIRM_DELETE !== "yes") {
    console.log("\n[purge] DRY RUN complete. No rows deleted. Re-run with CONFIRM_DELETE=yes to delete.");
    return;
  }

  await db.transaction(async (tx) => {
    const del = async (label: string, query: any) => {
      const res = await tx.execute(query);
      console.log(`[purge] deleted from ${label}: ${res.rowCount ?? "?"} row(s)`);
    };
    // Scoping CTE fragments (inlined per statement).
    const A = accountIds;
    const projSel = sql`SELECT id FROM projects WHERE account_id = ANY(${A})`;
    const userSel = sql`SELECT id FROM users WHERE account_id = ANY(${A})`;
    const mediaSel = sql`SELECT id FROM media WHERE project_id IN (${projSel})`;
    const checklistSel = sql`SELECT id FROM checklists WHERE project_id IN (${projSel})`;
    const itemSel = sql`SELECT id FROM checklist_items WHERE checklist_id IN (${checklistSel})`;
    const reportSel = sql`SELECT id FROM reports WHERE account_id = ANY(${A}) OR project_id IN (${projSel})`;
    const sectionSel = sql`SELECT id FROM report_sections WHERE report_id IN (${reportSel})`;
    const tplSel = sql`SELECT id FROM checklist_templates WHERE account_id = ANY(${A})`;
    const tplSectionSel = sql`SELECT id FROM checklist_template_sections WHERE template_id IN (${tplSel})`;
    const tplItemSel = sql`SELECT id FROM checklist_template_items WHERE template_id IN (${tplSel})`;

    // 1. Media-level children
    await del("media_annotations", sql`DELETE FROM media_annotations WHERE media_id IN (${mediaSel}) OR user_id IN (${userSel})`);
    await del("checklist_item_photos", sql`DELETE FROM checklist_item_photos WHERE media_id IN (${mediaSel}) OR item_id IN (${itemSel})`);
    await del("report_section_photos", sql`DELETE FROM report_section_photos WHERE media_id IN (${mediaSel}) OR section_id IN (${sectionSel})`);
    await del("comparison_shares", sql`DELETE FROM comparison_shares WHERE project_id IN (${projSel}) OR before_media_id IN (${mediaSel}) OR after_media_id IN (${mediaSel})`);
    await del("shared_galleries", sql`DELETE FROM shared_galleries WHERE project_id IN (${projSel})`);

    // 2. Checklist tree (options → items → sections → checklists)
    await del("checklist_item_options", sql`DELETE FROM checklist_item_options WHERE item_id IN (${itemSel})`);
    await del("checklist_items", sql`DELETE FROM checklist_items WHERE checklist_id IN (${checklistSel})`);
    await del("checklist_sections", sql`DELETE FROM checklist_sections WHERE checklist_id IN (${checklistSel})`);
    await del("checklists", sql`DELETE FROM checklists WHERE project_id IN (${projSel})`);

    // 3. Reports tree (section photos already gone)
    await del("report_sections", sql`DELETE FROM report_sections WHERE report_id IN (${reportSel})`);
    await del("reports", sql`DELETE FROM reports WHERE account_id = ANY(${A}) OR project_id IN (${projSel})`);

    // 4. Project-scoped rows
    await del("tasks", sql`DELETE FROM tasks WHERE project_id IN (${projSel})`);
    await del("pending_geofence_exits", sql`DELETE FROM pending_geofence_exits WHERE account_id = ANY(${A}) OR user_id IN (${userSel})`);
    await del("pending_geofence_enters", sql`DELETE FROM pending_geofence_enters WHERE account_id = ANY(${A}) OR user_id IN (${userSel})`);
    await del("time_entries", sql`DELETE FROM time_entries WHERE account_id = ANY(${A}) OR user_id IN (${userSel})`); // BEFORE projects (project_id FK is ON DELETE RESTRICT)
    await del("project_assignments", sql`DELETE FROM project_assignments WHERE project_id IN (${projSel}) OR user_id IN (${userSel})`);
    await del("media", sql`DELETE FROM media WHERE project_id IN (${projSel})`);
    await del("projects", sql`DELETE FROM projects WHERE account_id = ANY(${A})`);

    // 5. Account-scoped rows
    await del("calendar_events", sql`DELETE FROM calendar_events WHERE account_id = ANY(${A})`);
    await del("calendar_connections", sql`DELETE FROM calendar_connections WHERE account_id = ANY(${A}) OR user_id IN (${userSel})`);
    await del("account_tags", sql`DELETE FROM account_tags WHERE account_id = ANY(${A})`);
    await del("api_keys", sql`DELETE FROM api_keys WHERE account_id = ANY(${A})`);
    await del("report_templates", sql`DELETE FROM report_templates WHERE account_id = ANY(${A})`);
    await del("checklist_template_item_options", sql`DELETE FROM checklist_template_item_options WHERE item_id IN (${tplItemSel})`);
    await del("checklist_template_items", sql`DELETE FROM checklist_template_items WHERE template_id IN (${tplSel}) OR section_id IN (${tplSectionSel})`);
    await del("checklist_template_sections", sql`DELETE FROM checklist_template_sections WHERE template_id IN (${tplSel})`);
    await del("checklist_templates", sql`DELETE FROM checklist_templates WHERE account_id = ANY(${A})`);
    await del("invitations", sql`DELETE FROM invitations WHERE account_id = ANY(${A}) OR invited_by_id IN (${userSel})`);

    // 6. User-scoped auth rows
    await del("password_reset_tokens", sql`DELETE FROM password_reset_tokens WHERE user_id IN (${userSel})`);
    await del("email_verification_tokens", sql`DELETE FROM email_verification_tokens WHERE user_id IN (${userSel})`);

    // 7. Global checklist_templates (account_id NULL) may reference purged
    //    users via created_by_id — NULL them out instead of deleting.
    const tplNull = await tx.execute(sql`UPDATE checklist_templates SET created_by_id = NULL WHERE created_by_id IN (${userSel})`);
    console.log(`[purge] nulled checklist_templates.created_by_id: ${tplNull.rowCount ?? "?"} row(s)`);

    // 8. Users, then accounts
    await del("users", sql`DELETE FROM users WHERE account_id = ANY(${A})`);
    await del("accounts", sql`DELETE FROM accounts WHERE id = ANY(${A})`);

    // NOTE: auth_rate_limits intentionally untouched (rate-limiter-flexible
    // owns it). sessions has no user FK (opaque jsonb) — stale sessions for
    // deleted users will 401 and expire naturally.
  });

  console.log("\n[purge] DONE. Verify in TablePlus and remove the Replit IP from the RDS SG.");
}

main()
  .catch((err) => {
    console.error("[purge] FAILED — transaction rolled back:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
