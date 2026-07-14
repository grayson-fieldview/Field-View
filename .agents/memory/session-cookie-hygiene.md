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
