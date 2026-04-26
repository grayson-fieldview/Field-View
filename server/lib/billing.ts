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
  if (status === "active" || status === "trialing") return "full";
  if (status === "trial") {
    if (trialEndsAt && new Date(trialEndsAt) > new Date()) return "full";
    return "locked";
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

export function isSeatAddonItem(item: any): boolean {
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
): Promise<T> {
  const billing = await getAccountBilling(req);
  if (billing.source === "user") return user;
  return {
    ...user,
    subscriptionStatus: billing.subscriptionStatus,
    trialEndsAt: billing.trialEndsAt,
    stripeCustomerId: billing.stripeCustomerId,
    stripeSubscriptionId: billing.stripeSubscriptionId,
  };
}
