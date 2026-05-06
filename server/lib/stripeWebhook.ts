import { db } from "../db";
import { users, accounts } from "@shared/models/auth";
import { eq } from "drizzle-orm";
import { authStorage } from "../replit_integrations/auth/storage";
import { isAccountBillingEnabled, computeSeatCountFromSub } from "./billing";
import { getUncachableStripeClient } from "../stripeClient";
import { Sentry } from "./sentry";
import { sendSlackNotification, isCompAccount } from "./slack";

export async function writeAccountBilling(
  event: string,
  stripeCustomerId: string,
  fields: {
    subscriptionStatus?: string;
    stripeSubscriptionId?: string;
    trialEndsAt?: Date | null;
    seatCount?: number;
    subscriptionLapsedAt?: Date | null;
  },
) {
  if (!isAccountBillingEnabled()) return;
  if (!stripeCustomerId) return;

  const matches = await db
    .select({ id: users.id, accountId: users.accountId })
    .from(users)
    .where(eq(users.stripeCustomerId, stripeCustomerId));

  if (matches.length === 0) return;

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
    return;
  }

  const cleanFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) cleanFields[k] = v;
  }
  if (Object.keys(cleanFields).length === 0) return;

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
          } catch (e) {}
          await authStorage.updateUser(user.id, {
            stripeSubscriptionId: subscriptionId as string,
            subscriptionStatus: appStatus,
          });
          console.log(
            `User ${user.id} subscription updated to ${appStatus} via checkout`,
          );
          await writeAccountBilling(type, customerId as string, {
            stripeSubscriptionId: subscriptionId as string,
            subscriptionStatus: appStatus,
            seatCount: seatCountFromSub,
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

        let seatCountFromSub: number | undefined;
        try {
          const stripe = await getUncachableStripeClient();
          const fullSub = await stripe.subscriptions.retrieve(data.id, {
            expand: ["items.data.price.product"],
          });
          seatCountFromSub = computeSeatCountFromSub(fullSub);
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
        await writeAccountBilling(type, customerId as string, {
          subscriptionStatus: appStatus,
          stripeSubscriptionId: data.id,
          seatCount: seatCountFromSub,
          subscriptionLapsedAt: lapsedAtUpdate,
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
        await authStorage.updateUser(user.id, {
          subscriptionStatus: "canceled",
        });
        console.log(`User ${user.id} subscription canceled`);
        await writeAccountBilling(type, customerId as string, {
          subscriptionStatus: "canceled",
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
