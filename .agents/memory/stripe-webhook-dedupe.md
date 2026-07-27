---
name: Stripe webhook dedupe policy
description: When to dedupe Stripe webhook events vs rely on natural idempotency
---
- Dedupe (processed_stripe_events, INSERT ... ON CONFLICT DO NOTHING on event-id PK) is applied ONLY to handlers whose side effects are customer-facing and non-idempotent (e.g. trial_will_end → GHL pre-charge email). **Why:** a Stripe redelivery must not email a customer twice, but status dual-writes are naturally idempotent and ops-only Slack noise on replay is acceptable — blanket dedupe adds a DB write to every event for no benefit.
- **How to apply:** new webhook handlers that trigger customer-facing sends get the same insert-first guard; handlers that only write status or post ops Slack stay dedupe-free.
- GHL billing_event contract: per code comment, the GHL workflow branches on payment_status (not event_type) — any new event_type sent to billing_event requires the GHL workflow to add event_type branching FIRST, or it lands in the wrong flow.
