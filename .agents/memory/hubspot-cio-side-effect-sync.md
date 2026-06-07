---
name: HubSpot/Customer.io side-effect sync pattern
description: How marketing/CRM sync side-effects must be structured so they never block or break the request path.
---

# CRM/marketing side-effect sync pattern (HubSpot, Customer.io)

Side-effect syncs to external CRM/marketing tools (HubSpot, Customer.io) run as
fire-and-forget from auth/request handlers and must NEVER throw into the response.

**The rule:** wrap the whole sync in the shared `deferToVercel(waitUntil)` helper
(needed because the Vercel lambda freezes the moment `res.json()` commits, killing
in-flight promises), catch everything, log to Sentry, return void to the caller.

**Why the orchestrator-wraps-helpers shape (not per-helper deferral):** association
between CRM objects needs the ids returned by the create/upsert calls, so the
building-block helpers must be *awaitable and return ids*. If each helper were
individually fire-and-forget you could never associate them. Resolution: helpers
are awaitable (catch+Sentry internally, return id|null); a single public
orchestrator awaits them, associates, and is the one thing wrapped in
deferToVercel. From the caller's view the entire sync is one fire-and-forget call.

**How to apply:** new CRM/marketing side-effects mirror `server/services/customerio.ts`
and `server/services/hubspot.ts` — singleton, no-op when the API key env var is
unset (warn once), idempotent upserts (dedupe by a natural/custom key), and a
create-then-re-search fallback on conflict so retries/races don't duplicate rows.
HubSpot runs ALONGSIDE Customer.io; never remove or modify CIO when adding HubSpot.
