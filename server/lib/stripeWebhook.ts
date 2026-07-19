import { db } from "../db";
import { users, accounts } from "@shared/models/auth";
import { eq } from "drizzle-orm";
import { authStorage } from "../replit_integrations/auth/storage";
import { isAccountBillingEnabled, computeSeatCountFromSub } from "./billing";
import { getUncachableStripeClient } from "../stripeClient";
import { Sentry } from "./sentry";
import { sendSlackNotification, isCompAccount } from "./slack";
import { sendGhlEvent, actualMrrFromSeats } from "./ghl";
import { sendMetaCapiEvent } from "./metaCapi";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// S46 GHL billing_event helpers.
// ---------------------------------------------------------------------------

// Stripe subscription status → GHL payment_status. GHL branches its workflow
// on this value; dedupe/noise-filtering is the workflow's job, not ours.
const GHL_PAYMENT_STATUS: Record<string, string> = {
  active: "active",
  trialing: "active",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "past_due",
};

// "monthly" | "annual" from the subscription's price IDs (matched against
// STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL), falling back to the base
// item's recurring interval when the env vars are unset or the IDs drifted.
function planFromSub(sub: any): { plan: "monthly" | "annual" | null; isAnnual: boolean } {
  const monthlyId = process.env.STRIPE_PRICE_MONTHLY;
  const annualId = process.env.STRIPE_PRICE_ANNUAL;
  for (const item of sub?.items?.data ?? []) {
    const priceId = item?.price?.id;
    if (annualId && priceId === annualId) return { plan: "annual", isAnnual: true };
    if (monthlyId && priceId === monthlyId) return { plan: "monthly", isAnnual: false };
  }
  const interval = sub?.items?.data?.[0]?.price?.recurring?.interval;
  if (interval === "year") return { plan: "annual", isAnnual: true };
  if (interval === "month") return { plan: "monthly", isAnnual: false };
  return { plan: null, isAnnual: false };
}

// Fire-and-forget billing_event. Identity = accounts.ownerId (the account's
// originating admin — same rule as every other GHL event), never whichever
// user row happens to carry the stripeCustomerId. Reads seat_count POST
// writeAccountBilling so the payload reflects the just-written state. All
// failures are swallowed after a console.error — webhook processing and
// response timing are never affected.
async function sendGhlBillingEvent(opts: {
  eventType: string; // raw Stripe event type
  stripeStatus: string; // raw Stripe subscription status
  accountId: string | null | undefined;
  sub: any; // subscription object with items (may be undefined on retrieve failure)
  paidConversion?: boolean; // checkout.session.completed only
  churn?: boolean; // customer.subscription.deleted only
}): Promise<void> {
  try {
    if (!opts.accountId) return;
    const [acct] = await db
      .select({ ownerId: accounts.ownerId, seatCount: accounts.seatCount })
      .from(accounts)
      .where(eq(accounts.id, opts.accountId))
      .limit(1);
    if (!acct?.ownerId) return;
    const [owner] = await db
      .select({
        id: users.id,
        email: users.email,
        signupFbp: users.signupFbp,
        signupFbc: users.signupFbc,
      })
      .from(users)
      .where(eq(users.id, acct.ownerId))
      .limit(1);
    if (!owner?.email || isCompAccount(owner.email)) return;

    const { plan, isAnnual } = planFromSub(opts.sub);
    const seatCount = acct.seatCount ?? 3;
    const now = new Date().toISOString();
    sendGhlEvent("billing_event", {
      email: owner.email,
      app_user_id: owner.id,
      event_type: opts.eventType,
      payment_status: GHL_PAYMENT_STATUS[opts.stripeStatus] ?? opts.stripeStatus,
      plan,
      seat_count: seatCount,
      mrr: actualMrrFromSeats(seatCount, isAnnual),
      paid_conversion_date: opts.paidConversion ? now : null,
      churn_date: opts.churn ? now : null,
    });

    // Meta CAPI Subscribe — ONLY on the paid-conversion path
    // (checkout.session.completed / new subscription), never on updates or
    // cancellations. No browser context (request comes from Stripe's
    // servers): fbp/fbc recovered from the owner row's signup attribution.
    if (opts.paidConversion) {
      sendMetaCapiEvent({
        eventName: "Subscribe",
        eventId: crypto.randomUUID(),
        email: owner.email,
        value: actualMrrFromSeats(seatCount, isAnnual),
        currency: "USD",
        fbp: owner.signupFbp,
        fbc: owner.signupFbc,
      });
    }
  } catch (err: any) {
    console.error("[ghl] billing_event failed (non-fatal):", err?.message || err);
  }
}

