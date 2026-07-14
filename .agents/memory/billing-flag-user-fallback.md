---
name: Billing gate honors account status only behind flag
description: getAccountBilling reads accounts.subscription_status only when ACCOUNT_BILLING_ENABLED is truthy; otherwise it silently uses the user row's status (default 'none').
---

# Billing flag / user-row fallback

`getAccountBilling` (server/lib/billing.ts) returns the ACCOUNT's billing state
only when `ACCOUNT_BILLING_ENABLED` is `"true"`/`"1"`. Otherwise (or when the
account row's status is null) it falls back to the USER row's
`subscription_status`, which defaults to `'none'` → `computeAccessLevel` →
`locked` → 402 "Subscription required".

**Why:** A prod account with `subscription_status='active'` still had writes
rejected with 402 because the flag was off and the admin's user-row status was
'none'. Mobile rendered the 402 as "Not Authorized" (that string exists nowhere
server-side — client-side wording).

**How to apply:** When debugging "active account but access denied", check the
flag first, then the USER row's subscription_status — not just the account row.
Any manual/demo account setup must set status on whichever row the flag makes
authoritative (or both).
