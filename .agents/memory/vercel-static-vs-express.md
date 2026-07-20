---
name: Vercel static paths bypass Express
description: In prod, non-/api/* requests never reach Express middleware — capture must be client-side.
---
On Vercel, only `/api/*` routes hit the Express serverless function; all other paths are served statically. Any Express middleware keyed on landing-page hits (e.g. attribution capture from query params) silently never runs in production, even though it works in dev where Express serves everything.

**Why:** signup attribution showed "direct" in prod because the S46 session-based UTM capture middleware was unreachable; fixed by client-side capture into the host-only `fv_attr` cookie read as a fallback in `persistSignupAttribution` (session wins; server re-sanitizes with allowlist + 500-char cap since cookies are client-controlled).

**How to apply:** any future "on page visit" server-side logic must either live client-side (cookie/fetch to an /api endpoint) or be verified reachable under the Vercel rewrite config.