export async function writeAccountBilling(
  event: string,
  stripeCustomerId: string,
  fields: {
    stripeCustomerId?: string;
    subscriptionStatus?: string;
    stripeSubscriptionId?: string;
    trialEndsAt?: Date | null;
    seatCount?: number;
    subscriptionLapsedAt?: Date | null;
  },
): Promise<string | null> {
  // Returns the accountId it wrote to (null when nothing was written), so
  // callers (S46 GHL billing_event) target the exact same account.
  if (!isAccountBillingEnabled()) return null;
  if (!stripeCustomerId) return null;

  const matches = await db
    .select({ id: users.id, accountId: users.accountId })
    .from(users)
    .where(eq(users.stripeCustomerId, stripeCustomerId));

  if (matches.length === 0) return null;

  const chosen = matches[0];

  if (matches.length > 1) {
    console.warn(
      "[webhook-dual-write]",
      JSON.stringify({
        stripeCustomerId,
        matchCount: matches.length,
        chosenAccountId: chosen.accountId,
        reason: "multiple_users_share_stripe_customer",
      }),
    );
  }

  if (!chosen.accountId) {
    console.warn(
      "[webhook-dual-write]",
      JSON.stringify({
        event,
        stripeCustomerId,
        userId: chosen.id,
        reason: "user_has_no_account_id",
      }),
    );
    return null;
  }

  const cleanFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) cleanFields[k] = v;
  }
  if (Object.keys(cleanFields).length === 0) return chosen.accountId;

  await db.update(accounts).set(cleanFields).where(eq(accounts.id, chosen.accountId));

  console.log(
    "[webhook-dual-write]",
    JSON.stringify({
      event,
      accountId: chosen.accountId,
      userId: chosen.id,
      flagEnabled: isAccountBillingEnabled(),
      fieldsWritten: Object.keys(cleanFields),
    }),
  );
  return chosen.accountId;
}

