// S46 — Marketing attribution capture middleware.
//
// Mounted INSIDE setupAuth() between app.use(getSession()) and
// app.use(passport.initialize()) so req.session is available BUT auth/CSRF
// hasn't run yet — first-touch UTMs from a logged-out landing-page hit are
// captured even on requests that ultimately get 401'd or CSRF-blocked.
//
// On every request:
//   1. Extract fbclid + utm_source/medium/campaign/content/term from req.query.
//   2. Extract req.headers.referer once as `referrer`.
//   3. Merge into req.session.attribution with FIRST-TOUCH-WINS semantics
//      (an existing populated field is never overwritten by a later visit).
//   4. If req.query.fbclid is present, write/refresh the _fbc cookie per
//      Meta's spec: fb.1.<unix_ms>.<fbclid>. Always overwritten on a new
//      fbclid (Meta wants the latest click for the cookie even though the
//      session column keeps the first-touch click for our DB).
//
// The eventual signup write in POST /api/register reads
// req.session.attribution + req.cookies._fbp + req.cookies._fbc and persists
// them onto the new users row.
//
// Hard guarantees:
//   • Never throws to Express. The entire body is in try/catch — a malformed
//     query string or an unexpected session shape must not break unrelated
//     traffic.
//   • Always calls next() exactly once.
//   • No-op if req.session is undefined (mobile API hits without a cookie,
//     webhook callbacks, jest tests).
//   • Every captured value is length-capped to 500 chars defensively — a 10MB
//     UTM string from a hostile crawler must not balloon the sessions row.

import type { Request, Response, NextFunction } from "express";

const MAX_LEN = 500;
const FBC_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90d, Meta's recommended TTL
const IS_PROD = process.env.NODE_ENV === "production";

// Query fields we capture. Each lands on the user row as `signup_<field>`
// (with `fbclid` mapping to `signup_fbclid`).
const QUERY_FIELDS = [
  "fbclid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

function firstString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

function clean(v: unknown): string | null {
  const s = firstString(v);
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_LEN);
}

export function attributionCapture(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const sess = (req as any).session;
    if (!sess) return next();

    if (!sess.attribution || typeof sess.attribution !== "object") {
      sess.attribution = {};
    }
    const attr = sess.attribution as Record<string, string>;

    // First-touch-wins for each query field.
    for (const field of QUERY_FIELDS) {
      if (attr[field]) continue;
      const value = clean((req.query as any)?.[field]);
      if (value) attr[field] = value;
    }

    // First-touch-wins for referrer (HTTP Referer header).
    if (!attr.referrer) {
      const referrer = clean(req.headers.referer);
      if (referrer) attr.referrer = referrer;
    }

    // _fbc cookie: Meta wants the LATEST click reflected in the browser
    // cookie even though we keep first-touch fbclid in our session/DB.
    // Format per Meta spec: fb.1.<unix_ms>.<fbclid>
    const liveFbclid = clean((req.query as any)?.fbclid);
    if (liveFbclid) {
      const fbc = `fb.1.${Date.now()}.${liveFbclid}`;
      _res.cookie("_fbc", fbc, {
        maxAge: FBC_MAX_AGE_MS,
        sameSite: "lax",
        secure: IS_PROD,
        httpOnly: false, // browser pixel must read this
        path: "/",
        // Skip `domain` in dev so the cookie is set on localhost. In prod
        // the domain should match the apex so it's shared across
        // app.field-view.com / www.field-view.com / future subdomains.
        ...(IS_PROD ? { domain: ".field-view.com" } : {}),
      });
    }
  } catch (err) {
    // Never surface an attribution capture failure to the request lifecycle.
    console.warn("[attribution] capture failed (non-fatal):", err);
  }
  next();
}
