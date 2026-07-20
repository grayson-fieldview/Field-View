// S46 client-side attribution capture.
//
// On Vercel, non-/api/* requests are served statically and never reach
// Express, so the server-side attributionCapture middleware never runs in
// production. This module captures first-touch marketing attribution in the
// browser instead and stores it in the `fv_attr` cookie (NOT localStorage —
// the OAuth redirect flow needs the SERVER to read the values, and only a
// cookie travels with the request).
//
// Captured fields: utm_source, utm_medium, utm_campaign, utm_content,
// utm_term, fbclid (from window.location.search) + referrer
// (document.referrer). First-touch wins: if the cookie already holds a
// populated field, it is never overwritten by a later visit.
//
// The server reads the cookie in persistSignupAttribution() as a fallback
// when req.session.attribution is empty. users.signup_utm_* columns and the
// persistence path are unchanged.

const QUERY_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "fbclid",
] as const;

const COOKIE_NAME = "fv_attr";
const MAX_LEN = 500; // mirrors server/middleware/attribution.ts
const MAX_AGE_DAYS = 14; // mirrors the 14-day session TTL

function clean(v: string | null): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_LEN);
}

function readCookie(): Record<string, string> | null {
  try {
    const match = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${COOKIE_NAME}=`));
    if (!match) return null;
    const raw = decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Malformed cookie — treat as absent; it will be rewritten on the next
    // visit that carries attribution.
  }
  return null;
}

export function captureAttribution(): void {
  try {
    const existing = readCookie();

    const params = new URLSearchParams(window.location.search);
    const updates: Record<string, string> = {};
    for (const field of QUERY_FIELDS) {
      if (existing?.[field]) continue; // first-touch wins
      const value = clean(params.get(field));
      if (value) updates[field] = value;
    }
    if (!existing?.referrer) {
      const referrer = clean(document.referrer);
      if (referrer) updates.referrer = referrer;
    }

    if (Object.keys(updates).length === 0) return;

    const merged = { ...(existing ?? {}), ...updates };
    const value = encodeURIComponent(JSON.stringify(merged));
    const maxAge = MAX_AGE_DAYS * 24 * 60 * 60;
    // Host-only cookie (no `domain` attribute) — scoped to the app host so
    // the server sees it on /api/register and the OAuth callback requests.
    document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${maxAge}; samesite=lax${
      window.location.protocol === "https:" ? "; secure" : ""
    }`;
  } catch {
    // Attribution capture must never break app boot.
  }
}
