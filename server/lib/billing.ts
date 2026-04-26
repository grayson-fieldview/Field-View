import { db } from "../db";
import { accounts } from "@shared/models/auth";
import { eq } from "drizzle-orm";

export type BillingState = {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  trialEndsAt: Date | null;
  source: "user" | "account";
};

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
      source: "user",
    };
  }

  const [row] = await db
    .select({
      stripeCustomerId: accounts.stripeCustomerId,
      stripeSubscriptionId: accounts.stripeSubscriptionId,
      subscriptionStatus: accounts.subscriptionStatus,
      trialEndsAt: accounts.trialEndsAt,
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
    source: "account",
  };
}
