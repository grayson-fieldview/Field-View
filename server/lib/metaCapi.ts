// server/lib/metaCapi.ts
// Meta Conversions API (CAPI) server-side event relay.
// Modeled on server/lib/ghl.ts: fire-and-forget, never blocks or fails the
// request path. If META_PIXEL_ID or META_CAPI_ACCESS_TOKEN is unset (e.g.
// local dev), the call is a silent no-op.
//
// Unlike ghl.ts, env vars are read at CALL time (not module load), and the
// dangling fetch is registered with Vercel's waitUntil() when available so
// the serverless instance isn't frozen before the event is delivered. In
// local dev (outside a Vercel request context) waitUntil may throw — we fall
// back to the plain dangling-fetch-with-swallowed-rejection pattern.

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";

const GRAPH_VERSION = "v21.0";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Normalize a raw phone string to E.164-style digits (country code included,
// no "+"), per Meta's hashing spec. Assumes US (+1) when 10 digits.
// Returns null when the input can't be normalized to something plausible.
export function normalizePhoneE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

export interface MetaCapiEventParams {
  eventName: string; // "Lead" | "StartTrial" | "Subscribe" | custom (e.g. "Activated")
  eventId: string; // dedup key shared with the browser pixel when available
  email: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  eventSourceUrl?: string | null;
  value?: number | null;
  currency?: string | null;
  customData?: Record<string, unknown> | null;
}

export function sendMetaCapiEvent(params: MetaCapiEventParams): void {
  try {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_CAPI_ACCESS_TOKEN;
    if (!pixelId || !token) return; // silent no-op, mirrors ghl.ts

    const userData: Record<string, unknown> = {
      em: [sha256(params.email.trim().toLowerCase())],
    };
    if (params.phone) {
      const normalized = normalizePhoneE164(params.phone);
      if (normalized) userData.ph = [sha256(normalized)];
    }
    if (params.firstName?.trim()) userData.fn = [sha256(params.firstName.trim().toLowerCase())];
    if (params.lastName?.trim()) userData.ln = [sha256(params.lastName.trim().toLowerCase())];
    // Sent UNHASHED per Meta spec:
    if (params.clientIp) userData.client_ip_address = params.clientIp;
    if (params.userAgent) userData.client_user_agent = params.userAgent;
    if (params.fbp) userData.fbp = params.fbp;
    if (params.fbc) userData.fbc = params.fbc;

    const customData: Record<string, unknown> = { ...(params.customData ?? {}) };
    if (params.value != null) customData.value = params.value;
    if (params.currency) customData.currency = params.currency;

    const event: Record<string, unknown> = {
      event_name: params.eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: params.eventId,
      action_source: "website",
      user_data: userData,
    };
    if (params.eventSourceUrl) event.event_source_url = params.eventSourceUrl;
    if (Object.keys(customData).length > 0) event.custom_data = customData;

    const body: Record<string, unknown> = { data: [event] };
    if (process.env.META_TEST_EVENT_CODE) {
      body.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`;
    const promise = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "<unreadable body>");
          console.error(`[meta-capi] ${params.eventName} failed: HTTP ${res.status} — ${text}`);
        }
      })
      .catch(() => {
        // Intentionally swallowed — a Meta outage must never break signup,
        // profile completion, uploads, or Stripe webhook processing.
      });

    // On Vercel, keep the instance alive until delivery. Outside a Vercel
    // request context this can throw — fall back to the dangling fetch.
    try {
      waitUntil(promise);
    } catch {
      // Local dev / non-Vercel: dangling fetch with swallowed rejection.
    }
  } catch (err: any) {
    // Never throw to the caller under any circumstances.
    console.error("[meta-capi] send failed (non-fatal):", err?.message || err);
  }
}
