import { db } from "../db";
import { timeEntries, type TimeEntry } from "@shared/schema";
import { users } from "@shared/models/auth";
import { eq } from "drizzle-orm";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * S33: server-authoritative dwell window for auto clock-IN.
 * Mobile posts /api/geofence/enter-detected immediately on geofence entry; server
 * holds for this duration before firing the clock-in via cron, allowing mobile to
 * cancel via /api/geofence/enter-cancelled if the user exits within the window
 * (drive-by, mis-trigger, etc.).
 *
 * Hardcoded — not per-user, not per-project. Single-file edit + redeploy to change.
 * Mobile is intentionally NOT told the value; clients post on detect, server decides
 * when to fire.
 */
export const AUTO_CLOCK_IN_DWELL_MS = 60_000;

/**
 * Server-authoritative auto clock-out execution.
 *
 * Called by:
 *   - GET /api/cron/process-pending-exits when a 5-min S32a debounce expires
 *   (POST /api/timesheets/clock-out remains user-initiated and is NOT routed here —
 *    it has its own concerns like notes concatenation and rate snapshots.)
 *
 * Audit trail: writes editedAt=now and editedByUserId=userId so the row records
 * "system acted on behalf of user" — symmetric with how a user-initiated edit
 * would be marked.
 *
 * Does NOT send notifications; that's S32b.
 *
 * Accepts an optional tx so the cron can wrap entry-update + pending-row-mark
 * in a single atomic transaction.
 */
export async function executeAutoClockOut(
  opts: { timeEntryId: string; userId: string; clockOutAt?: Date },
  exec: DbOrTx = db,
): Promise<TimeEntry | undefined> {
  // editAt is always wall-clock-now (audit: when the system actually performed
  // the edit). clockOut is the *shift end time* — defaults to now for the
  // exit cron path, but the max-shift safety net (12h orphan cleanup) passes
  // a clamped value (clock_in + 8h) so payroll reflects a reasonable shift
  // length, not a 12+ hour ghost shift. Audit fields still record now, so the
  // edit history shows when the system intervened.
  const editAt = new Date();
  const clockOut = opts.clockOutAt ?? editAt;
  // Snapshot the user's current hourly rate onto the entry — mirrors what
  // POST /api/timesheets/clock-out does for user-initiated closures
  // (server/routes.ts ~line 2125). Without this, auto-geofence entries land
  // with rate_cents_snapshot = NULL and break labor-cost aggregation in
  // /timesheets. ?? null preserves the "user has no configured rate" case
  // exactly as the manual path does. Uses the same `exec` so this read
  // participates in the cron's per-row transaction.
  const [fresh] = await exec
    .select({ hourlyRateCents: users.hourlyRateCents })
    .from(users)
    .where(eq(users.id, opts.userId))
    .limit(1);
  const rateCentsSnapshot = fresh?.hourlyRateCents ?? null;

  const [updated] = await exec
    .update(timeEntries)
    .set({
      clockOut,
      editedAt: editAt,
      editedByUserId: opts.userId,
      updatedAt: editAt,
      rateCentsSnapshot,
    })
    .where(eq(timeEntries.id, opts.timeEntryId))
    .returning();
  return updated;
}

/**
 * S33: server-authoritative auto clock-IN execution.
 *
 * Called by:
 *   - GET /api/cron/process-pending-enters when the 60s dwell expires.
 *
 * Mirrors POST /api/timesheets/clock-in (server/routes.ts ~line 3253) with these
 * differences from the manual path:
 *   - source is fixed to "auto_geofence" (caller may override but shouldn't).
 *   - rate_cents_snapshot is captured here at insert time (manual path leaves it null).
 *     This makes auto-clocked-in entries immediately price-accurate for /timesheets
 *     aggregation without waiting for clock-out's snapshot pass.
 *   - editedAt / editedByUserId are NOT set: those audit fields denote a *modification*
 *     of an existing row, not the initial insert. Manual /clock-in leaves them null too.
 *
 * May throw Postgres error 23505 if the partial unique index
 * `time_entries_one_active_per_user` (clock_out IS NULL) catches a concurrent
 * insert — caller MUST handle this as a "race: already clocked in" outcome,
 * not a generic failure.
 *
 * Accepts an optional tx so the cron can wrap row-recheck + entry-insert + pending-mark
 * in a single atomic transaction.
 */
export async function executeAutoClockIn(
  opts: { accountId: string; userId: string; projectId: number; source?: "auto_geofence" },
  exec: DbOrTx = db,
): Promise<TimeEntry> {
  const now = new Date();
  const [fresh] = await exec
    .select({ hourlyRateCents: users.hourlyRateCents })
    .from(users)
    .where(eq(users.id, opts.userId))
    .limit(1);
  const rateCentsSnapshot = fresh?.hourlyRateCents ?? null;

  const [created] = await exec
    .insert(timeEntries)
    .values({
      accountId: opts.accountId,
      userId: opts.userId,
      projectId: opts.projectId,
      clockIn: now,
      clockOut: null,
      source: opts.source ?? "auto_geofence",
      notes: null,
      rateCentsSnapshot,
    } as any)
    .returning();
  return created;
}
