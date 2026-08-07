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
import { seatCountFromProductId } from "./appleIap";
import { hasUsableSubscription } from "./billing";
import { writeAccountBillingById } from "./stripeWebhook";
import { Sentry } from "./sentry";

// Re-export so future Google-path callers import the single parser from
// here without a second appleIap dependency (do NOT duplicate the parser).
export { seatCountFromProductId };

const LOG = "[google-play]";
const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";

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

export async function verifyGooglePlayPurchase(
  purchaseToken: string,
  productId: string,
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

  // ENTITLEMENT CHECK: the token verified, but never trust the CLIENT's
  // claimed productId — the seat count must derive from what Google says
  // this subscription actually contains. Reject if no line item matches.
  const lineItems: any[] = Array.isArray(body.lineItems) ? body.lineItems : [];
  const matched = lineItems.find((li) => li?.productId === productId);
  if (!matched) {
    const found = lineItems.map((li) => li?.productId).filter(Boolean).join(",") || "(none)";
    console.warn(`${LOG} verify: product mismatch — client claimed ${productId}, subscription contains [${found}]`);
    return {
      ok: false,
      error: "product_mismatch",
      status: 200,
      detail: `Subscription line items do not include ${productId}`,
    };
  }

  // SubscriptionPurchaseV2: the MATCHED line item carries productId + expiryTime.
  const lineItem = matched;
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
