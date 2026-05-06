// Standalone Vercel serverless function for Stripe webhooks.
// Bypasses the Express app entirely so Vercel's @vercel/node body-parsing
// can't corrupt the raw bytes Stripe signed. Built by script/build.ts to
// api/stripe/webhook.js (filesystem routing on Vercel matches that path
// before the catch-all rewrite to /api/index).
//
// Diagnostic from prod (deployment dpl_Hq2X9Fyi97YE…, 2026-05-06 21:58:45):
//   [stripe-webhook] received {hasRawBody:false, bodyIsBuf:true, bodyLen:10237}
// → Vercel populates req.body with a JSON-roundtripped Buffer (bytes !=
//   original signed payload) and does NOT populate req.rawBody. Manually
//   consuming the request stream here gives us the byte-perfect payload.

import { handleSubscriptionEvent } from "../server/lib/stripeWebhook";
import { getUncachableStripeClient } from "../server/stripeClient";
import { WebhookHandlers } from "../server/webhookHandlers";
import { initSentry, Sentry } from "../server/lib/sentry";

initSentry();

// Best-effort: tells @vercel/node v2 (Next.js convention) to skip body parsing.
// @vercel/node v3+ ignores this — we manually consume the stream regardless.
export const config = { api: { bodyParser: false } };

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end("Method Not Allowed");
  }

  const sigHeader = req.headers["stripe-signature"];
  if (!sigHeader) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Missing stripe-signature" }));
  }
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

  // Manually consume the request stream. Works regardless of whether
  // @vercel/node has populated req.body or not — if it did, the stream
  // is exhausted and we get an empty buffer (which we detect below).
  let rawBody: Buffer;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    rawBody = Buffer.concat(chunks);
  } catch (e: any) {
    console.error("[stripe-webhook-fn] stream read error:", e?.message);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Stream read error" }));
  }

  // Fallback: if Vercel pre-consumed the stream, recover from req.rawBody
  // (some runtime versions populate it) or req.body if it's a Buffer.
  if (rawBody.length === 0) {
    if (Buffer.isBuffer((req as any).rawBody)) {
      rawBody = (req as any).rawBody as Buffer;
    } else if (Buffer.isBuffer(req.body)) {
      rawBody = req.body as Buffer;
    }
  }

  console.log("[stripe-webhook-fn] received", {
    streamRawBodyLen: rawBody.length,
    hasReqRawBody: Buffer.isBuffer((req as any).rawBody),
    bodyIsBuf: Buffer.isBuffer(req.body),
    bodyLen: Buffer.isBuffer(req.body) ? req.body.length : null,
    sigPresent: !!sig,
    contentType: req.headers["content-type"],
  });

  if (rawBody.length === 0) {
    console.error("[stripe-webhook-fn] empty payload — no usable raw bytes");
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Empty webhook payload" }));
  }

  // Vendor lib (stripe-replit-sync) — non-fatal if it errors; our own
  // verification below is what actually gates Stripe acceptance.
  try {
    await WebhookHandlers.processWebhook(rawBody, sig);
  } catch (e: any) {
    console.error("[stripe-webhook-fn] vendor processWebhook failed:", e?.message);
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event: any;
  if (webhookSecret) {
    try {
      const stripe = await getUncachableStripeClient();
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (verifyErr: any) {
      console.error(
        "[stripe-webhook-fn] signature verification failed:",
        verifyErr?.message,
      );
      Sentry.captureMessage("Webhook signature verification failed (standalone fn)", {
        level: "error",
        tags: { source: "stripe_webhook_fn" },
        extra: { error: verifyErr?.message },
      });
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Webhook signature verification failed" }));
    }
  } else {
    console.warn(
      "[stripe-webhook-fn] STRIPE_WEBHOOK_SECRET not set — parsing without local verification",
    );
    try {
      event = JSON.parse(rawBody.toString());
    } catch (e: any) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Invalid webhook body" }));
    }
  }

  try {
    await handleSubscriptionEvent(event);
  } catch (e: any) {
    // handleSubscriptionEvent has its own try/catch, but defense in depth.
    console.error("[stripe-webhook-fn] handleSubscriptionEvent threw:", e?.message);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ received: true }));
}
