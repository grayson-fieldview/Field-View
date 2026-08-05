/**
 * Apple App Store Server Notifications V2 — signature verification ONLY.
 *
 * ASSN V2 payloads arrive as JSON { "signedPayload": "<JWS>" }. Unlike Sign
 * in with Apple (server/lib/apple-auth.ts, which verifies id_tokens against
 * Apple's OIDC JWKS endpoint), ASSN V2 embeds an x5c certificate chain in
 * the JWS protected header. Verification here:
 *
 *   1. Parse the JWS header, require alg ES256 + an x5c chain.
 *   2. Validate the chain leaf -> intermediate(s) -> Apple Root CA - G3:
 *      each cert must be issued AND cryptographically signed by the next,
 *      the terminal cert must chain to the PINNED root below (never fetched
 *      at runtime), and every cert (including the root) must be within its
 *      notBefore/notAfter validity window.
 *   3. Verify the ES256 signature over the JWS signing input with the leaf
 *      certificate's public key (dsaEncoding "ieee-p1363" — raw r||s, the
 *      same requirement apple-auth.ts handles for its ES256 work; Node's
 *      default is ASN.1/DER and silently fails against JOSE signatures).
 *   4. Only after signature verification is any payload data returned.
 *
 * The same chain verification applies to the nested JWS values inside a
 * notification (signedTransactionInfo / signedRenewalInfo) — Apple signs
 * those with the same App Store server certificates.
 *
 * Deliberate non-goals (enforced): no route, no DB access, no imports from
 * stripeWebhook/billing/db, no npm dependencies (Node crypto only), and no
 * logging of payload contents or certificate material.
 */
import crypto, { X509Certificate } from "crypto";

