// last_active_at touch middleware.
//
// Mounted after passport.session() in setupAuth(). For every authenticated
// request (req.user present), updates users.last_active_at to now() at
// most once per user per TOUCH_THROTTLE_MS via an in-memory Map.
//
// Writes are fire-and-forget — never awaited, never block the response.
// Errors are logged but never bubbled.
//
// Serverless caveat: on Vercel the in-memory Map is per-instance, so a
// user hitting two warm instances within the throttle window may get
// touched twice. That's fine — accuracy is within ~1 minute, and one
// extra UPDATE per cold instance is negligible vs. one-per-request.
//
// Customer.io is NOT synced here. last_active_at goes to CIO via the
// next identify() call (e.g. on the user's next signup-adjacent event,
// or via the periodic re-identify cron in a later phase). Syncing on
// every touch would explode our CIO API budget.

import type { RequestHandler } from "express";
import { db } from "../db";
import { sql } from "drizzle-orm";

const TOUCH_THROTTLE_MS = 60 * 1000;
const lastTouched = new Map<string, number>();

export const touchLastActive: RequestHandler = (req, res, next) => {
  const userId: string | undefined = (req as any)?.user?.id;
  if (!userId) return next();

  const now = Date.now();
  const prev = lastTouched.get(userId) ?? 0;
  if (now - prev < TOUCH_THROTTLE_MS) return next();

  lastTouched.set(userId, now);
  // Fire-and-forget. Errors are logged at warn (not error) because this is
  // metadata; failure does not affect the user request.
  db.execute(sql`UPDATE users SET last_active_at = NOW() WHERE id = ${userId}`).catch(
    (err: unknown) => {
      console.warn("[touch-last-active] update failed:", { userId, err });
      // On failure, drop the throttle entry so the next request retries.
      lastTouched.delete(userId);
    },
  );

  return next();
};
