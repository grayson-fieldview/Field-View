// Stripe env vars expected by the app (Session 3, trial-flow rework):
//
//   Server-side (process.env, used by this file + checkout/webhook code):
//     • STRIPE_PRICE_MONTHLY              — main monthly plan price ID
//     • STRIPE_PRICE_ANNUAL               — main annual plan price ID
//     • STRIPE_PRICE_SEAT_ADDON_MONTHLY   — additional-seat add-on, monthly billing
//     • STRIPE_PRICE_SEAT_ADDON_ANNUAL    — additional-seat add-on, annual billing
//
//   Frontend (import.meta.env, baked into the Vite bundle at build time):
//     • VITE_STRIPE_PRICE_MONTHLY         — used by the trial banner Add Card
//                                           CTA in client/src/App.tsx; will be
//                                           removed in Session 3 Commit B when
//                                           the CTA routes to /subscribe instead
//
// All five must be set in Vercel for production. The two SEAT_ADDON vars
// fall back to legacy product-name string-match (with a warn log) if both
// are unset, so the app degrades gracefully but mis-counts custom plans.
import { db } from "../db";
import { accounts } from "@shared/models/auth";
import { eq } from "drizzle-orm";

export type BillingState = {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  subscriptionLapsedAt: Date | null;
  source: "user" | "account";
};

export type AccessLevel = "full" | "read_only" | "locked";

export function computeAccessLevel(
  status: string | null,
  lapsedAt: Date | null,
  trialEndsAt: Date | null = null,
): AccessLevel {
  if (status === "active") return "full";
  // Session 2 of trial-flow rework: 'trialing' (and the legacy 'trial')
  // now honour trialEndsAt. Future deadline → full access. Expired →
  // read_only (NOT locked) so the user keeps a recovery path: they can
  // browse their data and click "Add Card" from the banner. Behavior
  // change for legacy 'trial' status: previously expired-trial was
  // 'locked'; now it is 'read_only' (intentional, recovery-friendly).
  if (status === "trialing" || status === "trial") {
    if (trialEndsAt && new Date(trialEndsAt) > new Date()) return "full";
    return "read_only";
  }
  if (status === "past_due") {
    if (lapsedAt == null) return "read_only";
    const ageMs = Date.now() - new Date(lapsedAt).getTime();
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    return ageMs > fourteenDaysMs ? "locked" : "read_only";
  }
  return "locked";
}

export function isAccountBillingEnabled(): boolean {
  const v = process.env.ACCOUNT_BILLING_ENABLED;
  return v === "true" || v === "1";
}

function fromUser(user: any): BillingState {
  return {
    stripeCustomerId: user?.stripeCustomerId ?? null,
    stripeSubscriptionId: user?.stripeSubscriptionId ?? null,
    subscriptionStatus: user?.subscriptionStatus ?? null,
    trialEndsAt: user?.trialEndsAt ?? null,
    subscriptionLapsedAt: null,
    source: "user",
  };
}

export async function getAccountBilling(req: any): Promise<BillingState> {
  const user = req?.user;

  if (!isAccountBillingEnabled()) {
    return fromUser(user);
  }

  const accountId: string | undefined | null = user?.accountId;
  if (!accountId) {
    return {
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscriptionStatus: null,
      trialEndsAt: null,
      subscriptionLapsedAt: null,
      source: "user",
    };
  }

  const [row] = await db
    .select({
      stripeCustomerId: accounts.stripeCustomerId,
      stripeSubscriptionId: accounts.stripeSubscriptionId,
      subscriptionStatus: accounts.subscriptionStatus,
      trialEndsAt: accounts.trialEndsAt,
      subscriptionLapsedAt: accounts.subscriptionLapsedAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!row || row.subscriptionStatus == null) {
    console.warn(
      "[billing-fallback]",
      JSON.stringify({
        userId: user?.id,
        accountId,
        reason: "account_missing_or_unbackfilled",
      })
    );
    return fromUser(user);
  }

  return {
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    subscriptionStatus: row.subscriptionStatus,
    trialEndsAt: row.trialEndsAt,
    subscriptionLapsedAt: row.subscriptionLapsedAt,
    source: "account",
  };
}

// Session 3 of trial-flow rework: prefer exact priceId compare against the
// two STRIPE_PRICE_SEAT_ADDON_{MONTHLY,ANNUAL} env vars (resolves the
// pre-existing TECH_DEBT item about string-matching product names). Stripe
// has TWO seat-addon prices — one billed monthly, one billed annually — so
// we accept either. Fall back to the legacy product-name string-match when
// BOTH env vars are unset so the app degrades gracefully rather than
// mis-counting seats — but warn loudly so the missing config gets noticed.
// Setting just one of the two also works (e.g. monthly-only customers).
let seatAddonFallbackWarned = false;
export function isSeatAddonItem(item: any): boolean {
  const monthlyId = process.env.STRIPE_PRICE_SEAT_ADDON_MONTHLY;
  const annualId = process.env.STRIPE_PRICE_SEAT_ADDON_ANNUAL;
  const itemPriceId = item?.price?.id;
  if (monthlyId || annualId) {
    return (
      (!!monthlyId && itemPriceId === monthlyId) ||
      (!!annualId && itemPriceId === annualId)
    );
  }
  if (!seatAddonFallbackWarned) {
    seatAddonFallbackWarned = true;
    console.warn(
      "[billing] Neither STRIPE_PRICE_SEAT_ADDON_MONTHLY nor STRIPE_PRICE_SEAT_ADDON_ANNUAL is set — falling back to product-name string-match for seat-addon detection. Set at least one of the env vars to remove this fallback."
    );
  }
  const product = item?.price?.product;
  const productName = typeof product === "string" ? "" : (product?.name || "");
  const lower = productName.toLowerCase();
  return lower.includes("additional") || lower.includes("seat");
}

export function computeSeatCountFromSub(sub: any): number {
  let extra = 0;
  for (const item of sub?.items?.data ?? []) {
    if (isSeatAddonItem(item)) {
      extra += item.quantity || 0;
    }
  }
  return 3 + extra;
}

export async function overlayAccountBillingOnUser<T extends Record<string, any>>(
  user: T,
  req: any,
): Promise<T & { accessLevel: AccessLevel }> {
  const billing = await getAccountBilling(req);
  const accessLevel = computeAccessLevel(
    billing.subscriptionStatus,
    billing.subscriptionLapsedAt,
    billing.trialEndsAt,
  );
  if (billing.source === "user") {
    return { ...user, accessLevel };
  }
  return {
    ...user,
    subscriptionStatus: billing.subscriptionStatus,
    trialEndsAt: billing.trialEndsAt,
    stripeCustomerId: billing.stripeCustomerId,
    stripeSubscriptionId: billing.stripeSubscriptionId,
    accessLevel,
  };
}
