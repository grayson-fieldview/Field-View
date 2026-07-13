---
name: Owner gate depends on deserializeUser
description: requireOwnerAdmin (and anything reading req.user.account) only works because deserializeUser is the single place req.user is assembled per request.
---

# Owner gate / req.user enrichment

`requireOwnerAdmin` gates owner-only routes by reading `req.user.account?.ownerId`.
That field does not come from the `users` row — it is attached in `deserializeUser`
(`server/replit_integrations/auth/replitAuth.ts`), which is the **single place**
`req.user` is assembled on every authenticated request. It selects
`accounts.ownerId` alongside the existing `accounts.deletedAt` check and sets
`(user as any).account = { ownerId }`.

**Why:** The gate was previously stubbed to always 403 because no code attached an
`account` object — the middleware read a field that never existed. Any new
per-request user-derived context (roles, account flags, ownership) must be added
in `deserializeUser`, not invented ad-hoc in a route or middleware, or the
consumer silently gets `undefined`.

**How to apply:** When a gate/middleware needs a property off `req.user` that is
not a raw `users` column, enrich it in `deserializeUser` first, then read it. Do
not read `req.user.<x>` assuming it exists — grep `deserializeUser` to confirm the
field is attached. Field naming is camelCase (`ownerId`), matching Drizzle select
aliases, not the DB `owner_id`.
