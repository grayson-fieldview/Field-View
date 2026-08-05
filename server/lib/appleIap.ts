/**
 * Apple App Store Server Notifications V2 — notification handling logic.
 *
 * Verification is delegated entirely to server/lib/appleIapVerify.ts (pinned
 * Apple Root CA-G3 chain + ES256). This module owns: dedupe, account
 * resolution, notification-type mapping, and billing-state writes via
 * writeAccountBillingById(..., 'apple', ...) — the provider-gated single
 * write point shared with the Stripe path.
 *
 * ACCOUNT RESOLUTION (order matters — see inline comments):
 *   1. PRIMARY: accounts.apple_original_transaction_id ==
 *      transactionInfo.originalTransactionId. appAccountToken is NOT a
 *      reliable long-term key (it can mutate during in-app crossgrades,
 *      which is exactly what our seat changes are).
 *   2. FALLBACK (initial purchase only, no account matches the
 *      originalTransactionId): appAccountToken is treated as an accounts.id
 *      UUID. The account must exist; we then stamp billing_provider='apple'
 *      + apple_original_transaction_id BEFORE the billing write, because
 *      writeAccountBillingById's provider gate would otherwise reject a
 *      still-'stripe' row.
 *
 * NO side effects in this pass: no GHL, no Slack, no Meta CAPI. The hook
 * point for those later is immediately after the writeAccountBillingById
 * call in applyBillingWrite() — mirroring how the Stripe handlers fire
 * sendGhlBillingEvent after their dual-write.
 *
 * Logging hygiene: never full payloads; transaction ids only as truncated
 * prefixes (see trunc()).
 */
import { db } from "../db";
import { accounts } from "@shared/models/auth";
import { processedStripeEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  verifyAppleNotification,
  verifyAppleTransactionInfo,
  AppleIapVerificationError,
} from "./appleIapVerify";
import { writeAccountBillingById } from "./stripeWebhook";

// ---------------------------------------------------------------------------
// productId -> seat count. THE single lookup: fieldview.seats.3 .. .10 → 3..10.
// ---------------------------------------------------------------------------
export function seatCountFromProductId(productId: unknown): number | null {
  if (typeof productId !== "string") return null;
  const m = /^fieldview\.seats\.(\d{1,2})$/.exec(productId);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 3 && n <= 10 ? n : null;
}

function trunc(id: unknown): string {
  return typeof id === "string" && id.length > 0 ? `${id.slice(0, 8)}…` : "(none)";
}

const LOG = "[apple-iap]";

export interface AppleNotificationResult {
  status: number;
  body: Record<string, any>;
}

const ok = (note: string): AppleNotificationResult => ({ status: 200, body: { received: true, note } });

/**
 * Full pipeline for one ASSN V2 request body. Returns the HTTP status/body
 * the route should send:
 *   200 — success AND every handled-but-unwritable case (unknown type,
 *         unmappable transaction, unknown productId): Apple must not retry.
 *   401 — signature/claim verification failure (forged/malformed: no retry).
 *   (Unexpected errors are NOT caught here — the route maps them to 500 so
 *   Apple retries.)
 */