// ---------------------------------------------------------------------------
// Pinned trust anchor: Apple Root CA - G3.
// Source: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// (DER converted to PEM). SHA-256 fingerprint verified against Apple's
// published value at pin time:
//   63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
// Valid 2014-04-30 -> 2039-04-30. Pinned in code, never fetched at runtime.
// ---------------------------------------------------------------------------
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----`;

let cachedRoot: X509Certificate | null = null;
function appleRootCa(): X509Certificate {
  if (!cachedRoot) cachedRoot = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
  return cachedRoot;
}

export class AppleIapVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleIapVerificationError";
  }
}

function fail(reason: string): never {
  // Reason strings only — never payload contents or certificate material.
  throw new AppleIapVerificationError(reason);
}

function parseCertDate(s: string, label: string): Date {
  const d = new Date(s);
  if (isNaN(d.getTime())) fail(`unparseable certificate ${label} date`);
  return d;
}

function assertWithinValidity(cert: X509Certificate, label: string): void {
  const now = Date.now();
  const notBefore = parseCertDate(cert.validFrom, "notBefore").getTime();
  const notAfter = parseCertDate(cert.validTo, "notAfter").getTime();
  if (now < notBefore) fail(`${label} certificate not yet valid`);
  if (now > notAfter) fail(`${label} certificate expired`);
}

/**
 * Validate the x5c chain (leaf first) up to the pinned Apple Root CA - G3
 * and return the LEAF certificate for signature verification. Throws
 * AppleIapVerificationError on any defect.
 */
function validateChain(x5c: unknown): X509Certificate {
  if (!Array.isArray(x5c) || x5c.length < 2 || x5c.length > 5) {
    fail("x5c chain missing or has implausible length");
  }
  let certs: X509Certificate[];
  try {
    certs = x5c.map((der) => {
      if (typeof der !== "string" || der.length === 0) throw new Error("bad x5c entry");
      return new X509Certificate(Buffer.from(der, "base64"));
    });
  } catch {
    fail("x5c contains an unparseable certificate");
  }

  const root = appleRootCa();

  // Every provided cert must be inside its validity window (the pinned root
  // is checked too, below).
  certs!.forEach((c, i) => assertWithinValidity(c, i === 0 ? "leaf" : `chain[${i}]`));
  assertWithinValidity(root, "pinned root");

  // If Apple included the root itself as the last element, it must be
  // byte-identical to the pinned root; drop it and chain to the pin.
  let chain = certs!;
  const last = chain[chain.length - 1];
  if (last.raw.equals(root.raw)) {
    chain = chain.slice(0, -1);
    if (chain.length === 0) fail("x5c chain contains only the root");
  }

  // Link i -> i+1: issued-by (name linkage) AND signature actually verifies
  // with the issuer's public key. checkIssued alone only compares names.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i].checkIssued(chain[i + 1])) fail(`chain[${i}] not issued by chain[${i + 1}]`);
    if (!chain[i].verify(chain[i + 1].publicKey)) fail(`chain[${i}] signature invalid`);
  }

  // Terminal cert must chain to the PINNED root — the trust anchor is the
  // pin, never anything the sender supplied.
  const terminal = chain[chain.length - 1];
  if (!terminal.checkIssued(root)) fail("chain does not terminate at Apple Root CA - G3");
  if (!terminal.verify(root.publicKey)) fail("terminal chain signature not made by pinned root");

  return chain[0];
}

function b64urlToBuffer(s: string, label: string): Buffer {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) fail(`malformed JWS ${label}`);
  return Buffer.from(s, "base64url");
}

/**
 * Verify an Apple-signed JWS (ES256 + embedded x5c chain rooted at the
 * pinned Apple Root CA - G3) and return its decoded payload object.
 *
 * This is the ONLY decode path in this module — payload data is never
 * returned without the chain and signature having verified first. Used for
 * the outer signedPayload and equally for the nested signedTransactionInfo /
 * signedRenewalInfo values.
 *
 * Throws AppleIapVerificationError on any failure.
 */
export function verifyAppleSignedJws(jws: string): Record<string, any> {
  if (typeof jws !== "string") fail("signedPayload is not a string");
  const parts = jws.split(".");
  if (parts.length !== 3) fail("malformed JWS: expected three segments");
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: any;
  try {
    header = JSON.parse(b64urlToBuffer(headerB64, "header").toString("utf8"));
  } catch (e) {
    if (e instanceof AppleIapVerificationError) throw e;
    fail("malformed JWS: header is not valid JSON");
  }
  if (header.alg !== "ES256") fail("unexpected JWS alg (expected ES256)");

  const leaf = validateChain(header.x5c);

  const signature = b64urlToBuffer(signatureB64, "signature");
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const ok = crypto.verify(
    "sha256",
    signingInput,
    // ieee-p1363: JOSE ES256 signatures are raw r||s (64 bytes), not the
    // ASN.1/DER encoding Node defaults to. Same pattern as apple-auth.ts.
    { key: leaf.publicKey, dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!ok) fail("JWS signature verification failed");

  // Signature verified — only now is the payload decoded and returned.
  try {
    return JSON.parse(b64urlToBuffer(payloadB64, "payload").toString("utf8"));
  } catch (e) {
    if (e instanceof AppleIapVerificationError) throw e;
    fail("verified JWS payload is not valid JSON");
  }
}

export type AppleEnvironment = "Sandbox" | "Production";

export interface VerifiedAppleNotification {
  /** Full decoded responseBodyV2DecodedPayload (notificationType, subtype, data/summary, notificationUUID, ...). */
  payload: Record<string, any>;
  /** "Sandbox" | "Production" — returned to the caller, neither is rejected here. */
  environment: AppleEnvironment;
  /** Convenience passthroughs of the still-signed nested JWS strings (verify via the helpers below). */
  signedTransactionInfo?: string;
  signedRenewalInfo?: string;
}

/**
 * Verify an ASSN V2 outer signedPayload and validate its claims:
 *   - bundleId (data.bundleId or summary.bundleId) must equal APPLE_IAP_BUNDLE_ID
 *   - environment must be "Sandbox" or "Production" (returned, not filtered)
 * Throws AppleIapVerificationError on any verification/validation failure.
 */
export function verifyAppleNotification(signedPayload: string): VerifiedAppleNotification {
  const payload = verifyAppleSignedJws(signedPayload);

  const expectedBundleId = process.env.APPLE_IAP_BUNDLE_ID;
  if (!expectedBundleId) fail("APPLE_IAP_BUNDLE_ID is not configured");

  // data (most notification types) or summary (RENEWAL_EXTENSION summaries).
  const container = payload.data ?? payload.summary;
  if (!container || typeof container !== "object") {
    fail("notification payload has neither data nor summary");
  }
  if (container.bundleId !== expectedBundleId) fail("bundleId mismatch");

  const environment = container.environment;
  if (environment !== "Sandbox" && environment !== "Production") {
    fail("unrecognized environment in notification payload");
  }

  return {
    payload,
    environment,
    signedTransactionInfo:
      typeof container.signedTransactionInfo === "string" ? container.signedTransactionInfo : undefined,
    signedRenewalInfo:
      typeof container.signedRenewalInfo === "string" ? container.signedRenewalInfo : undefined,
  };
}

/**
 * Verify + decode a nested signedTransactionInfo JWS (JWSTransactionDecodedPayload).
 * Same pinned-chain + ES256 verification as the outer payload.
 */
export function verifyAppleTransactionInfo(signedTransactionInfo: string): Record<string, any> {
  return verifyAppleSignedJws(signedTransactionInfo);
}

/**
 * Verify + decode a nested signedRenewalInfo JWS (JWSRenewalInfoDecodedPayload).
 * Same pinned-chain + ES256 verification as the outer payload.
 */
export function verifyAppleRenewalInfo(signedRenewalInfo: string): Record<string, any> {
  return verifyAppleSignedJws(signedRenewalInfo);
}
