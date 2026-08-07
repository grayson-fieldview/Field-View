// Standalone Vercel serverless function for Google Play Real-Time Developer
// Notifications (RTDN), delivered as Pub/Sub push. Modeled on
// server/vercelAppleNotifications.ts: bypasses the Express app so
// @vercel/node body handling can't interfere. Built by script/build.ts to
// api/google/notifications.js (filesystem routing on Vercel matches that
// path before the catch-all rewrite to /api/index).
//
// SECURITY: this endpoint is public. Pub/Sub push authenticates via an OIDC
// JWT in the Authorization bearer header — it is VERIFIED (Google issuer +
// audience match against GOOGLE_PLAY_PUBSUB_AUDIENCE) before ANY of the body
// is trusted. Never skip this: without it anyone could forge RTDN payloads.
// (The purchaseToken is additionally re-verified against the Publisher API
// inside processGooglePlayNotification — defense in depth.)

import { OAuth2Client } from "google-auth-library";
import { processGooglePlayNotification } from "../server/lib/googlePlay";
import { initSentry, Sentry } from "../server/lib/sentry";

initSentry();

export const config = { api: { bodyParser: false } };

const oidcClient = new OAuth2Client();
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

async function verifyPubSubJwt(authorization: unknown): Promise<{ ok: true } | { ok: false; reason: string }> {
  const audience = process.env.GOOGLE_PLAY_PUBSUB_AUDIENCE;
  if (!audience) {
    // Fail CLOSED: without a configured audience the token can't be
    // meaningfully validated — never fall open on a public endpoint.
    return { ok: false, reason: "GOOGLE_PLAY_PUBSUB_AUDIENCE not configured" };
  }
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return { ok: false, reason: "missing bearer token" };
  }
  const idToken = authorization.slice("Bearer ".length).trim();
  try {
    const ticket = await oidcClient.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload || !GOOGLE_ISSUERS.has(payload.iss)) {
      return { ok: false, reason: `unexpected issuer ${payload?.iss}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || "token verification failed" };
  }
}

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

  // Authenticate BEFORE reading/trusting the body.
  const auth = await verifyPubSubJwt(req.headers?.authorization);
  if (!auth.ok) {
    console.warn(`[google-play-fn] rejected push: ${auth.reason}`);
    return send(401, { error: "Unauthorized" });
  }

  let rawBody: Buffer;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    rawBody = Buffer.concat(chunks);
  } catch (e: any) {
    console.error("[google-play-fn] stream read error:", e?.message);
    return send(500, { error: "Stream read error" });
  }
  if (rawBody.length === 0) {
    if (Buffer.isBuffer((req as any).rawBody)) rawBody = (req as any).rawBody as Buffer;
    else if (Buffer.isBuffer(req.body)) rawBody = req.body as Buffer;
  }

  // Pub/Sub push envelope: { message: { data: <base64>, messageId,
  // publishTime }, subscription }. Malformed → 400: Pub/Sub should not
  // retry an unparseable request.
  let messageId: string | null;
  let developerNotification: Record<string, any>;
  try {
    const envelope = JSON.parse(rawBody.toString("utf8"));
    const message = envelope?.message;
    const data = message?.data;
    if (typeof data !== "string" || data.length === 0) {
      return send(400, { error: "Missing message.data" });
    }
    messageId = typeof message?.messageId === "string" && message.messageId ? message.messageId : null;
    developerNotification = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    if (!developerNotification || typeof developerNotification !== "object") {
      return send(400, { error: "message.data is not a JSON object" });
    }
  } catch {
    return send(400, { error: "Invalid Pub/Sub push body" });
  }

  try {
    // processGooglePlayNotification returns 200 for success and every
    // handled-but-unwritable case. Anything it THROWS (including
    // verification auth_failed) is an internal error → 500 so Pub/Sub
    // retries.
    const result = await processGooglePlayNotification(developerNotification, messageId);
    return send(result.status, result.body);
  } catch (e: any) {
    console.error("[google-play-fn] unexpected error:", e?.message);
    Sentry.captureException(e, { tags: { source: "google_play_fn" } });
    return send(500, { error: "Internal error" });
  }
}