export async function handleSubscriptionEvent(event: any) {
  try {
    const type = event.type;
    const data = event.data?.object;
    if (!data) return;

    if (type === "checkout.session.completed") {
      const customerId = data.customer;
      const subscriptionId = data.subscription;
      if (customerId && subscriptionId) {
        const user = await authStorage.getUserByStripeCustomerId(customerId);
        if (user) {
          let appStatus = "trialing";
          let seatCountFromSub: number | undefined;
          let subForGhl: any; // S46 GHL: keep the retrieved sub for plan derivation
          try {
            const stripe = await getUncachableStripeClient();
            const sub = await stripe.subscriptions.retrieve(
              subscriptionId as string,
              { expand: ["items.data.price.product"] },
            );
            if (sub.status === "active") appStatus = "active";
            else if (sub.status === "trialing") appStatus = "trialing";
            else if (sub.status === "past_due") appStatus = "past_due";
            seatCountFromSub = computeSeatCountFromSub(sub);
            subForGhl = sub;
          } catch (e) {}
          await authStorage.updateUser(user.id, {
            stripeSubscriptionId: subscriptionId as string,
            subscriptionStatus: appStatus,
          });
          console.log(
            `User ${user.id} subscription updated to ${appStatus} via checkout`,
          );
          const writtenAccountId = await writeAccountBilling(type, customerId as string, {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId as string,
            subscriptionStatus: appStatus,
            seatCount: seatCountFromSub,
          });

          // S46 GHL billing_event — paid conversion. Fire-and-forget, after
          // the dual-write so seat_count reflects the just-written state.
          // Uses the EXACT account the dual-write targeted (duplicate
          // stripeCustomerId rows can differ from user.accountId).
          void sendGhlBillingEvent({
            eventType: type,
            stripeStatus: subForGhl?.status ?? appStatus,
            accountId: writtenAccountId ?? user.accountId,
            sub: subForGhl,
            paidConversion: true,
          });

          // Slack notification: any subscription checkout (trial OR paid).
          // No payment_status gate — Stripe trial sessions complete with payment_status='no_payment_required'.
          if (data.mode === "subscription") {
            const email = data.customer_email
              || data.customer_details?.email
              || user.email
              || "(unknown)";
            if (!isCompAccount(email)) {
              const isTrial = (data.amount_total ?? 0) === 0;
              const emoji = isTrial ? "🆓" : "💰";
              const label = isTrial ? "Trial signup" : "New paid signup";
              const amount = ((data.amount_total ?? 0) / 100).toFixed(2);
              const currency = (data.currency ?? "usd").toUpperCase();
              const suffix = isTrial ? "" : ` — $${amount} ${currency}`;
              sendSlackNotification(`${emoji} ${label}: ${email}${suffix}`).catch(() => {});
            }
          }
        }
      }
    } else if (type === "customer.subscription.updated") {
      const customerId = data.customer;
      const status = data.status;
      const user = await authStorage.getUserByStripeCustomerId(customerId);
      if (user) {
        let appStatus = "none";
        if (status === "active") appStatus = "active";
        else if (status === "trialing") appStatus = "trialing";
        else if (status === "past_due") appStatus = "past_due";
        else if (status === "canceled" || status === "unpaid")
          appStatus = "canceled";

        // Multi-subscription guard: an update that would downgrade the
        // account (canceled/lapsed states) must come from the account's
        // active subscription — a stale duplicate sub must not overwrite
        // stripeSubscriptionId or downgrade the account. Upgrades/neutral
        // statuses and users with no stored sub keep current behavior.
        const isDowngrade = appStatus === "canceled" || appStatus === "past_due";
        if (
          isDowngrade &&
          user.stripeSubscriptionId &&
          data.id !== user.stripeSubscriptionId
        ) {
          console.log(
            `[stripeWebhook] subscription.updated (${status}) for ${data.id} ignored — account's active sub is ${user.stripeSubscriptionId}`,
          );
          return;
        }

        let seatCountFromSub: number | undefined;
        let subForGhl: any = data; // event payload already carries items; upgraded below
        try {
          const stripe = await getUncachableStripeClient();
          const fullSub = await stripe.subscriptions.retrieve(data.id, {
            expand: ["items.data.price.product"],
          });
          seatCountFromSub = computeSeatCountFromSub(fullSub);
          subForGhl = fullSub;
        } catch (e) {}

        let lapsedAtUpdate: Date | null | undefined = undefined;
        let lapsedAtChange: "set" | "clear" | null = null;
        let lapseAccountId: string | null = null;
        if (user.accountId) {
          lapseAccountId = user.accountId;
          try {
            const [acctRow] = await db
              .select({ subscriptionLapsedAt: accounts.subscriptionLapsedAt })
              .from(accounts)
              .where(eq(accounts.id, user.accountId))
              .limit(1);
            const existingLapsedAt = acctRow?.subscriptionLapsedAt ?? null;
            if (appStatus === "past_due" && existingLapsedAt == null) {
              lapsedAtUpdate = new Date();
              lapsedAtChange = "set";
            } else if (
              (appStatus === "active" || appStatus === "trialing") &&
              existingLapsedAt != null
            ) {
              lapsedAtUpdate = null;
              lapsedAtChange = "clear";
            }
          } catch (e) {
            console.error("Error reading existing lapsed_at:", (e as any)?.message);
          }
        }

        await authStorage.updateUser(user.id, {
          subscriptionStatus: appStatus,
          stripeSubscriptionId: data.id,
        });
        console.log(`User ${user.id} subscription updated to ${appStatus}`);
        const writtenAccountId = await writeAccountBilling(type, customerId as string, {
          stripeCustomerId: customerId,
          subscriptionStatus: appStatus,
          stripeSubscriptionId: data.id,
          seatCount: seatCountFromSub,
          subscriptionLapsedAt: lapsedAtUpdate,
        });

        // S46 GHL billing_event — sent for EVERY subscription.updated (seat
        // changes, renewals, status flips…). GHL branches on payment_status;
        // dedupe is the workflow's job. Fire-and-forget, after the dual-write,
        // targeting the exact account the dual-write wrote to.
        void sendGhlBillingEvent({
          eventType: type,
          stripeStatus: status,
          accountId: writtenAccountId ?? user.accountId,
          sub: subForGhl,
        });

        if (lapsedAtChange === "set") {
          console.log(
            "[lapse-transition]",
            JSON.stringify({
              accountId: lapseAccountId,
              customerId,
              status: appStatus,
              action: "lapse_started",
            }),
          );
        } else if (lapsedAtChange === "clear") {
          console.log(
            "[lapse-transition]",
            JSON.stringify({
              accountId: lapseAccountId,
              customerId,
              status: appStatus,
              action: "lapse_cleared",
            }),
          );
        }
      }
    } else if (type === "customer.subscription.deleted") {
      const customerId = data.customer;
      const user = await authStorage.getUserByStripeCustomerId(customerId);
      if (user) {
        // Multi-subscription guard: canceling a stale duplicate subscription
        // must not churn an account whose active subscription is different.
        // Null/empty stored sub keeps current behavior.
        if (user.stripeSubscriptionId && data.id !== user.stripeSubscriptionId) {
          console.log(
            `[stripeWebhook] subscription.deleted for ${data.id} ignored — account's active sub is ${user.stripeSubscriptionId}`,
          );
          return;
        }
        await authStorage.updateUser(user.id, {
          subscriptionStatus: "canceled",
        });
        console.log(`User ${user.id} subscription canceled`);
        const writtenAccountId = await writeAccountBilling(type, customerId as string, {
          stripeCustomerId: customerId,
          subscriptionStatus: "canceled",
        });

        // S46 GHL billing_event — churn. The deleted event's payload IS the
        // subscription object (items inline), so plan derivation works
        // without an extra Stripe API call. Fire-and-forget, targeting the
        // exact account the dual-write wrote to.
        void sendGhlBillingEvent({
          eventType: type,
          stripeStatus: "canceled",
          accountId: writtenAccountId ?? user.accountId,
          sub: data,
          churn: true,
        });
      }
    }
  } catch (err: any) {
    console.error("Error handling subscription event:", err.message);
    Sentry.captureException(err, {
      tags: {
        webhook_event_type: event?.type || "unknown",
      },
      extra: {
        eventId: event?.id,
        customerId: event?.data?.object?.customer,
      },
    });
  }
}
