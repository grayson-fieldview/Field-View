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
import { seatCountFromProductId } from "./appleIap";

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

export async function verifyGooglePlayPurchase(
  purchaseToken: string,
  productId: string,
): Promise<GooglePlayVerifyResult> {
  const client = getJwtClient();
  const packageName = getPackageName();
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
  const client = getJwtClient();
  const packageName = getPackageName();
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
