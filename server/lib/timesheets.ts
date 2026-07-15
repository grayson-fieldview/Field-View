import { db } from "../db";
import { timeEntries, type TimeEntry } from "@shared/schema";
import { users } from "@shared/models/auth";
import { eq } from "drizzle-orm";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Server-authoritative auto clock-out execution.
 *
 * Called by:
 *   - GET /api/cron/max-shift-cleanup (12h orphan safety net)
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
