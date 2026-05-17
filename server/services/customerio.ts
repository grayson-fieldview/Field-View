// Customer.io lifecycle/marketing event integration.
//
// Architecture (locked at audit time):
//   • Server-side only — no JS snippet on frontend.
//   • Track API only (identify + events). App API client stub kept for future
//     phases but unused in Phase 1.
//   • Singleton TrackClient — initialized once at module load.
//   • Fire-and-forget pattern. Callers do
//       trackEvent(userId, CIO_EVENTS.X).catch(err => log(err))
//     and never await. Customer.io being slow or down NEVER blocks a
//     user-facing response.
//   • Missing env vars (dev / staging without CIO config) → no-op mode.
//     Warns once at first call, then every public function returns
//     immediately without throwing.
//
// Phase 1 events wired: signed_up, email_verified, project_created,
//   photo_uploaded, checklist_created, checklist_completed, report_created,
//   report_shared, task_created, task_completed, teammate_invited.
// Phase 2+ events declared in CIO_EVENTS but not yet fired anywhere:
//   subscription_started/canceled/lapsed/reactivated, trial_ending_soon,
//   account_deleted, auto_clock_in_triggered.

import { TrackClient, RegionUS, RegionEU } from "customerio-node";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { users, accounts } from "@shared/models/auth";
import { computeMrrCents } from "../lib/billing";

const SITE_ID = process.env.CUSTOMERIO_SITE_ID;
const TRACK_KEY = process.env.CUSTOMERIO_TRACK_API_KEY;
const REGION = (process.env.CUSTOMERIO_REGION || "us").toLowerCase();

let cio: TrackClient | null = null;
if (SITE_ID && TRACK_KEY) {
  cio = new TrackClient(SITE_ID, TRACK_KEY, {
    region: REGION === "eu" ? RegionEU : RegionUS,
  });
  console.log(`[customerio] initialized (region=${REGION})`);
}

let noopWarned = false;
function noopWarnOnce() {
  if (!noopWarned) {
    noopWarned = true;
    console.warn(
      "[customerio] CUSTOMERIO_SITE_ID / CUSTOMERIO_TRACK_API_KEY not set — running in no-op mode. All identify/track calls will be skipped.",
    );
  }
}

// Type-safe event registry. Add new event names here only — every public
// trackEvent caller is typed against CioEventName so typos become compile
// errors.
export const CIO_EVENTS = {
  // Lifecycle
  SIGNED_UP: "signed_up",
  EMAIL_VERIFIED: "email_verified",
  SUBSCRIPTION_STARTED: "subscription_started",
  SUBSCRIPTION_CANCELED: "subscription_canceled",
  SUBSCRIPTION_LAPSED: "subscription_lapsed",
  SUBSCRIPTION_REACTIVATED: "subscription_reactivated",
  TRIAL_ENDING_SOON: "trial_ending_soon",
  ACCOUNT_DELETED: "account_deleted",
  // Activation
  PROJECT_CREATED: "project_created",
  PHOTO_UPLOADED: "photo_uploaded",
  CHECKLIST_CREATED: "checklist_created",
  CHECKLIST_COMPLETED: "checklist_completed",
  REPORT_CREATED: "report_created",
  REPORT_SHARED: "report_shared",
  TASK_CREATED: "task_created",
  TASK_COMPLETED: "task_completed",
  TEAMMATE_INVITED: "teammate_invited",
  AUTO_CLOCK_IN_TRIGGERED: "auto_clock_in_triggered",
} as const;
export type CioEventName = typeof CIO_EVENTS[keyof typeof CIO_EVENTS];

export type CioAttrs = Record<string, unknown>;

