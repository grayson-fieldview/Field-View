import { db } from "../db";
import { timeEntries, type TimeEntry } from "@shared/schema";
import { eq } from "drizzle-orm";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  opts: { timeEntryId: string; userId: string },
  exec: DbOrTx = db,
): Promise<TimeEntry | undefined> {
  const now = new Date();
  const [updated] = await exec
    .update(timeEntries)
    .set({
      clockOut: now,
      editedAt: now,
      editedByUserId: opts.userId,
      updatedAt: now,
    })
    .where(eq(timeEntries.id, opts.timeEntryId))
    .returning();
  return updated;
}
