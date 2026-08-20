import { db } from "../db";
import { users, accounts } from "@shared/models/auth";
import { processedStripeEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { authStorage } from "../replit_integrations/auth/storage";
import { isAccountBillingEnabled, computeSeatCountFromSub } from "./billing";
import { getUncachableStripeClient } from "../stripeClient";
import { Sentry } from "./sentry";
import { sendSlackNotification, isCompAccount } from "./slack";
import { sendGhlEvent, actualMrrFromSeats } from "./ghl";
import { sendMetaCapiEvent } from "./metaCapi";
import { capturePostHogEvent } from "./posthog";
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
  stripeEventId?: string; // Stripe event.id — deterministic Meta CAPI dedup key
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
      // eventId derived from the Stripe event id: the same Stripe event
      // (including webhook redeliveries) always produces the same Meta
      // event_id, so Meta dedupes retries instead of double-counting a paid
      // conversion. Falls back to a UUID only if the event id is missing
      // (malformed replay). Note: no browser pixel Subscribe exists today,
      // so there is no client ID to pair with — this is redelivery dedup.
      sendMetaCapiEvent({
        eventName: "Subscribe",
        eventId: opts.stripeEventId || crypto.randomUUID(),
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

// ---------------------------------------------------------------------------
// PostHog billing event helpers — non-fatal, after writes.
// ---------------------------------------------------------------------------

/**
 * Capture a PostHog billing event after a successful billing write. Called
 * synchronously (no void) so the SDK's waitUntil-backed flush registers before
 * the serverless handler returns. All errors are swallowed — never affects
 * webhook processing or response.
 *
 * @param event  "trial_ended" | "subscribed"
 * @param userId  the verified user identity for this capture
 * @param accountId  account that was written
 * @param dedupeKey  deterministic key — prevents double-capture across
 *   overlapping webhook deliveries / purchase paths for the same subscription
 * @param properties  additional event properties (provider, subscription id, etc.)
 */
function captureStripeBillingPostHogEvent(opts: {
  event: "trial_ended" | "subscribed";
  userId: string;
  accountId: string;
  dedupeKey: string;
  properties?: Record<string, unknown>;
}): void {
  try {
    capturePostHogEvent({
      event: opts.event,
      userId: opts.userId,
      accountId: opts.accountId,
      properties: opts.properties,
      dedupeKey: opts.dedupeKey,
    });
  } catch (err: any) {
    console.error(`[posthog] ${opts.event} capture failed (non-fatal):`, err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Billing-provider gate (Apple IAP prep). Stripe webhook handlers must never
// write billing state (subscriptionStatus, stripeSubscriptionId,
// stripeCustomerId, seatCount, subscriptionLapsedAt) for an account whose
// accounts.billing_provider is not 'stripe' — a stale Stripe event must not
// overwrite/lock out an account paying through another provider.
// Returns the non-stripe provider name when writes must be skipped, or null
// when writing is allowed (provider is 'stripe', the column default, or the
// user has no account row — the legacy user-only path, which is Stripe by
// definition). Nothing writes billing_provider='apple' yet; this is the
// enforcement side only.
async function resolveNonStripeProvider(
  accountId: string | null | undefined,
): Promise<string | null> {
  if (!accountId) return null;
  const [acct] = await db
    .select({ billingProvider: accounts.billingProvider })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const provider = acct?.billingProvider ?? "stripe";
  return provider === "stripe" ? null : provider;
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

  return writeAccountBillingById(event, chosen.accountId, "stripe", fields, {
    userId: chosen.id,
  });
}

/**
 * Provider-parameterized write half — the ONLY place the accounts-table
 * billing write happens (non-bypassable gate). A second billing provider
 * (e.g. Apple IAP) resolves its own accountId and calls this with its
 * provider name; nothing passes anything but 'stripe' yet.
 *
 * Returns the accountId written, or null when the write was skipped because
 * the account's billing_provider does not match expectedProvider.
 */
export async function writeAccountBillingById(
  event: string,
  accountId: string,
  expectedProvider: string,
  fields: {
    stripeCustomerId?: string;
    subscriptionStatus?: string;
    stripeSubscriptionId?: string;
    trialEndsAt?: Date | null;
    seatCount?: number;
    subscriptionLapsedAt?: Date | null;
  },
  // Optional extra keys merged into the success log (e.g. the Stripe path's
  // resolved userId) so the existing [webhook-dual-write] log shape is
  // preserved byte-for-byte for current callers.
  logContext?: Record<string, unknown>,
): Promise<string | null> {
  // Provider gate — AFTER the caller's account resolution, BEFORE the write.
  // Missing account row defaults to 'stripe' (the column default), matching
  // the previous resolveNonStripeProvider behavior.
  const [acct] = await db
    .select({ billingProvider: accounts.billingProvider })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const provider = acct?.billingProvider ?? "stripe";
  if (provider !== expectedProvider) {
    console.log(
      "[stripeWebhook] write skipped — non-stripe billing provider",
      JSON.stringify({ event, accountId, provider, expectedProvider }),
    );
    return null;
  }

  const cleanFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) cleanFields[k] = v;
  }
  if (Object.keys(cleanFields).length === 0) return accountId;

  await db.update(accounts).set(cleanFields).where(eq(accounts.id, accountId));

  console.log(
    "[webhook-dual-write]",
    JSON.stringify({
      event,
      accountId,
      ...(logContext ?? {}),
      flagEnabled: isAccountBillingEnabled(),
      fieldsWritten: Object.keys(cleanFields),
    }),
  );
  return accountId;
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
          // Provider gate — after account resolution (user.accountId), before
          // ANY write (users-table updateUser below has no other guard).
          const nonStripe = await resolveNonStripeProvider(user.accountId);
          if (nonStripe) {
            console.log(
              `[stripeWebhook] ${type} skipped — account ${user.accountId} billing_provider=${nonStripe} (non-stripe)`,
            );
            return;
          }
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
          // Read prior account subscriptionStatus BEFORE the write so PostHog
          // can detect a genuine inactive → active transition.
          let priorAccountStatus: string | null = null;
          if (user.accountId) {
            try {
              const [priorAcct] = await db
                .select({ subscriptionStatus: accounts.subscriptionStatus })
                .from(accounts)
                .where(eq(accounts.id, user.accountId))
                .limit(1);
              priorAccountStatus = priorAcct?.subscriptionStatus ?? null;
            } catch {}
          }

          const writtenAccountId = await writeAccountBilling(type, customerId as string, {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId as string,
            subscriptionStatus: appStatus,
            seatCount: seatCountFromSub,
          });

          // PostHog: subscribed — only when status transitions to active and
          // the prior status was NOT active (i.e. a genuinely new subscription,
          // not a renewal). Dedupe key on Stripe subscription id so overlapping
          // webhook paths never double-capture.
          if (writtenAccountId && appStatus === "active" && priorAccountStatus !== "active") {
            captureStripeBillingPostHogEvent({
              event: "subscribed",
              userId: user.id,
              accountId: writtenAccountId,
              dedupeKey: `subscribed:stripe:${subscriptionId}`,
              properties: {
                provider: "stripe",
                stripe_subscription_id: subscriptionId,
                stripe_event_id: event.id,
              },
            });
          }

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
            stripeEventId: event.id,
          });

          // Slack notification: any subscription checkout (trial OR paid).
          // No payment_status gate — Stripe trial sessions complete with payment_status='no_payment_required'.
          if (data.mode === "subscription") {
            const email = data.customer_email
              || data.customer_details?.email
              || user.email
              || "(unknown)";
            if (!isCompAccount(email)) {
              const amount = ((data.amount_total ?? 0) / 100).toFixed(2);
              const currency = (data.currency ?? "usd").toUpperCase();
              // 100%-off promo (e.g. BETA100): amount_total is 0 but there is
              // no future charge to imply. Coupon can live on sub.discount
              // (classic) or sub.discounts[0] (newer API versions) — check both.
              const discounts = [
                subForGhl?.discount,
                ...(Array.isArray(subForGhl?.discounts) ? subForGhl.discounts : []),
              ].filter((d: any) => d && typeof d === "object");
              const fullOffCoupon = discounts
                .map((d: any) => d.coupon)
                .find((c: any) => c?.percent_off === 100);
              let message: string;
              if ((data.amount_total ?? 0) === 0 && fullOffCoupon) {
                const code = fullOffCoupon.name || fullOffCoupon.id || "promo";
                message = `🎟️ Subscribed (100% off — ${code}): ${email}`;
              } else if ((data.amount_total ?? 0) === 0) {
                // In-trial checkout: card on file, auto-converts at trial_end.
                const convertsOn = subForGhl?.trial_end
                  ? new Date(subForGhl.trial_end * 1000).toISOString().slice(0, 10)
                  : "(unknown date)";
                message = `💳 Subscribed (in trial, converts ${convertsOn}): ${email}`;
              } else {
                message = `💰 New subscription (charged): ${email} — $${amount} ${currency}`;
              }
              sendSlackNotification(message).catch(() => {});
            }
          }
        }
      }
    } else if (type === "customer.subscription.updated") {
      const customerId = data.customer;
      const status = data.status;
      const user = await authStorage.getUserByStripeCustomerId(customerId);
      if (user) {
        // Provider gate — after account resolution, before any write. Sits
        // ALONGSIDE (not instead of) the stripeSubscriptionId mismatch guard
        // below, which stays for Stripe-vs-Stripe staleness.
        const nonStripe = await resolveNonStripeProvider(user.accountId);
        if (nonStripe) {
          console.log(
            `[stripeWebhook] ${type} skipped — account ${user.accountId} billing_provider=${nonStripe} (non-stripe)`,
          );
          return;
        }
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
        // Also capture prior subscriptionStatus for PostHog transition detection.
        let priorAccountStatus: string | null = null;
        if (user.accountId) {
          lapseAccountId = user.accountId;
          try {
            const [acctRow] = await db
              .select({
                subscriptionLapsedAt: accounts.subscriptionLapsedAt,
                subscriptionStatus: accounts.subscriptionStatus,
              })
              .from(accounts)
              .where(eq(accounts.id, user.accountId))
              .limit(1);
            const existingLapsedAt = acctRow?.subscriptionLapsedAt ?? null;
            priorAccountStatus = acctRow?.subscriptionStatus ?? null;
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

        // PostHog billing events — fire-and-forget, after the billing write.
        // trial_ended: prior status was trialing, new status is not trialing.
        // subscribed: prior status was not active, new status is active —
        //   dedupe on Stripe subscription id so renewals never re-fire.
        if (writtenAccountId) {
          const effectiveAccountId = writtenAccountId;
          if (priorAccountStatus === "trialing" && appStatus !== "trialing") {
            captureStripeBillingPostHogEvent({
              event: "trial_ended",
              userId: user.id,
              accountId: effectiveAccountId,
              // Stable per-subscription dedupe (no event.id) so concurrent /
              // out-of-order duplicate transition observations collapse.
              dedupeKey: `trial_ended:stripe:${data.id}`,
              properties: {
                provider: "stripe",
                stripe_subscription_id: data.id,
                stripe_event_id: event.id,
                new_status: appStatus,
              },
            });
          }
          if (priorAccountStatus !== "active" && appStatus === "active") {
            captureStripeBillingPostHogEvent({
              event: "subscribed",
              userId: user.id,
              accountId: effectiveAccountId,
              dedupeKey: `subscribed:stripe:${data.id}`,
              properties: {
                provider: "stripe",
                stripe_subscription_id: data.id,
                stripe_event_id: event.id,
                prior_status: priorAccountStatus,
              },
            });
          }
        }

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
    } else if (type === "customer.subscription.trial_will_end") {
      // Fires ~3 days before trial_end. With auto-conversion live (checkout
      // creates a real subscription that charges when trial_end passes),
      // this is the ONLY pre-charge warning hook. Notification-only: no
      // status writes — subscription.updated owns the dual-write.
      //
      // Idempotency: UNLIKE the other handlers (whose DB writes are
      // naturally idempotent and whose Slack messages are ops-only), this
      // one triggers a customer-facing "your card will be charged" email
      // via GHL — a Stripe redelivery must not send it twice. Dedupe via
      // INSERT ... ON CONFLICT DO NOTHING on processed_stripe_events
      // (event-id PK): first delivery wins, replays skip the whole branch.
      // A missing event id (malformed replay) proceeds rather than
      // silently dropping a real warning.
      if (event.id) {
        const inserted = await db
          .insert(processedStripeEvents)
          .values({ eventId: event.id, eventType: type })
          .onConflictDoNothing()
          .returning({ eventId: processedStripeEvents.eventId });
        if (inserted.length === 0) {
          console.log(
            `[stripeWebhook] trial_will_end ${event.id} already processed — skipping redelivery`,
          );
          return;
        }
      }
      const customerId = data.customer;
      const user = await authStorage.getUserByStripeCustomerId(customerId);
      if (user) {
        // Amount: sum of the subscription's own line items (unit_amount ×
        // quantity) — the real upcoming charge, not the MRR estimate.
        let sub: any = data; // event payload IS the subscription object
        try {
          const stripe = await getUncachableStripeClient();
          sub = await stripe.subscriptions.retrieve(data.id, {
            expand: ["items.data.price.product"],
          });
        } catch (e) {}
        const amountCents = (sub?.items?.data ?? []).reduce(
          (acc: number, item: any) =>
            acc + (item?.price?.unit_amount ?? 0) * (item?.quantity ?? 1),
          0,
        );
        const amount = (amountCents / 100).toFixed(2);
        const convertsOn = data.trial_end
          ? new Date(data.trial_end * 1000).toISOString().slice(0, 10)
          : "(unknown date)";
        const email = user.email || "(unknown)";
        if (!isCompAccount(email)) {
          sendSlackNotification(
            `⏰ Trial converting in 3 days: ${email} — $${amount} on ${convertsOn}`,
          ).catch(() => {});
        }

        // S46 GHL billing_event — same contract as every other billing
        // event: event_type carries the raw Stripe type so the GHL
        // workflow can branch on it and send the heads-up email.
        // payment_status maps trialing → "active" per GHL_PAYMENT_STATUS.
        void sendGhlBillingEvent({
          eventType: type,
          stripeStatus: sub?.status ?? data.status ?? "trialing",
          accountId: user.accountId,
          sub,
        });
      }
    } else if (type === "invoice.payment_failed") {
      // Notification-only. Deliberately NO app status writes here:
      // customer.subscription.updated owns the past_due dual-write and
      // lapsed_at transitions — Stripe flips the sub to past_due and that
      // event fires separately, so there is no conflict and no gap.
      const customerId = data.customer;
      const user = await authStorage.getUserByStripeCustomerId(customerId);
      if (user) {
        const email = data.customer_email || user.email || "(unknown)";
        const amount = ((data.amount_due ?? 0) / 100).toFixed(2);
        const currency = (data.currency ?? "usd").toUpperCase();
        const attempt = data.attempt_count ?? 1;
        // next_payment_attempt is unix seconds, or null when Stripe has
        // exhausted retries (final failure).
        const nextRetry = data.next_payment_attempt
          ? new Date(data.next_payment_attempt * 1000).toISOString().slice(0, 10)
          : null;
        const retrySuffix = nextRetry
          ? ` — next retry ${nextRetry}`
          : " — no further retries";
        if (!isCompAccount(email)) {
          sendSlackNotification(
            `⚠️ Payment failed: ${email} — $${amount} ${currency} (attempt ${attempt})${retrySuffix}`,
          ).catch(() => {});
        }

        // S46 GHL billing_event for future dunning automation. Plan
        // derivation needs the subscription's items; the invoice only
        // carries the sub id, so retrieve it (best-effort — a failed
        // retrieve degrades to plan:null, event still fires).
        let subForGhl: any;
        const subscriptionId =
          typeof data.subscription === "string"
            ? data.subscription
            : data.subscription?.id;
        if (subscriptionId) {
          try {
            const stripe = await getUncachableStripeClient();
            subForGhl = await stripe.subscriptions.retrieve(subscriptionId, {
              expand: ["items.data.price.product"],
            });
          } catch (e) {}
        }
        void sendGhlBillingEvent({
          eventType: type,
          stripeStatus: "past_due",
          accountId: user.accountId,
          sub: subForGhl,
        });
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
        // Provider gate — after account resolution and alongside the mismatch
        // guard above (which is null-safe only for Stripe-vs-Stripe cases);
        // before the users-table write below.
        const nonStripe = await resolveNonStripeProvider(user.accountId);
        if (nonStripe) {
          console.log(
            `[stripeWebhook] ${type} skipped — account ${user.accountId} billing_provider=${nonStripe} (non-stripe)`,
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
