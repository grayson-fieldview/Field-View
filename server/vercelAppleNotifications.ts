// Standalone Vercel serverless function for Apple App Store Server
// Notifications V2. Modeled on server/vercelStripeWebhook.ts: bypasses the
// Express app so @vercel/node body handling can't interfere. Built by
// script/build.ts to api/apple/notifications.js (filesystem routing on
// Vercel matches that path before the catch-all rewrite to /api/index).
//
// Unlike Stripe, Apple's signature is INSIDE the JSON ({"signedPayload":
// "<JWS>"}) rather than over the raw bytes, so byte-perfect raw body is not
// signature-critical — but we consume the stream manually anyway for
// consistency and to avoid any parser surprises.

import { processAppleNotification } from "../server/lib/appleIap";
import { initSentry, Sentry } from "../server/lib/sentry";

initSentry();

export const config = { api: { bodyParser: false } };

export default async function handler(req: any, res: any) {
  const send = (status: number, body: Record<string, any>) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end("Method Not Allowed");
  }

  let rawBody: Buffer;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    rawBody = Buffer.concat(chunks);
  } catch (e: any) {
    console.error("[apple-iap-fn] stream read error:", e?.message);
    return send(500, { error: "Stream read error" });
  }
  if (rawBody.length === 0) {
    if (Buffer.isBuffer((req as any).rawBody)) rawBody = (req as any).rawBody as Buffer;
    else if (Buffer.isBuffer(req.body)) rawBody = req.body as Buffer;
  }

  // Malformed body → 400: Apple should not retry an unparseable request.
  let signedPayload: string;
  try {
    const parsed = JSON.parse(rawBody.toString("utf8"));
    signedPayload = parsed?.signedPayload;
  } catch {
    return send(400, { error: "Invalid JSON body" });
  }
  if (typeof signedPayload !== "string" || signedPayload.length === 0) {
    return send(400, { error: "Missing signedPayload" });
  }

  try {
    // processAppleNotification returns 200 for success and every
    // handled-but-unwritable case, 401 for verification failures. Anything
    // it THROWS is an unexpected internal error → 500 so Apple retries.
    const result = await processAppleNotification(signedPayload);
    return send(result.status, result.body);
  } catch (e: any) {
    console.error("[apple-iap-fn] unexpected error:", e?.message);
    Sentry.captureException(e, { tags: { source: "apple_iap_fn" } });
    return send(500, { error: "Internal error" });
  }
}
