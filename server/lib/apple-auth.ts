/**
 * Sign in with Apple — web helpers.
 *
 * Uses Node 20's built-in crypto exclusively (no jsonwebtoken/jose):
 *   - generateAppleClientSecret(): ES256 JWT client secret, generated at
 *     request time (Apple caps secret lifetime at 6 months; caching one in a
 *     module variable or env var causes a silent outage when it expires).
 *   - verifyAppleIdToken(): verifies an id_token against Apple's JWKS
 *     (fetched from appleid.apple.com and cached in memory with a TTL).
 *   - signAppleState()/verifyAppleState(): HMAC-signed OAuth state carrier.
 *     Apple's callback is a cross-site form POST; with SameSite=Lax the
 *     session cookie is NOT sent, so the CSRF nonce and the invite token
 *     must ride in the state parameter itself, tamper-proofed with an HMAC
 *     keyed by SESSION_SECRET.
 */
import crypto from "crypto";

const APPLE_ISSUER = "https://appleid.apple.com";
const JWKS_URL = "https://appleid.apple.com/auth/keys";
const JWKS_TTL_MS = 10 * 60 * 1000; // 10 minutes

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

/** True when all four Apple env vars are present (used by /api/auth/providers). */
export function isAppleConfigured(): boolean {
  return !!(
    process.env.APPLE_SERVICES_ID &&
    process.env.APPLE_TEAM_ID &&
    process.env.APPLE_KEY_ID &&
    process.env.APPLE_PRIVATE_KEY
  );
}

/**
 * ES256-signed client secret JWT. MUST be called at request time — never
 * cache the result (see file header).
 */
export function generateAppleClientSecret(): string {
  const teamId = process.env.APPLE_TEAM_ID;
  const keyId = process.env.APPLE_KEY_ID;
  const servicesId = process.env.APPLE_SERVICES_ID;
  const privateKeyB64 = process.env.APPLE_PRIVATE_KEY;
  if (!teamId || !keyId || !servicesId || !privateKeyB64) {
    throw new Error("Apple OAuth env vars missing (APPLE_TEAM_ID/APPLE_KEY_ID/APPLE_SERVICES_ID/APPLE_PRIVATE_KEY)");
  }
  const pem = Buffer.from(privateKeyB64, "base64").toString("utf8");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId };
  const payload = {
    iss: teamId,
    iat: now,
    exp: now + 60 * 60, // 1 hour
    aud: APPLE_ISSUER,
    sub: servicesId,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  // ieee-p1363 = raw r||s signature format required by JOSE (not DER).
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: crypto.createPrivateKey(pem),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(signature)}`;
}

// ---------------------------------------------------------------------------
// JWKS fetch + id_token verification
// ---------------------------------------------------------------------------

type AppleJwk = { kty: string; kid: string; use: string; alg: string; n?: string; e?: string; crv?: string; x?: string; y?: string };

let jwksCache: { keys: AppleJwk[]; fetchedAt: number } | null = null;

async function getAppleJwks(forceRefresh = false): Promise<AppleJwk[]> {
  if (!forceRefresh && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Apple JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: AppleJwk[] };
  if (!Array.isArray(body?.keys) || body.keys.length === 0) {
    throw new Error("Apple JWKS response contained no keys");
  }
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

export type AppleIdTokenPayload = {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
  email?: string;
  email_verified?: boolean | "true" | "false";
  is_private_email?: boolean | "true" | "false";
  [k: string]: unknown;
};

/**
 * Verify an Apple id_token: signature (via Apple's JWKS), iss, aud (must be
 * one of allowedAudiences — mobile will later pass the app bundle id), exp.
 * Returns the decoded payload.
 */
export async function verifyAppleIdToken(
  idToken: string,
  allowedAudiences: string[],
): Promise<AppleIdTokenPayload> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: AppleIdTokenPayload;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed id_token JSON");
  }
  if (!header.kid) throw new Error("id_token missing kid");

  // Find the signing key; on unknown kid, force one JWKS refresh (rotation).
  let jwk = (await getAppleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) {
    jwk = (await getAppleJwks(true)).find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("id_token signed with unknown key");

  const publicKey = crypto.createPublicKey({ key: jwk as any, format: "jwk" });
  // Apple signs id_tokens with RS256 (per its JWKS alg); verify accordingly,
  // but fall back to the header alg family if Apple ever rotates to ES256.
  const isEc = jwk.kty === "EC";
  const valid = crypto.verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    isEc ? { key: publicKey, dsaEncoding: "ieee-p1363" } : publicKey,
    Buffer.from(sigB64, "base64url"),
  );
  if (!valid) throw new Error("id_token signature verification failed");

  if (payload.iss !== APPLE_ISSUER) throw new Error(`id_token iss mismatch: ${payload.iss}`);
  if (!allowedAudiences.includes(payload.aud)) throw new Error(`id_token aud mismatch: ${payload.aud}`);
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("id_token expired");

  return payload;
}

// ---------------------------------------------------------------------------
// HMAC-signed state parameter (CSRF nonce + invite-token carrier)
// ---------------------------------------------------------------------------

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function stateHmac(data: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * base64url(JSON{nonce, invite, ts}) + "." + HMAC-SHA256(SESSION_SECRET).
 *
 * The caller generates the nonce, embeds it here AND sets it in a
 * SameSite=None cookie. On the callback, both copies must match — the HMAC
 * alone proves integrity but NOT browser binding: /api/auth/apple is public,
 * so an attacker could mint a valid state for their own Apple account and
 * cross-site POST it to log a victim into the attacker's account (login
 * CSRF). The cookie ties the state to the browser that started the flow.
 */
export function signAppleState(inviteToken: string | null, nonce: string): string {
  const body = b64urlJson({
    nonce,
    invite: inviteToken || null,
    ts: Date.now(),
  });
  return `${body}.${stateHmac(body)}`;
}

/** Random nonce for the state + browser-binding cookie pair. */
export function generateAppleNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}

/**
 * Verify the state HMAC (constant-time) and freshness; returns the embedded
 * invite token and nonce. Throws on any tampering or expiry.
 */
export function verifyAppleState(state: unknown): { inviteToken: string | null; nonce: string } {
  if (typeof state !== "string" || !state.includes(".")) throw new Error("Missing or malformed state");
  const dot = state.lastIndexOf(".");
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const expected = stateHmac(body);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) {
    throw new Error("State signature mismatch");
  }
  let parsed: { nonce?: string; invite?: string | null; ts?: number };
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("State payload unparseable");
  }
  if (typeof parsed.ts !== "number" || Date.now() - parsed.ts > STATE_MAX_AGE_MS) {
    throw new Error("State expired");
  }
  if (typeof parsed.nonce !== "string" || !parsed.nonce) {
    throw new Error("State missing nonce");
  }
  return { inviteToken: parsed.invite || null, nonce: parsed.nonce };
}

/** Constant-time nonce comparison (cookie copy vs state copy). */
export function nonceMatches(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