// Internal — build the canonical attribute payload for a user from the
// joined users+accounts row. Returns null if the user was not found
// (caller should silently skip in that case).
//
// Date fields are emitted as unix-seconds, which is the Customer.io
// convention and lets you use date-based campaign filters.
async function buildAttrs(userId: string): Promise<CioAttrs | null> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      role: users.role,
      createdAt: users.createdAt,
      lastActiveAt: users.lastActiveAt,
      signupReferrer: users.signupReferrer,
      signupUtmSource: users.signupUtmSource,
      signupUtmMedium: users.signupUtmMedium,
      signupUtmCampaign: users.signupUtmCampaign,
      accountId: users.accountId,
      accountName: accounts.name,
      subscriptionStatus: accounts.subscriptionStatus,
      trialEndsAt: accounts.trialEndsAt,
      seatCount: accounts.seatCount,
      billingCycle: accounts.billingCycle,
      industry: accounts.industry,
      companySize: accounts.companySize,
    })
    .from(users)
    .leftJoin(accounts, eq(users.accountId, accounts.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;

  const mrrCents = computeMrrCents(row.seatCount ?? null, row.billingCycle ?? null);

  // "plan" is a CIO segmentation convenience — derived from billingCycle so
  // campaigns can filter "monthly customers" vs "annual customers" without
  // teaching the marketer about subscription_status nuance.
  const plan =
    row.billingCycle === "annual"
      ? "annual"
      : row.billingCycle === "monthly"
        ? "monthly"
        : null;

  return {
    email: row.email ?? undefined,
    first_name: row.firstName ?? undefined,
    last_name: row.lastName ?? undefined,
    role: row.role ?? undefined,
    account_id: row.accountId ?? undefined,
    account_name: row.accountName ?? undefined,
    plan,
    billing_cycle: row.billingCycle ?? null,
    subscription_status: row.subscriptionStatus ?? null,
    trial_ends_at: toUnixSeconds(row.trialEndsAt),
    seat_count: row.seatCount ?? null,
    mrr: mrrCents != null ? mrrCents / 100 : null,
    industry: row.industry ?? null,
    company_size: row.companySize ?? null,
    signup_referrer: row.signupReferrer ?? null,
    signup_utm_source: row.signupUtmSource ?? null,
    signup_utm_medium: row.signupUtmMedium ?? null,
    signup_utm_campaign: row.signupUtmCampaign ?? null,
    created_at: toUnixSeconds(row.createdAt),
    last_active_at: toUnixSeconds(row.lastActiveAt),
  };
}

function toUnixSeconds(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// Identify a user with Customer.io. If `attrs` is omitted, the canonical
// payload is rebuilt from the DB. Use the omitted form after a multi-field
// change when you don't already have the post-change row in hand.
export async function identifyUser(userId: string, attrs?: CioAttrs): Promise<void> {
  if (!cio) return noopWarnOnce();
  try {
    const payload = attrs ?? (await buildAttrs(userId));
    if (!payload) {
      console.warn("[customerio] identify SKIPPED — buildAttrs returned null", { userId });
      return;
    }
    // TEMP DEBUG (S45 prod incident) — REMOVE after attrs-payload bug is fixed.
    console.log("[customerio] sending attrs:", { userId, payload: JSON.stringify(payload) });
    await cio.identify(userId, payload);
    console.log("[customerio] identify resolved", { userId });
  } catch (err) {
    console.error("[customerio] identify failed:", { userId, err });
  }
}

// Fire a tracked event for `userId`. Optional `data` is the event payload
// (kept flat for CIO trigger-condition simplicity).
export async function trackEvent(
  userId: string,
  name: CioEventName,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!cio) return noopWarnOnce();
  try {
    await cio.track(userId, { name, data });
  } catch (err) {
    console.error("[customerio] track failed:", { userId, name, err });
  }
}

// Re-identify a user with fresh attrs pulled from the DB. Convenience
// wrapper used by callers that just persisted a multi-field change
// (e.g. onboarding wizard) and want CIO to see the latest snapshot.
export async function syncAttributes(userId: string): Promise<void> {
  return identifyUser(userId);
}
