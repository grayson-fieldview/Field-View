import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { invitations, users } from "@shared/models/auth";
import { db } from "../db";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SeatUsage {
  activeUsers: number;
  pendingInvites: number;
  used: number;
}

/**
 * Computes seat usage for an account: active users + non-expired pending invites.
 * Pending invites reserve a seat from the moment they are sent until they are
 * accepted (transitioning to an active user in the same slot), declined, expired,
 * or cancelled. Soft-deleted users are excluded from the active count. Expired
 * pending invites are excluded via lazy `expiresAt > now()` filter — no cron.
 */
export async function computeSeatUsage(
  dbOrTx: DbOrTx,
  accountId: string,
): Promise<SeatUsage> {
  const [activeRow] = await dbOrTx
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.accountId, accountId), isNull(users.deletedAt)));
  const [pendingRow] = await dbOrTx
    .select({ value: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.accountId, accountId),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, sql`now()`),
      ),
    );
  const activeUsers = Number(activeRow?.value ?? 0);
  const pendingInvites = Number(pendingRow?.value ?? 0);
  return { activeUsers, pendingInvites, used: activeUsers + pendingInvites };
}
