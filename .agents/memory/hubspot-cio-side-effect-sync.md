---
name: CRM/marketing side-effect sync pattern
description: How lifecycle/CRM sync side-effects must be structured so they never block or break the request path (GHL is the platform of record; Customer.io and HubSpot were fully removed July 2026).
---

# CRM/marketing side-effect sync pattern

GoHighLevel (`server/lib/ghl.ts`, `sendGhlEvent`) is the ONLY lifecycle/marketing
integration. Customer.io and HubSpot were fully removed (July 2026) — modules,
call sites, and the `customerio-node` dep are gone. Do not re-add CIO/HubSpot code.

**The rule:** CRM/marketing side-effects run fire-and-forget from request
handlers and must NEVER throw into the response path. On Vercel, wrap the whole
sync in a `waitUntil`-based defer helper (the lambda freezes the moment
`res.json()` commits, killing in-flight promises), catch everything, log, return
void to the caller. `@vercel/functions` was deliberately KEPT as a dependency
for this reason even after its last consumers were deleted.

**Why orchestrator-wraps-helpers (not per-helper deferral):** association
between CRM objects needs ids returned by upsert calls, so building-block
helpers must be awaitable and return `id|null` (catch+log internally); a single
public orchestrator awaits them, associates, and is the one thing deferred.

**How to apply:** any new CRM/marketing side-effect: singleton config, no-op
when its API-key env var is unset (warn once), idempotent upserts keyed on a
natural key, and never awaited in the request path.
