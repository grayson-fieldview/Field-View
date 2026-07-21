---
name: Meta pixel/CAPI dedup pairing
description: How browser pixel and Conversions API events are kept 1:1 deduplicated
---

Rule: every browser `fbq('track', ...)` conversion event must have an ID-matched server CAPI twin. The client generates `crypto.randomUUID()`, sends it as `metaEventId` in the request body, and only fires the pixel when the server response includes the pairing flag (`metaLeadFired` / `metaStartTrialFired`) confirming the CAPI event actually fired with that `event_id`.

**Why:** Meta Events Manager double-counted conversions (0% event ID coverage) and showed pixel/server count skew when the browser fired events the server's gates (owner-only, non-comp, first-completion) suppressed. Gating the pixel on the server's signal guarantees equal counts and 100% dedup coverage.

**How to apply:** When adding any new Meta conversion event, wire all three pieces in lockstep: identical event_name string on both sides, shared event_id via request body, and a server-response flag gating the browser fire. Server-only events (OAuth Lead, Subscribe, Activated) need no pixel counterpart. Flags are transport-only — strip them before seeding the auth query cache. Stale Events Manager artifacts ("Start trial", "__missing_event") come from pre-dedup deployed bundles, not current code.
