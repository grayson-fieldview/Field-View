/**
 * Google Play Billing (Android IAP) — verification module ONLY.
 *
 * Gate 1 of 3: no endpoints, no routes, no vercel.json changes. This module
 * mirrors the role of lib/appleIap.ts's verification half for Google:
 * authenticate a service account against the Android Publisher API, verify a
 * subscription purchaseToken (subscriptionsv2), and acknowledge purchases.
 *
 * Auth: a service-account JWT client built from
 * GOOGLE_PLAY_SERVICE_ACCOUNT_B64 (base64 → JSON service-account key) with
 * the androidpublisher scope, cached at module scope. The env var is read
 * lazily (first call), so importing this file never throws — same posture as
 * appleIap's APPLE_IAP_BUNDLE_ID handling.
 *
 * Error taxonomy (critical for the future endpoint):
 *   - "invalid_token"  — Google said 400/404: the purchaseToken/productId is
 *     bad or expired. Safe to surface to the client as a purchase problem.
 *   - "auth_failed"    — Google said 401/403: OUR credential/permission is
 *     broken. This is NOT the user's fault; the endpoint must NOT tell a
 *     paying customer their purchase is invalid — it should 500 and alert.
 */
import { JWT } from "google-auth-library";
import { waitUntil } from "@vercel/functions";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { accounts } from "@shared/models/auth";
import { processedStripeEvents } from "@shared/schema";
import { seatCountFromProductId } from "./appleIap";
import { hasUsableSubscription } from "./billing";
import { writeAccountBillingById } from "./stripeWebhook";
import { Sentry } from "./sentry";
import { capturePostHogEvent } from "./posthog";

// Re-export so future Google-path callers import the single parser from
// here without a second appleIap dependency (do NOT duplicate the parser).
export { seatCountFromProductId };

const LOG = "[google-play]";
const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";

