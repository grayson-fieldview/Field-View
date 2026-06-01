---
name: Team page seat-cap gating
description: Trial/seat-cap enforcement on the Team page is gated in multiple client sites, not just the API
---

# Seat-cap enforcement is gated in multiple places on the Team page

When changing trial seat-cap semantics, the backend signal alone is NOT enough — the Team invite UI short-circuits BEFORE the mutation fires in three separate client spots (in `client/src/pages/team.tsx`):

1. `handleSendInvite` preflight — early-returns with a toast when `used >= trialMaxSeats`.
2. The "Send Invitation" button `disabled` condition — same `used >= trialMaxSeats` check, so the click never happens.
3. The inline warning `<p>` text under the invite form.

**Why:** A new lower cap (no-card trial = 3 seats) made the preflight + disabled button fire at 3, so the new backend `trial_needs_card` error response was never reachable and the unlock-card toast never showed. Fixing only the error handlers was insufficient.

**How to apply:** Any change to trial/seat cap behavior must update all three client gates in lockstep with the API, or the UI will block the user before the server response can be observed. Gate the "hard cap" checks on the card-on-file case (e.g. `!trialCanUnlockSeats`) so soft caps stay clickable.

Error-field convention differs by endpoint: invite (`POST /api/invitations`) returns `error: "..."`; seat-add (`POST /api/account/seats`) returns `code: "..."`. Match the right field per handler.
