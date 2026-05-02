import type { RequestHandler } from "express";

/**
 * CSRF defense — hybrid Origin allowlist (web) + custom header (mobile).
 *
 * Mounted in setupAuth() (server/replit_integrations/auth/replitAuth.ts)
 * directly after passport.session(). Runs before every route registered
 * by registerRoutes(). NOTE: /api/stripe/webhook is mounted directly in
 * server/index.ts BEFORE setupAuth() is called, so it never reaches this
 * middleware in practice — the path bypass below is defense-in-depth in
 * case the mount order ever changes. The webhook is verified by Stripe
 * signature, not by Origin.
 *
 * Strategy:
 *   - Web requests: validate the Origin (or Referer fallback) against an
 *     allowlist. Browsers set Origin reliably on cross-origin POST and JS
 *     cannot forge it.
 *   - Mobile requests: presence of `X-FieldView-Client: mobile-1` is
 *     sufficient. Browsers cannot send arbitrary X- headers cross-origin
 *     without CORS approval (which the server does NOT grant — there is
 *     no cors() middleware), so an attacker page in a victim browser
 *     cannot forge this header.
 *
 * IMPORTANT: if cors() middleware is ever added to this app, it MUST NOT
 * include `X-FieldView-Client` in `Access-Control-Allow-Headers`, or the
 * mobile defense becomes browser-forgeable and CSRF protection collapses
 * to Origin-only.
 *
 * Modes (CSRF_MODE env var):
 *   - "off"   → middleware skipped entirely (incident killswitch).
 *               In production (NODE_ENV=production OR VERCEL set), "off"
 *               is REFUSED unless CSRF_OFF_ACK=1 is also set, to prevent
 *               accidental disablement. When refused, falls back to
 *               enforce mode and emits a loud startup warning.
 *   - "warn"  → log [csrf] would-block on failure but allow request through.
 *   - unset / "enforce" (default) → return 403 on failure.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Bypass list: requests to these paths skip the CSRF check entirely.
//   - Stripe webhook is verified by signature, not by Origin.
//   - Unauth endpoints have no session at request time, so there's no
//     CSRF attack surface (nothing to forge).
//   - Logout is bypassed to avoid chicken-and-egg if the session is broken.
const PATH_BYPASS = [
  "/api/stripe/webhook",
  "/api/login",
  "/api/register",
  "/api/forgot-password",
  "/api/reset-password",
  "/api/resend-verification",
  "/api/logout",
];

// Exact-match allowlist (host === entry, port stripped).
const ALLOWED_HOSTS_EXACT = new Set<string>([
  "app.field-view.com",
  "localhost",
  "127.0.0.1",
]);

// Suffix allowlist (host === suffix OR host.endsWith("." + suffix)).
//   - vercel.app: covers field-view.vercel.app + preview deploys
//   - replit.dev: covers Replit dev random subdomains
const ALLOWED_HOST_SUFFIXES = ["vercel.app", "replit.dev"];

const MOBILE_HEADER = "x-fieldview-client";
const MOBILE_HEADER_VALUE = "mobile-1";

function isPathBypassed(path: string): boolean {
  return PATH_BYPASS.some((p) => path === p || path.startsWith(p + "/"));
}

function hostInAllowlist(host: string): boolean {
  // Strip port for matching ("localhost:5000" → "localhost").
  const bareHost = host.split(":")[0].toLowerCase();
  if (ALLOWED_HOSTS_EXACT.has(bareHost)) return true;
  return ALLOWED_HOST_SUFFIXES.some(
    (s) => bareHost === s || bareHost.endsWith("." + s),
  );
}

function originFromRequest(req: { headers: any }): string | null {
  if (req.headers.origin) return String(req.headers.origin);
  if (req.headers.referer) {
    try {
      return new URL(String(req.headers.referer)).origin;
    } catch {
      return null;
    }
  }
  return null;
}

// Reduce a Referer to its origin for logging — strips path/query/fragment so
// password-reset tokens, session ids, etc. don't end up in stdout/Sentry.
function safeRefererForLog(referer: unknown): string {
  if (!referer) return "(none)";
  try {
    return new URL(String(referer)).origin;
  } catch {
    return "(unparseable)";
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL;
}

/** Resolve the effective mode, applying the prod "off" guardrail. */
function resolveMode(): "off" | "warn" | "enforce" {
  const raw = (process.env.CSRF_MODE || "enforce").toLowerCase();
  if (raw === "off") {
    if (isProduction() && process.env.CSRF_OFF_ACK !== "1") {
      // Refuse silent kill-switch in prod — fall back to enforce.
      return "enforce";
    }
    return "off";
  }
  if (raw === "warn") return "warn";
  return "enforce";
}

export const csrfGuard: RequestHandler = (req, res, next) => {
  const mode = resolveMode();
  if (mode === "off") return next();

  if (SAFE_METHODS.has(req.method)) return next();
  if (isPathBypassed(req.path)) return next();

  // Mobile branch — presence of the custom header is sufficient.
  if (req.headers[MOBILE_HEADER] === MOBILE_HEADER_VALUE) return next();

  // Web branch — validate Origin (preferred) or Referer (fallback).
  const origin = originFromRequest(req);
  if (origin) {
    try {
      const host = new URL(origin).host;
      if (hostInAllowlist(host)) return next();
    } catch {
      // fall through to reject
    }
  }

  const reason = !origin ? "missing_origin" : "bad_origin";
  if (mode === "warn") {
    console.warn("[csrf] would-block", {
      reason,
      method: req.method,
      path: req.path,
      origin: req.headers.origin || "(none)",
      referer: safeRefererForLog(req.headers.referer),
      mobileHeader: req.headers[MOBILE_HEADER] || "(none)",
    });
    return next();
  }

  return res
    .status(403)
    .json({ error: "csrf", message: "CSRF check failed" });
};

/**
 * One-shot startup helper — call from server bootstrap to log the active
 * mode and any guardrail downgrades. Returns the resolved mode string.
 */
export function logCsrfStartupMode(): string {
  const requested = (process.env.CSRF_MODE || "enforce").toLowerCase();
  const effective = resolveMode();
  if (requested === "off" && effective !== "off") {
    console.warn(
      "[csrf] WARNING: CSRF_MODE=off requested in production without CSRF_OFF_ACK=1 — falling back to enforce. Set CSRF_OFF_ACK=1 to acknowledge.",
    );
  }
  console.log(`[csrf] mode=${effective}${requested !== effective ? ` (requested=${requested})` : ""}`);
  return effective;
}