// ---------------------------------------------------------------------------
// PostHog billing capture — synchronous, non-fatal. Called immediately (no
// void) so the SDK's waitUntil-backed flush registers before the serverless
// handler returns. userId is the account owner (account.ownerId); callers skip
// the call when it is null. Never throws.
// ---------------------------------------------------------------------------
function captureGoogleBillingPostHogEvent(opts: {
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
    console.error(`${LOG} [posthog] ${opts.event} capture failed (non-fatal):`, err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Module-scope cached JWT client.
// ---------------------------------------------------------------------------
let cachedClient: JWT | null = null;

function getJwtClient(): JWT {
  if (cachedClient) return cachedClient;

  const b64 = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_B64;
  if (!b64) {
    throw new Error(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_B64 is not set — cannot authenticate to the Android Publisher API. " +
        "Set it to the base64-encoded service-account JSON key.",
    );
  }

  let key: { client_email?: string; private_key?: string };
  try {
    key = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e: any) {
    throw new Error(
      `GOOGLE_PLAY_SERVICE_ACCOUNT_B64 is not parseable (expected base64-encoded JSON service-account key): ${e?.message}`,
    );
  }
  if (!key.client_email || !key.private_key) {
    throw new Error(
      "GOOGLE_PLAY_SERVICE_ACCOUNT_B64 decoded, but the JSON is missing client_email/private_key — not a service-account key.",
    );
  }

  cachedClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  return cachedClient;
}

function getPackageName(): string {
  const pkg = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  if (!pkg) {
    throw new Error("GOOGLE_PLAY_PACKAGE_NAME is not set — cannot build Android Publisher API URLs.");
  }
  return pkg;
}

// ---------------------------------------------------------------------------
// verifyGooglePlayPurchase — subscriptionsv2 token lookup.
// ---------------------------------------------------------------------------
export interface GooglePlayVerifiedPurchase {
  ok: true;
  /** e.g. SUBSCRIPTION_STATE_ACTIVE, SUBSCRIPTION_STATE_IN_GRACE_PERIOD, ... */
  subscriptionState: string | null;
  /** productId of the first line item (single-product subscriptions). */
  productId: string | null;
  /** ISO 8601 expiry of the first line item, if present. */
  expiryTime: string | null;
  /** ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED / _PENDING (subscriptionsv2 field). */
  acknowledgementState: string | null;
  /** Present on upgrades/resubscribes — the token this one replaced. */
  linkedPurchaseToken: string | null;
  latestOrderId: string | null;
  /** Full SubscriptionPurchaseV2 body for anything not normalized above. */
  raw: Record<string, any>;
}

export type GooglePlayVerifyResult =
  | GooglePlayVerifiedPurchase
  // 400/404 from the PUBLISHER API: the token (or product) is invalid or
  // expired — a client-side problem, safe to reject the purchase.
  | { ok: false; error: "invalid_token"; status: number; detail: string }
  // OUR service-account credential or API access is broken (Publisher API
  // 401/403, or ANY failure minting the OAuth access token — token-mint
  // errors are often HTTP 400 invalid_grant and must never be conflated
  // with an invalid purchase). Never blame the customer for this.
  | { ok: false; error: "auth_failed"; status: number; detail: string }
  // Token verified, but the subscription's line items do not include the
  // productId the client claimed — never trust client input for entitlement.
  | { ok: false; error: "product_mismatch"; status: number; detail: string };

// Mint the access token as a SEPARATE step so credential failures (which
// Google's OAuth endpoint often reports as HTTP 400 invalid_grant) can never
// be misclassified as a Publisher-API "invalid purchase token" 400.
async function mintAccessTokenOrAuthFailed(
  client: JWT,
): Promise<{ ok: true } | { ok: false; error: "auth_failed"; status: number; detail: string }> {
  try {
    await client.getAccessToken();
    return { ok: true };
  } catch (e: any) {
    const status: number = e?.response?.status ?? 0;
    const detail: string = e?.response?.data?.error_description || e?.response?.data?.error?.message || e?.message || "OAuth token mint failed";
    console.error(`${LOG} AUTH FAILED minting OAuth access token (HTTP ${status || "n/a"}) — service-account credential problem: ${detail}`);
    return { ok: false, error: "auth_failed", status, detail };
  }
}

// Config failures (missing/unparseable service-account key or package name)
// are OUR problem, exactly like an OAuth credential failure — normalize them
// to "auth_failed" so callers return the retryable 503, never a client error.
function getClientAndPackageOrAuthFailed():
  | { ok: true; client: JWT; packageName: string }
  | { ok: false; error: "auth_failed"; status: number; detail: string } {
  try {
    return { ok: true, client: getJwtClient(), packageName: getPackageName() };
  } catch (e: any) {
    console.error(`${LOG} AUTH FAILED — configuration error: ${e?.message}`);
    return { ok: false, error: "auth_failed", status: 0, detail: e?.message ?? "configuration error" };
  }
}

/**
 * @param productId Product hint. When a NONEMPTY hint is supplied (client
 *   purchase submissions), the verified line items MUST include it —
 *   mismatch is rejected. When null/empty (RTDN notifications, which may
 *   omit subscriptionId), no matching is enforced and the verified product
 *   is derived solely from the Publisher API line items: the single item,
 *   else the first item with a parseable fieldview.seats.* productId, else
 *   the first item (downstream seat derivation handles unknown products).
 */
export async function verifyGooglePlayPurchase(
  purchaseToken: string,
  productId: string | null,
): Promise<GooglePlayVerifyResult> {
  const cfg = getClientAndPackageOrAuthFailed();
  if (!cfg.ok) return cfg;
  const { client, packageName } = cfg;
  const url = `${API_BASE}/applications/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;

  const minted = await mintAccessTokenOrAuthFailed(client);
  if (!minted.ok) return minted;

  let body: Record<string, any>;
  try {
    const res = await client.request<Record<string, any>>({ url, method: "GET" });
    body = res.data ?? {};
  } catch (e: any) {
    // google-auth-library throws GaxiosError on non-2xx. The OAuth token was
    // minted above, so these statuses are from the Publisher API itself.
    const status: number = e?.response?.status ?? 0;
    const detail: string =
      e?.response?.data?.error?.message || e?.message || "Android Publisher API request failed";
    if (status === 400 || status === 404) {
      console.warn(`${LOG} verify: invalid token/product (HTTP ${status}): ${detail}`);
      return { ok: false, error: "invalid_token", status, detail };
    }
    if (status === 401 || status === 403) {
      // Credential problem — ours, not the customer's.
      console.error(`${LOG} verify: AUTH FAILED (HTTP ${status}) — service-account credential/permission problem: ${detail}`);
      return { ok: false, error: "auth_failed", status, detail };
    }
    // Anything else (network, 5xx) is unexpected — throw so the caller maps
    // it to a retryable 500, mirroring appleIap's posture.
    throw e;
  }

  // ENTITLEMENT: the verified product derives from what Google says this
  // subscription actually contains — never from client input.
  const lineItems: any[] = Array.isArray(body.lineItems) ? body.lineItems : [];
  let lineItem: any;
  if (productId) {
    // Nonempty hint (client purchase submission): the line items MUST
    // include the claimed product — reject a mismatch.
    lineItem = lineItems.find((li) => li?.productId === productId);
    if (!lineItem) {
      const found = lineItems.map((li) => li?.productId).filter(Boolean).join(",") || "(none)";
      console.warn(`${LOG} verify: product mismatch — client claimed ${productId}, subscription contains [${found}]`);
      return {
        ok: false,
        error: "product_mismatch",
        status: 200,
        detail: `Subscription line items do not include ${productId}`,
      };
    }
  } else {
    // No hint (RTDN may omit subscriptionId): derive from the verified line
    // items alone. Single item, else first with a parseable seat product,
    // else first — downstream seat derivation rejects unknown products.
    lineItem =
      lineItems.length === 1
        ? lineItems[0]
        : lineItems.find((li) => seatCountFromProductId(li?.productId) != null) ?? lineItems[0];
  }
  return {
    ok: true,
    subscriptionState: body.subscriptionState ?? null,
    productId: lineItem?.productId ?? null,
    expiryTime: lineItem?.expiryTime ?? null,
    acknowledgementState: body.acknowledgementState ?? null,
    linkedPurchaseToken: body.linkedPurchaseToken ?? null,
    latestOrderId: body.latestOrderId ?? null,
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// acknowledgeGooglePlayPurchase — subscriptions v1 :acknowledge.
//
// NOTE: the v1 acknowledge URL requires the productId (subscriptionId) path
// segment, so it is a required second parameter here — the spec's
// single-argument signature cannot construct the URL. Callers get the
// productId from the verify step's line item.
//
// IDEMPOTENT: Google returns an error for an already-acknowledged purchase
// ("The subscription purchase is already acknowledged" / HTTP 400) — that is
// treated as success. Only a genuine failure returns false/throws.
// ---------------------------------------------------------------------------
export type GooglePlayAcknowledgeResult =
  | { ok: true; alreadyAcknowledged: boolean }
  | { ok: false; error: "invalid_token" | "auth_failed"; status: number; detail: string };

export async function acknowledgeGooglePlayPurchase(
  purchaseToken: string,
  productId: string,
): Promise<GooglePlayAcknowledgeResult> {
  const cfg = getClientAndPackageOrAuthFailed();
  if (!cfg.ok) return cfg;
  const { client, packageName } = cfg;
  const url = `${API_BASE}/applications/${encodeURIComponent(packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

  const minted = await mintAccessTokenOrAuthFailed(client);
  if (!minted.ok) return minted;

  try {
    await client.request({ url, method: "POST", data: {} });
    return { ok: true, alreadyAcknowledged: false };
  } catch (e: any) {
    const status: number = e?.response?.status ?? 0;
    const detail: string =
      e?.response?.data?.error?.message || e?.message || "Android Publisher API request failed";

    // Idempotency: an already-acknowledged purchase surfaces as a Publisher
    // API 400 with an "already acknowledged" message — treat as success so
    // restore/retry flows never fail on a completed ack. Constrained to 400
    // so an unrelated error mentioning the phrase can't become success.
    if (status === 400 && /already\s+acknowledged/i.test(detail)) {
      console.log(`${LOG} acknowledge: already acknowledged — treating as success`);
      return { ok: true, alreadyAcknowledged: true };
    }
    if (status === 400 || status === 404) {
      console.warn(`${LOG} acknowledge: invalid token/product (HTTP ${status}): ${detail}`);
      return { ok: false, error: "invalid_token", status, detail };
    }
    if (status === 401 || status === 403) {
      console.error(`${LOG} acknowledge: AUTH FAILED (HTTP ${status}) — service-account credential/permission problem: ${detail}`);
      return { ok: false, error: "auth_failed", status, detail };
    }
    throw e;
  }
}

function trunc(id: unknown): string {
  return typeof id === "string" && id.length > 0 ? `${id.slice(0, 8)}…` : "(none)";
}

// ---------------------------------------------------------------------------
// Account resolution — mirrors resolveAppleAccountByTransaction, with ONE
// structural addition: the LINKED-TOKEN lookup. Google ROTATES the
// purchaseToken on upgrade/downgrade/resubscribe (Apple's
// originalTransactionId is stable, so it has no equivalent); the new token's
// SubscriptionPurchaseV2 carries linkedPurchaseToken pointing at the token it
// replaced. A linked hit is the SAME subscriber changing tiers — migrate the
// row to the new token and treat it as a primary match (no claim refusals).
// ---------------------------------------------------------------------------
export interface GooglePlayResolvedAccount {
  id: string;
  billingProvider: string | null;
  subscriptionLapsedAt: Date | null;
  // Account owner userId — used as the PostHog capture identity (skip capture
  // if null). Carried on the resolved account so no extra lookup is needed.
  ownerId: string | null;
}

export type GooglePlayAccountResolution =
  | {
      outcome: "resolved";
      account: GooglePlayResolvedAccount;
      /**
       * Set when the account was found via linkedPurchaseToken (token
       * rotation). The DB row still holds fromToken — NO write has happened.
       * The caller must run applyGooglePlayTokenMigration AFTER its
       * authorization checks pass, so an attacker submitting someone else's
       * rotated token can never mutate that account's stored token.
       */
      pendingMigration?: { fromToken: string; toToken: string };
    }
  | { outcome: "no-match-no-claim" }
  | { outcome: "claim-token-missing" }
  | { outcome: "claim-account-not-found" }
  | { outcome: "claim-bound-elsewhere" }
  // Double-charge guard (purchase path only): the claim target still has a
  // usable Stripe subscription — claiming it for google would bill twice.
  | { outcome: "stripe-conflict" };

export async function resolveGooglePlayAccountByToken(
  purchaseToken: string,
  linkedPurchaseToken: string | null,
  claimAccountId: string | null,
  opts: { allowClaim: boolean; guardStripeDoubleCharge: boolean },
): Promise<GooglePlayAccountResolution> {
  const { allowClaim, guardStripeDoubleCharge } = opts;
  const eventLabel = "google:PURCHASE";

  // PRIMARY: current token.
  const [account] = await db
    .select({
      id: accounts.id,
      billingProvider: accounts.billingProvider,
      subscriptionLapsedAt: accounts.subscriptionLapsedAt,
      ownerId: accounts.ownerId,
    })
    .from(accounts)
    .where(eq(accounts.googlePlayPurchaseToken, purchaseToken))
    .limit(1);

  if (account) {
    if (claimAccountId && claimAccountId !== account.id) {
      console.warn(
        `${LOG} ${eventLabel} purchaser accountId ${trunc(claimAccountId)} != account ${account.id} resolved via purchaseToken ${trunc(purchaseToken)} — using purchaseToken match`,
      );
    }
    return { outcome: "resolved", account };
  }

  // LINKED-TOKEN LOOKUP: token rotation (upgrade/downgrade/resubscribe).
  // Same subscriber — migrate the row to the new token, no claim refusals.
  if (linkedPurchaseToken) {
    const [linked] = await db
      .select({
        id: accounts.id,
        billingProvider: accounts.billingProvider,
        subscriptionLapsedAt: accounts.subscriptionLapsedAt,
        ownerId: accounts.ownerId,
      })
      .from(accounts)
      .where(eq(accounts.googlePlayPurchaseToken, linkedPurchaseToken))
      .limit(1);
    if (linked) {
      // SIDE-EFFECT-FREE: the migration is returned as intent, not applied
      // here — the caller must authorize the purchaser against this account
      // BEFORE calling applyGooglePlayTokenMigration. (A pre-authorization
      // write here would let anyone holding a rotated token mutate the
      // victim account's stored token even though the request 409s.)
      console.log(
        `${LOG} ${eventLabel} token rotation detected: account ${linked.id} matched via linkedPurchaseToken ${trunc(linkedPurchaseToken)} — migration to ${trunc(purchaseToken)} pending authorization`,
      );
      return {
        outcome: "resolved",
        account: linked,
        pendingMigration: { fromToken: linkedPurchaseToken, toToken: purchaseToken },
      };
    }
  }

  if (!allowClaim) return { outcome: "no-match-no-claim" };
  // (fallback claim path continues below)
  if (!claimAccountId) return { outcome: "claim-token-missing" };

  const [candidate] = await db
    .select({
      id: accounts.id,
      billingProvider: accounts.billingProvider,
      googlePlayPurchaseToken: accounts.googlePlayPurchaseToken,
      subscriptionLapsedAt: accounts.subscriptionLapsedAt,
      stripeCustomerId: accounts.stripeCustomerId,
      stripeSubscriptionId: accounts.stripeSubscriptionId,
      subscriptionStatus: accounts.subscriptionStatus,
      ownerId: accounts.ownerId,
    })
    .from(accounts)
    .where(eq(accounts.id, claimAccountId))
    .limit(1);
  if (!candidate) return { outcome: "claim-account-not-found" };

  // Defensive: never remap an account already bound to a DIFFERENT Google
  // Play token — that would silently rebind someone else's subscription.
  // (A rotation of THIS account's token is handled by the linked lookup
  // above; reaching here with a bound token means the tokens are unrelated.)
  if (candidate.googlePlayPurchaseToken && candidate.googlePlayPurchaseToken !== purchaseToken) {
    console.warn(
      `${LOG} UNMAPPABLE: ${eventLabel} account ${candidate.id} (via purchaser accountId) is already bound to a different purchaseToken ${trunc(candidate.googlePlayPurchaseToken)} — refusing to remap`,
    );
    return { outcome: "claim-bound-elsewhere" };
  }

  // Double-charge guard (mirror of the Apple purchase path): never claim an
  // account that still has a usable Stripe subscription.
  if (guardStripeDoubleCharge && candidate.billingProvider !== "google" && hasUsableSubscription(candidate)) {
    console.warn(
      `${LOG} ${eventLabel} account ${candidate.id} still has a usable Stripe subscription — refusing google claim (double-charge guard)`,
    );
    return { outcome: "stripe-conflict" };
  }

  // Initial purchase: stamp provider + token FIRST — writeAccountBillingById's
  // gate requires billing_provider='google' before it accepts the write.
  await db
    .update(accounts)
    .set({ billingProvider: "google", googlePlayPurchaseToken: purchaseToken })
    .where(eq(accounts.id, candidate.id));
  console.log(
    `${LOG} ${eventLabel} initial purchase: account ${candidate.id} claimed for google (purchaseToken ${trunc(purchaseToken)}, previous provider ${candidate.billingProvider})`,
  );
  return {
    outcome: "resolved",
    account: {
      id: candidate.id,
      billingProvider: "google",
      subscriptionLapsedAt: candidate.subscriptionLapsedAt,
      ownerId: candidate.ownerId,
    },
  };
}

/**
 * Apply a pending token-rotation migration — call ONLY after the caller has
 * authorized the purchaser against the resolved account. Conditional UPDATE
 * guards the old token so a concurrent migration/claim can't be clobbered.
 */
export async function applyGooglePlayTokenMigration(
  accountId: string,
  migration: { fromToken: string; toToken: string },
): Promise<void> {
  await db
    .update(accounts)
    .set({ googlePlayPurchaseToken: migration.toToken })
    .where(and(eq(accounts.id, accountId), eq(accounts.googlePlayPurchaseToken, migration.fromToken)));
  console.log(
    `${LOG} token rotation: account ${accountId} migrated from ${trunc(migration.fromToken)} to ${trunc(migration.toToken)}`,
  );
}

// ---------------------------------------------------------------------------
// Purchase submission pipeline — POST /api/billing/google/purchase.
// Mirrors processApplePurchase: verify → seat derivation from the VERIFIED
// line item → resolve (claim allowed, Stripe double-charge guard) →
// cross-account authorization → provider-gated billing write → deferred
// acknowledge. Idempotent by construction: a repeat token re-resolves via the
// already-bound google_play_purchase_token and re-writes identical values.
// ---------------------------------------------------------------------------
export interface GooglePlayPurchaseResult {
  status: number;
  /** Error body for non-200; on 200 the route responds with the serialized user instead. */
  body?: Record<string, any>;
}

const USABLE_SUBSCRIPTION_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
]);

export async function processGooglePlayPurchase(
  purchaseToken: string,
  productId: string,
  purchaserAccountId: string | null,
): Promise<GooglePlayPurchaseResult> {
  const eventLabel = "google:PURCHASE";

  const verified = await verifyGooglePlayPurchase(purchaseToken, productId);
  if (!verified.ok) {
    if (verified.error === "auth_failed") {
      // OUR credential problem — retryable, never blame the purchase.
      Sentry.captureMessage("[google-play] verification unavailable — service-account auth failed", {
        level: "error",
        tags: { source: "google_play_purchase" },
      });
      return {
        status: 503,
        body: { error: "verification_unavailable", message: "Purchase verification is temporarily unavailable. Please retry." },
      };
    }
    // invalid_token / product_mismatch — terminal; client should stop
    // retrying this token (same code the Apple path uses).
    return { status: 401, body: { error: "verification_failed", message: "Verification failed" } };
  }

  // Seat count from the VERIFIED line item's productId — never the client's.
  const seats = seatCountFromProductId(verified.productId);
  if (seats == null) {
    console.warn(`${LOG} ${eventLabel} unknown productId ${verified.productId} — rejected`);
    return { status: 400, body: { error: "unknown_product" } };
  }

  if (!verified.subscriptionState || !USABLE_SUBSCRIPTION_STATES.has(verified.subscriptionState)) {
    console.warn(`${LOG} ${eventLabel} subscriptionState ${verified.subscriptionState} not usable — rejected`);
    return {
      status: 400,
      body: { error: "subscription_not_active", message: "This subscription is not active." },
    };
  }

  const resolution = await resolveGooglePlayAccountByToken(
    purchaseToken,
    verified.linkedPurchaseToken,
    purchaserAccountId,
    { allowClaim: true, guardStripeDoubleCharge: true },
  );
  if (resolution.outcome !== "resolved") {
    switch (resolution.outcome) {
      case "stripe-conflict":
        return {
          status: 409,
          body: {
            error: "stripe_subscription_active",
            message:
              "This account already has an active subscription billed through Stripe. Manage it from the web app.",
          },
        };
      case "claim-bound-elsewhere":
        return {
          status: 409,
          body: {
            error: "account_bound_to_other_subscription",
            message: "This account is already linked to a different Google Play subscription.",
          },
        };
      case "claim-token-missing":
      case "claim-account-not-found":
        return { status: 400, body: { error: "no_account", message: "No account to attach this purchase to." } };
      default:
        // no-match-no-claim is unreachable (allowClaim: true).
        return { status: 400, body: { error: "unmappable" } };
    }
  }
  const account = resolution.account;

  // AUTHORIZATION: the purchaser may only apply a token to their OWN account
  // (mirror of the Apple cross-account check — a token already bound to a
  // different account must not let an authenticated user mutate it).
  if (!purchaserAccountId || account.id !== purchaserAccountId) {
    console.warn(
      `${LOG} ${eventLabel} resolved account ${account.id} != purchaser account ${trunc(purchaserAccountId)} — rejected (cross-account write blocked)`,
    );
    return {
      status: 409,
      body: {
        error: "transaction_bound_to_other_account",
        message: "This Google Play purchase is linked to a different Field View account.",
      },
    };
  }

  // Token-rotation migration — applied ONLY now, after the cross-account
  // authorization above passed (resolution itself is side-effect-free).
  if (resolution.pendingMigration) {
    await applyGooglePlayTokenMigration(account.id, resolution.pendingMigration);
  }

  // Read prior subscriptionStatus BEFORE the billing write.
  let priorAccountStatus: string | null = null;
  try {
    const [priorAcct] = await db
      .select({ subscriptionStatus: accounts.subscriptionStatus })
      .from(accounts)
      .where(eq(accounts.id, account.id))
      .limit(1);
    priorAccountStatus = priorAcct?.subscriptionStatus ?? null;
  } catch {}

  // Same field mapping as the Apple purchase path.
  const fields: { subscriptionStatus: string; seatCount: number; subscriptionLapsedAt?: Date | null } = {
    subscriptionStatus: "active",
    seatCount: seats,
  };
  if (account.subscriptionLapsedAt != null) fields.subscriptionLapsedAt = null;

  const written = await writeAccountBillingById(eventLabel, account.id, "google", fields);
  if (!written) {
    // Provider gate rejected — logged inside writeAccountBillingById.
    return { status: 409, body: { error: "provider_conflict", message: "Account billing is owned by another provider." } };
  }

  // PostHog billing events — after successful billing write. Owner identity
  // (account.ownerId) is required; skip capture entirely when it is null.
  // trial_ended: prior status trialing → new status (always "active" on this
  //   path) not trialing. Dedupe on purchaseToken covers overlapping RTDN +
  //   purchase paths. Raw token NEVER placed in properties (SHA-256-derived to
  //   a UUID by the shared helper's dedupeKey only).
  // subscribed: inactive/non-active → active initial subscription.
  const newPurchaseStatus = fields.subscriptionStatus;
  if (account.ownerId) {
    if (priorAccountStatus === "trialing" && newPurchaseStatus !== "trialing") {
      captureGoogleBillingPostHogEvent({
        event: "trial_ended",
        userId: account.ownerId,
        accountId: account.id,
        dedupeKey: `trial_ended:google:${purchaseToken}`,
        properties: {
          provider: "google",
          product_id: productId,
          subscription_state: verified.subscriptionState,
          latest_order_id: verified.latestOrderId,
          new_status: newPurchaseStatus,
        },
      });
    }
    if (priorAccountStatus !== "active") {
      captureGoogleBillingPostHogEvent({
        event: "subscribed",
        userId: account.ownerId,
        accountId: account.id,
        dedupeKey: `subscribed:google:${purchaseToken}`,
        properties: {
          provider: "google",
          product_id: productId,
          subscription_state: verified.subscriptionState,
          latest_order_id: verified.latestOrderId,
        },
      });
    }
  }

  console.log(`${LOG} ${eventLabel} account ${account.id}: wrote ${Object.keys(fields).join(",")}`);

  // ACKNOWLEDGE after the successful billing write — Google refunds
  // unacknowledged purchases after 3 days, so failure here is serious, but it
  // must never fail the customer's 200 (the billing state is already
  // written; ack is retried on the next submission/restore since verify+ack
  // are idempotent). Deferred via waitUntil on Vercel; outside a Vercel
  // request context waitUntil can throw — fall back to a dangling promise
  // (same pattern as lib/ghl.ts).
  const ackPromise = acknowledgeGooglePlayPurchase(purchaseToken, verified.productId!)
    .then((ack) => {
      if (!ack.ok) {
        console.error(`${LOG} ${eventLabel} acknowledge FAILED (${ack.error}, HTTP ${ack.status}): ${ack.detail}`);
        Sentry.captureMessage("[google-play] acknowledge failed after billing write", {
          level: "error",
          tags: { source: "google_play_purchase" },
          extra: { accountId: account.id, error: ack.error, status: ack.status },
        });
      }
    })
    .catch((e: any) => {
      console.error(`${LOG} ${eventLabel} acknowledge threw: ${e?.message}`);
      Sentry.captureException(e, { tags: { source: "google_play_purchase_ack" } });
    });
  try {
    waitUntil(ackPromise);
  } catch {
    // Local dev / non-Vercel: dangling promise with its own error handling.
  }

  return { status: 200 };
}

// ---------------------------------------------------------------------------
// RTDN (Real-Time Developer Notifications) pipeline — mirrors
// processAppleNotification. Input is the DECODED DeveloperNotification JSON
// (the Vercel function handles Pub/Sub envelope parsing + JWT verification)
// plus the Pub/Sub messageId for dedupe. Returns the HTTP status/body the
// route should send:
//   200 — success AND every handled-but-unwritable case (unknown type,
//         unmappable token, unknown productId): Google must not retry.
//   (Unexpected errors are NOT caught here — the route maps them to 500 so
//   Pub/Sub retries.)
// ---------------------------------------------------------------------------
export interface GooglePlayNotificationResult {
  status: number;
  body: Record<string, any>;
}

const ok = (note: string): GooglePlayNotificationResult => ({ status: 200, body: { received: true, note } });

// notificationType → semantic (Google Play RTDN subscriptionNotification).
const RTDN_TYPE_NAMES: Record<number, string> = {
  1: "SUBSCRIPTION_RECOVERED",
  2: "SUBSCRIPTION_RENEWED",
  3: "SUBSCRIPTION_CANCELED",
  4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD",
  6: "SUBSCRIPTION_IN_GRACE_PERIOD",
  7: "SUBSCRIPTION_RESTARTED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
};

const ACTIVE_TYPES = new Set([1, 2, 4, 7]); // RECOVERED, RENEWED, PURCHASED, RESTARTED
const PAST_DUE_TYPES = new Set([5, 6]); // ON_HOLD, IN_GRACE_PERIOD
const CANCELED_TYPES = new Set([12, 13]); // REVOKED, EXPIRED

export async function processGooglePlayNotification(
  developerNotification: Record<string, any>,
  messageId: string | null,
): Promise<GooglePlayNotificationResult> {
  const subNotif = developerNotification?.subscriptionNotification;
  const notificationType: number | undefined = subNotif?.notificationType;
  const typeName =
    notificationType != null ? RTDN_TYPE_NAMES[notificationType] ?? `TYPE_${notificationType}` : "NO_TYPE";
  const eventLabel = `google:${typeName}`;

  // -------------------------------------------------------------------------
  // Dedupe on Pub/Sub messageId, reusing processed_stripe_events with a
  // "google:" prefix (same pattern as "apple:"). Checked FIRST; recorded only
  // after a successful outcome so a 500 leaves the id unrecorded and Pub/Sub's
  // retry is NOT skipped.
  // -------------------------------------------------------------------------
  const dedupeId = messageId ? `google:${messageId}` : null;
  if (dedupeId) {
    const [existing] = await db
      .select({ eventId: processedStripeEvents.eventId })
      .from(processedStripeEvents)
      .where(eq(processedStripeEvents.eventId, dedupeId))
      .limit(1);
    if (existing) {
      console.log(`${LOG} ${eventLabel} duplicate messageId — skipping redelivery`);
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

  if (!subNotif) {
    // testNotification / oneTimeProductNotification / voidedPurchase etc.
    console.log(`${LOG} notification carries no subscriptionNotification — ignored`);
    await recordProcessed();
    return ok("no-subscription-notification");
  }

  const purchaseToken: string | undefined = subNotif.purchaseToken;
  const subscriptionId: string | undefined = subNotif.subscriptionId;
  if (typeof notificationType !== "number" || !purchaseToken) {
    console.log(`${LOG} ${eventLabel} missing notificationType/purchaseToken — ignored`);
    await recordProcessed();
    return ok("malformed-subscription-notification");
  }

  // CANCELED (3): log-only — the subscription runs to expiry; EXPIRED (13)
  // will do the write later.
  if (notificationType === 3) {
    console.log(`${LOG} ${eventLabel} — log-only, subscription runs to expiry, no write`);
    await recordProcessed();
    return ok("log-only");
  }

  if (!ACTIVE_TYPES.has(notificationType) && !PAST_DUE_TYPES.has(notificationType) && !CANCELED_TYPES.has(notificationType)) {
    console.log(`${LOG} unhandled notificationType ${notificationType} (${typeName}) — ignored`);
    await recordProcessed();
    return ok("unhandled-type");
  }

  // -------------------------------------------------------------------------
  // Re-verify the purchaseToken against the Publisher API — never trust the
  // notification payload (mirrors Apple's pinned-chain re-verification).
  // subscriptionId from the payload is only a hint; verification matches it
  // against the REAL line items.
  // -------------------------------------------------------------------------
  // Pass the payload's subscriptionId as a HINT only — RTDN may omit it, in
  // which case verification derives the product from the line items alone.
  const verified = await verifyGooglePlayPurchase(purchaseToken, subscriptionId || null);
  if (!verified.ok) {
    if (verified.error === "product_mismatch") {
      // Token verified, but the payload's subscriptionId hint didn't match
      // the real line items — the hint is untrusted, so no write.
      console.warn(`${LOG} ${eventLabel} payload subscriptionId ${subscriptionId} does not match verified line items — no write`);
      await recordProcessed();
      return ok("product-mismatch");
    }
    if (verified.error === "invalid_token") {
      console.warn(`${LOG} UNMAPPABLE: ${eventLabel} purchaseToken ${trunc(purchaseToken)} rejected by Publisher API — returning 200`);
      await recordProcessed();
      return ok("invalid-token");
    }
    // auth_failed — OUR credential problem; throw so the route returns 500
    // and Pub/Sub retries once the credential is fixed.
    throw new Error(`Google Play verification unavailable (auth_failed): ${verified.detail}`);
  }
  const verifiedProductId = verified.productId;
  const linkedPurchaseToken = verified.linkedPurchaseToken;

  const resolution = await resolveGooglePlayAccountByToken(
    purchaseToken,
    linkedPurchaseToken,
    null,
    {
      // Claiming is restricted to SUBSCRIPTION_PURCHASED (4) — but with no
      // claimAccountId available from RTDN (no obfuscatedAccountId wiring
      // yet), a claim can never actually fire; the flag mirrors Apple's
      // SUBSCRIBED-only posture for when a claim key is added.
      allowClaim: notificationType === 4,
      // Google has already charged by notification time — the Stripe guard
      // applies only to the purchase path (same reasoning as Apple).
      guardStripeDoubleCharge: false,
    },
  );
  if (resolution.outcome !== "resolved") {
    console.warn(
      `${LOG} UNMAPPABLE: ${eventLabel} purchaseToken ${trunc(purchaseToken)} matches no account (${resolution.outcome}) — returning 200`,
    );
    await recordProcessed();
    return ok("unmappable");
  }
  const account = resolution.account;

  // Token rotation from a notification is server-observed (Google-verified
  // linkage), not client-claimed — safe to apply without a purchaser check.
  if (resolution.pendingMigration) {
    await applyGooglePlayTokenMigration(account.id, resolution.pendingMigration);
  }

  // -------------------------------------------------------------------------
  // Map notificationType -> billing fields (mirrors the Apple mapping).
  // -------------------------------------------------------------------------
  const fields: {
    subscriptionStatus?: string;
    seatCount?: number;
    subscriptionLapsedAt?: Date | null;
  } = {};

  if (ACTIVE_TYPES.has(notificationType)) {
    const seats = seatCountFromProductId(verifiedProductId);
    if (seats == null) {
      console.warn(`${LOG} ${eventLabel} unknown productId ${verifiedProductId} — no write, returning 200`);
      await recordProcessed();
      return ok("unknown-product");
    }
    fields.subscriptionStatus = "active";
    fields.seatCount = seats;
    // Mirror the Stripe/Apple lapse-clear: recovering to active clears a
    // previously-set subscriptionLapsedAt.
    if (account.subscriptionLapsedAt != null) fields.subscriptionLapsedAt = null;
  } else if (PAST_DUE_TYPES.has(notificationType)) {
    fields.subscriptionStatus = "past_due";
    // Only stamp the FIRST failure so the 14-day read-only window anchors to
    // the original lapse (mirrors Apple DID_FAIL_TO_RENEW).
    if (account.subscriptionLapsedAt == null) fields.subscriptionLapsedAt = new Date();
  } else {
    // REVOKED / EXPIRED
    fields.subscriptionStatus = "canceled";
  }

  // Read prior subscriptionStatus BEFORE the billing write so PostHog can
  // detect genuine state transitions.
  let priorAccountStatus: string | null = null;
  try {
    const [priorAcct] = await db
      .select({ subscriptionStatus: accounts.subscriptionStatus })
      .from(accounts)
      .where(eq(accounts.id, account.id))
      .limit(1);
    priorAccountStatus = priorAcct?.subscriptionStatus ?? null;
  } catch {}

  const written = await writeAccountBillingById(eventLabel, account.id, "google", fields);
  if (!written) {
    // Provider gate rejected — do NOT mark the messageId processed: if the
    // account is later claimed for google, a replay should land. 200
    // regardless — retrying won't change the gate.
    return ok("provider-gate-skip");
  }

  // PostHog billing events — after successful billing write. Owner identity
  // (account.ownerId) is required; skip capture entirely when it is null.
  // trial_ended: prior status trialing → new status not trialing. Dedupe on
  //   purchaseToken (stable per-subscription) collapses concurrent/out-of-order
  //   duplicate transition observations. Raw token NEVER in properties.
  // subscribed: ACTIVE_TYPES writing active, prior status was not active.
  //   Dedupe on purchaseToken covers overlapping RTDN + mobile purchase paths.
  const newStatus = fields.subscriptionStatus;
  if (account.ownerId) {
    if (priorAccountStatus === "trialing" && newStatus !== "trialing") {
      captureGoogleBillingPostHogEvent({
        event: "trial_ended",
        userId: account.ownerId,
        accountId: account.id,
        dedupeKey: `trial_ended:google:${purchaseToken}`,
        properties: {
          provider: "google",
          notification_type: notificationType,
          notification_type_name: typeName,
          pub_sub_message_id: messageId,
          new_status: newStatus,
        },
      });
    }
    if (newStatus === "active" && priorAccountStatus !== "active") {
      captureGoogleBillingPostHogEvent({
        event: "subscribed",
        userId: account.ownerId,
        accountId: account.id,
        dedupeKey: `subscribed:google:${purchaseToken}`,
        properties: {
          provider: "google",
          notification_type: notificationType,
          notification_type_name: typeName,
          pub_sub_message_id: messageId,
        },
      });
    }
  }

  console.log(`${LOG} ${eventLabel} account ${account.id}: wrote ${Object.keys(fields).join(",")}`);
  await recordProcessed();
  return ok("written");
}
