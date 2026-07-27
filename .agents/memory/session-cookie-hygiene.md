---
name: Session cookie hygiene on error responses
description: Any middleware that mutates req.session defeats saveUninitialized:false and can emit Set-Cookie on 401/403, logging mobile clients out.
---

# Session-cookie hygiene

Rule: never mutate `req.session` (even `sess.x = {}`) on requests that may be
anonymous or rejected, unless there is real data to store. With
`saveUninitialized: false`, express-session only skips Set-Cookie for
*unmodified* fresh sessions — any assignment marks it modified and a NEW empty
sid is emitted on the response, including 401/403.

**Why:** The attribution-capture middleware unconditionally initialized
`sess.attribution = {}`, so a mobile client whose session row had expired /
been pruned / failed to load got its cookie replaced by an empty anonymous sid
on a 401 → permanent logout (July 2026 incident).

**How to apply:** In global middleware, gather values first and only write to
the session if there is something new; skip `/api/*` for landing-page-only
concerns (Referer on an API XHR is our own app URL — junk attribution data).
`rolling: true` is harmless (re-sends the SAME sid). Verify with curl: 401/403
responses must have no Set-Cookie header.

## Passport 0.7 regenerate hazard (July 2026 login-loop incident)
- req.login internally calls session.regenerate(), destroying the caller's current session row BEFORE any error can surface. Any non-2xx response after req.login may carry the ONLY surviving sid — the mobile differing-sid guard discards Set-Cookie on non-2xx, stranding the session and triggering a silent re-login loop (one stillborn sessions row per loop iteration).
- **Rules:** never 500 after req.login (degrade the response body instead, keeping it gate-safe for the client auth cache: profileCompletedAt/role/etc.); skip req.login entirely when the caller is already authenticated as the same user (serializeUser stores only user.id, deserializeUser refetches per request — re-login adds nothing).
- Diagnostic: connect-pg-simple touch() updates only the expire column, not sess JSON — a row where expire > cookie_expires is a LIVE session; rows where they match to the second were minted and never reused.