export async function processAppleNotification(signedPayload: string): Promise<AppleNotificationResult> {
  let notification;
  try {
    notification = verifyAppleNotification(signedPayload);
  } catch (e) {
    if (e instanceof AppleIapVerificationError) {
      console.error(`${LOG} verification failed: ${e.message}`);
      return { status: 401, body: { error: "Verification failed" } };
    }
    throw e;
  }

  const { payload, environment } = notification;
  const notificationType: string = payload.notificationType;
  const subtype: string | undefined = payload.subtype;
  const notificationUUID: string | undefined = payload.notificationUUID;
  const eventLabel = `apple:${notificationType}${subtype ? `:${subtype}` : ""}`;

  // -------------------------------------------------------------------------
  // Dedupe on notificationUUID, reusing processed_stripe_events (shape fits:
  // varchar PK + type + timestamp) with an "apple:" prefix to keep the two
  // providers' id spaces disjoint. Checked FIRST; recorded only after a
  // successful outcome (see recordProcessed below) so a 500 leaves the UUID
  // unrecorded and Apple's retry is NOT skipped.
  // -------------------------------------------------------------------------
  const dedupeId = notificationUUID ? `apple:${notificationUUID}` : null;
  if (dedupeId) {
    const [existing] = await db
      .select({ eventId: processedStripeEvents.eventId })
      .from(processedStripeEvents)
      .where(eq(processedStripeEvents.eventId, dedupeId))
      .limit(1);
    if (existing) {
      console.log(`${LOG} ${eventLabel} duplicate notificationUUID — skipping redelivery`);
      return ok("duplicate");
    }
  }
  const recordProcessed = async () => {
    if (!dedupeId) return;
    await db
      .insert(processedStripeEvents)
      .values({ eventId: dedupeId, eventType: eventLabel })
      .onConflictDoNothing();
  };

  // -------------------------------------------------------------------------
  // Log-only notification types: write nothing, 200.
  // -------------------------------------------------------------------------
  if (notificationType === "DID_CHANGE_RENEWAL_PREF" || notificationType === "DID_CHANGE_RENEWAL_STATUS") {
    console.log(`${LOG} ${eventLabel} (${environment}) — log-only, no write`);
    await recordProcessed();
    return ok("log-only");
  }

  const WRITE_TYPES = new Set(["SUBSCRIBED", "DID_RENEW", "DID_FAIL_TO_RENEW", "EXPIRED", "REFUND", "REVOKE"]);
  if (!WRITE_TYPES.has(notificationType)) {
    console.log(`${LOG} unhandled notificationType ${eventLabel} (${environment}) — ignored`);
    await recordProcessed();
    return ok("unhandled-type");
  }

  // -------------------------------------------------------------------------
  // Decode the nested transaction info (verified with the same pinned chain).
  // -------------------------------------------------------------------------
  if (!notification.signedTransactionInfo) {
    console.log(`${LOG} ${eventLabel} carries no signedTransactionInfo — cannot map, ignored`);
    await recordProcessed();
    return ok("no-transaction-info");
  }
  let txn: Record<string, any>;
  try {
    txn = verifyAppleTransactionInfo(notification.signedTransactionInfo);
  } catch (e) {
    if (e instanceof AppleIapVerificationError) {
      console.error(`${LOG} ${eventLabel} nested transactionInfo verification failed: ${e.message}`);
      return { status: 401, body: { error: "Verification failed" } };
    }
    throw e;
  }

  const originalTransactionId: string | undefined = txn.originalTransactionId;
  const appAccountToken: string | undefined = txn.appAccountToken;
  const productId: string | undefined = txn.productId;

  if (!originalTransactionId) {
    console.log(`${LOG} ${eventLabel} transactionInfo has no originalTransactionId — ignored`);
    await recordProcessed();
    return ok("no-original-transaction-id");
  }

  // -------------------------------------------------------------------------
  // Account resolution. PRIMARY: apple_original_transaction_id.
  // -------------------------------------------------------------------------
  let [account] = await db
    .select({
      id: accounts.id,
      billingProvider: accounts.billingProvider,
      subscriptionLapsedAt: accounts.subscriptionLapsedAt,
    })
    .from(accounts)
    .where(eq(accounts.appleOriginalTransactionId, originalTransactionId))
    .limit(1);

  if (account) {
    if (appAccountToken && appAccountToken !== account.id) {
      // appAccountToken can mutate on crossgrades — the originalTransactionId
      // match wins; the mismatch is logged and otherwise ignored.
      console.warn(
        `${LOG} ${eventLabel} appAccountToken ${trunc(appAccountToken)} != account ${account.id} resolved via originalTransactionId ${trunc(originalTransactionId)} — using originalTransactionId match`,
      );
    }
  } else {
    // FALLBACK: initial purchase ONLY. appAccountToken IS our accounts.id
    // UUID — but claiming an account (stamping billing_provider='apple') is
    // restricted to SUBSCRIBED. A no-match on any other type (DID_RENEW,
    // DID_FAIL_TO_RENEW, EXPIRED, REFUND, REVOKE) must never rebind an
    // account: those cannot be an initial purchase, so a missing
    // originalTransactionId match there means an unmappable transaction.
    if (notificationType !== "SUBSCRIBED") {
      console.warn(
        `${LOG} UNMAPPABLE: ${eventLabel} (${environment}) originalTransactionId ${trunc(originalTransactionId)} matches no account and type is not SUBSCRIBED — no fallback claim, returning 200`,
      );
      await recordProcessed();
      return ok("unmappable");
    }
    if (!appAccountToken) {
      console.warn(
        `${LOG} UNMAPPABLE: ${eventLabel} (${environment}) originalTransactionId ${trunc(originalTransactionId)} matches no account and appAccountToken is absent — returning 200 so Apple does not retry forever`,
      );
      await recordProcessed();
      return ok("unmappable");
    }
    const [candidate] = await db
      .select({
        id: accounts.id,
        billingProvider: accounts.billingProvider,
        appleOriginalTransactionId: accounts.appleOriginalTransactionId,
        subscriptionLapsedAt: accounts.subscriptionLapsedAt,
      })
      .from(accounts)
      .where(eq(accounts.id, appAccountToken))
      .limit(1);
    if (!candidate) {
      console.warn(
        `${LOG} UNMAPPABLE: ${eventLabel} (${environment}) originalTransactionId ${trunc(originalTransactionId)} matches no account and appAccountToken ${trunc(appAccountToken)} is not an accounts.id — returning 200`,
      );
      await recordProcessed();
      return ok("unmappable");
    }
    // Defensive: never remap an account already bound to a DIFFERENT Apple
    // original transaction id — that would silently rebind someone else's
    // subscription onto this account.
    if (
      candidate.appleOriginalTransactionId &&
      candidate.appleOriginalTransactionId !== originalTransactionId
    ) {
      console.warn(
        `${LOG} UNMAPPABLE: ${eventLabel} account ${candidate.id} (via appAccountToken) is already bound to a different originalTransactionId ${trunc(candidate.appleOriginalTransactionId)} — refusing to remap, returning 200`,
      );
      await recordProcessed();
      return ok("unmappable");
    }
    // Initial purchase: stamp provider + original transaction id FIRST —
    // writeAccountBillingById's gate requires billing_provider='apple'
    // before it will accept the billing write below.
    await db
      .update(accounts)
      .set({ billingProvider: "apple", appleOriginalTransactionId: originalTransactionId })
      .where(eq(accounts.id, candidate.id));
    console.log(
      `${LOG} ${eventLabel} initial purchase: account ${candidate.id} claimed for apple (originalTransactionId ${trunc(originalTransactionId)}, previous provider ${candidate.billingProvider})`,
    );
    account = { ...candidate, billingProvider: "apple" };
  }

  // -------------------------------------------------------------------------
  // Map notificationType -> billing fields.
  // -------------------------------------------------------------------------
  const fields: {
    subscriptionStatus?: string;
    seatCount?: number;
    subscriptionLapsedAt?: Date | null;
  } = {};

  if (notificationType === "SUBSCRIBED" || notificationType === "DID_RENEW") {
    const seats = seatCountFromProductId(productId);
    if (seats == null) {
      console.warn(`${LOG} ${eventLabel} unknown productId — no write, returning 200`);
      await recordProcessed();
      return ok("unknown-product");
    }
    fields.subscriptionStatus = "active";
    fields.seatCount = seats;
    // Mirror the Stripe path's lapse-clear: recovering to active clears a
    // previously-set subscriptionLapsedAt.
    if (account.subscriptionLapsedAt != null) fields.subscriptionLapsedAt = null;
  } else if (notificationType === "DID_FAIL_TO_RENEW") {
    fields.subscriptionStatus = "past_due";
    // Mirror the Stripe path's lapse-set: only stamp the FIRST failure so the
    // 14-day read-only window anchors to the original lapse.
    if (account.subscriptionLapsedAt == null) fields.subscriptionLapsedAt = new Date();
  } else {
    // EXPIRED / REFUND / REVOKE
    fields.subscriptionStatus = "canceled";
  }

  const written = await writeAccountBillingById(eventLabel, account.id, "apple", fields);
  if (!written) {
    // Provider gate rejected (e.g. account still 'stripe' on a non-initial
    // notification) — logged inside writeAccountBillingById. Do NOT mark the
    // UUID processed: if the account is later claimed for apple, a replay
    // should land. 200 regardless — retrying won't change the gate.
    return ok("provider-gate-skip");
  }

  // <-- Side-effect hook point (later pass): GHL billing_event, Slack, Meta
  // CAPI (eventId from notificationUUID) would fire here, after the billing
  // write, mirroring the Stripe handlers' sendGhlBillingEvent placement.

  console.log(
    `${LOG} ${eventLabel} (${environment}) account ${account.id}: wrote ${Object.keys(fields).join(",")}`,
  );
  await recordProcessed();
  return ok("written");
}
