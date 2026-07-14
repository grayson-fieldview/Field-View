# FieldView → GHL Lifecycle Integration Guide

Four events, four GHL inbound-webhook workflows. All backend calls use
`sendGhlEvent()` from `server/lib/ghl.ts` (fire-and-forget, same pattern as
the existing Slack notification).

New env vars (Replit Secrets + Vercel prod):

```
GHL_PARTIAL_SIGNUP_WEBHOOK_URL=
GHL_TRIAL_STARTED_WEBHOOK_URL=
GHL_ACTIVATION_WEBHOOK_URL=
GHL_BILLING_WEBHOOK_URL=
```

(Create the four GHL workflows first — each Inbound Webhook trigger
generates its URL.)

---

## 0. Migration — two new columns (run before deploying code)

```sql
-- SMS consent: required before any SMS sends (A2P/TCPA — you currently
-- show the checkbox but persist nothing).
ALTER TABLE users ADD COLUMN sms_consent_at TIMESTAMPTZ NULL;

-- Activation flag: idempotency guard so activation_milestone fires once.
ALTER TABLE accounts ADD COLUMN activated_at TIMESTAMPTZ NULL;
```

Also add both to the Drizzle/ORM schema in `shared/`.

---

## 1. `partial_signup` — fires at account creation (page 1)

**Where:** all **three** signup call sites, right next to the existing
`sendSlackNotification(...)`:

- `server/replit_integrations/auth/replitAuth.ts:676` (email/password `POST /api/register`)
- `replitAuth.ts:406` (Google OAuth signup)
- `replitAuth.ts:448` (Microsoft OAuth signup)

**Code (same shape at all three sites):**

```ts
import { sendGhlEvent } from "../../lib/ghl";

sendGhlEvent("partial_signup", {
  email: user.email,
  app_user_id: user.id,
  company_name: account.name,
  trial_ends_at: user.trial_ends_at, // trial clock starts NOW, at page 1
  partial_signup_date: new Date().toISOString().slice(0, 10),
  signup_source: user.signup_utm_source ?? "direct",
  utm_medium: user.signup_utm_medium ?? null,
  utm_campaign: user.signup_utm_campaign ?? null,
  signup_method: "email", // "google" / "microsoft" at the OAuth sites
});
```

Attribution columns already exist on `users` (persisted by the
`attributionCapture` middleware) — just pass them through.

---

## 2. `trial_started` — fires at profile completion (page 2)

**Where:** `PATCH /api/auth/me` handler in
`server/replit_integrations/auth/routes.ts`, immediately after
`profile_completed_at` is set (~line 118).

**Guard:** only fire on the FIRST completion — check that
`profile_completed_at` was NULL before this request. (The route can be hit
again for profile edits; those must not re-fire.)

**Also in this handler:** persist the TCPA checkbox. The client already
sends `tcpaAccepted`; store it:

```ts
if (req.body.tcpaAccepted === true) {
  updates.sms_consent_at = new Date();
}
```

**Code:**

```ts
import { sendGhlEvent, estimatedMrrFromCompanySize } from "../../lib/ghl";

const wasFirstCompletion = previousProfileCompletedAt === null; // fetch before update

if (wasFirstCompletion) {
  sendGhlEvent("trial_started", {
    email: user.email,
    app_user_id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    phone: user.phone ?? null,
    sms_consent: user.sms_consent_at !== null,
    trade_type: account.industry,        // e.g. "painting", "roofing"
    crew_size: account.company_size,     // "1-5" | "6-20" | "21-50" | "51-100" | "100+"
    trial_ends_at: user.trial_ends_at,
    estimated_mrr: estimatedMrrFromCompanySize(account.company_size),
  });
}
```

---

## 3. `activation_milestone` — fires when the account crosses the threshold

**Definition (v1):** account has ≥ 1 project AND ≥ 5 photos.

**Where:** the media-creation handler `POST /api/projects/:id/media` in
`server/routes.ts`, after the media row is inserted. Photos are the
last-crossed condition in practice, so checking here is sufficient; the
`activated_at` guard makes it correct even when it isn't.

(Note: Customer.io is being deprecated — GHL is the only lifecycle
messaging destination. Ignore any existing Customer.io event calls; do not
pattern-match against them or extend them.)

**Code:**

```ts
import { sendGhlEvent } from "./lib/ghl";

// after the media row is inserted:
if (account.activated_at === null) {
  const [projectCount, photoCount] = await Promise.all([
    db.count(projects, eq(projects.accountId, account.id)),
    db.count(media, eq(media.accountId, account.id)), // adjust to actual schema
  ]);

  if (projectCount >= 1 && photoCount >= 5) {
    const updated = await db
      .update(accounts)
      .set({ activated_at: new Date() })
      .where(and(eq(accounts.id, account.id), isNull(accounts.activated_at)))
      .returning(); // atomic check-and-set — race-safe

    if (updated.length > 0) {
      sendGhlEvent("activation_milestone", {
        email: adminUser.email, // the account's admin — GHL contact key
        app_user_id: adminUser.id,
        activation_status: "activated",
        activation_date: new Date().toISOString().slice(0, 10),
        projects_created: projectCount,
        photos_uploaded: photoCount,
      });
    }
  }
}
```

Two count queries per upload until activation, zero after (the
`activated_at === null` check short-circuits). Fine at current volume; add
counters later if uploads get hot.

---

## 4. `billing_event` — fires from the Stripe webhook handler

**Where:** `server/webhookHandlers.ts` / `server/lib/stripeWebhook.ts`,
after `writeAccountBilling(...)` completes, inside the existing handlers
for `checkout.session.completed`, `customer.subscription.updated`, and
`customer.subscription.deleted`.

**Code:**

```ts
import { sendGhlEvent, actualMrrFromSeats } from "./lib/ghl";

// after writeAccountBilling(...) succeeds:
const statusMap: Record<string, string> = {
  active: "active",
  trialing: "active",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "past_due",
};

sendGhlEvent("billing_event", {
  email: adminUser.email,
  app_user_id: adminUser.id,
  event_type: stripeEvent.type,
  payment_status: statusMap[subscription.status] ?? subscription.status,
  plan: isAnnual ? "annual" : "monthly",
  seat_count: account.seat_count,
  mrr: actualMrrFromSeats(account.seat_count, isAnnual),
  paid_conversion_date:
    stripeEvent.type === "checkout.session.completed"
      ? new Date().toISOString().slice(0, 10)
      : null,
  churn_date:
    stripeEvent.type === "customer.subscription.deleted"
      ? new Date().toISOString().slice(0, 10)
      : null,
});
```

Note: `invoice.payment_failed` is **not** currently in the handled event
list — `customer.subscription.updated` with `status: past_due` covers
dunning entry, so no new Stripe events are required. (Optionally add
`invoice.payment_failed` to the Stripe endpoint later for faster
past-due detection.)

Keep the existing pattern: verify signature, return 200 fast; the GHL call
is already non-blocking.

---

## GHL workflow configuration (the receiving side)

All four workflows: trigger = Inbound Webhook; find/update contact by
**email**; map payload fields to the contact custom fields.

**WF1 — Partial Signup**
1. Create/update contact → map `app_user_id`, `company_name`,
   `signup_source`, `partial_signup_date`, `trial_end_date` ← `trial_ends_at`
2. Tag `partial_signup`
3. Create opportunity → Field View Users → **Partial Signup** stage
4. Wait 1 hour → If contact has tag `trial_active` → exit
5. Nurture (copy angle: **"your 14-day trial is already running — finish
   setup"** — the clock started at page 1): Email 1 at hour 1, Email 2 day 1,
   Email 3 day 3. SMS steps omitted here — no phone exists until page 2.

**WF2 — Trial Started**
1. Update contact → `first_name`, `last_name`, `phone`, `trade_type`,
   `crew_size`, `sms_consent`, `estimated_mrr`
2. Remove tag `partial_signup` → add `trial_active`
3. Remove from WF1
4. Move opportunity → **Trial Active – Not Activated**; set opportunity
   value = `estimated_mrr`
5. Enter trial onboarding nurture (activation-focused)

**WF3 — Activation**
1. Update contact → `activation_status`, `activation_date`,
   `projects_created`, `photos_uploaded`
2. Add tag `activated`
3. Move opportunity → **Trial Active – Activated**; swap nurture tracks

**WF4 — Billing**
1. Update contact → `payment_status`, `plan`, `mrr`, `seat_count`, dates
2. Branch on `payment_status`:
   - `active` → move to **Paid – Active**, set opportunity value = `mrr`,
     tag `paid`, remove from all sales/nurture workflows
   - `past_due` → move to **Payment Failed**, enter dunning
   - `canceled` → move to **Churned** (or **Trial Ended – Not Converted**
     if contact still has tag `trial_active` and never had `paid`), enter
     winback

**WF5 — Trial Ending Soon (date-based, no webhook)**
- Trigger: 3 days before `trial_end_date`
- Move opportunity → **Trial Ending Soon**, enter conversion sequence
  (no card on file — this IS the sales push)

**WF6 — Trial Expired (date-based safety net)**
- Trigger: 1 day after `trial_end_date`
- If contact lacks tag `paid` → move to **Trial Ended – Not Converted**,
  enter winback. (Needed again because no card = no automatic Stripe event
  at trial end; app just degrades to read-only.)

**SMS suppression rule (all workflows):** SMS actions only run when
`sms_consent` = true AND A2P registration is approved.

---

## Backfill — populate the pipeline with existing users

Run against prod RDS (TablePlus). Historical partial signups:

```sql
SELECT u.id AS app_user_id,
       u.email,
       a.name AS company_name,
       u.signup_utm_source,
       u.trial_ends_at,
       u.created_at::date AS partial_signup_date
FROM users u
JOIN accounts a ON a.id = u.account_id
WHERE u.role = 'admin'
  AND u.profile_completed_at IS NULL
  AND u.deleted_at IS NULL;   -- adjust to actual soft-delete column
```

Export CSV → GHL contact import with tag `partial_signup` (imports can be
excluded from workflow triggers — enroll manually only those whose trial
hasn't expired). Equivalent queries for the other cohorts: completed
profile + `trial_ends_at > now()` + no subscription → Trial Active;
`trial_ends_at < now()` + no subscription → Trial Ended – Not Converted;
`subscription_status = 'active'` → Paid.

---

## End-to-end test plan (staging or a +test email)

1. Sign up via page 1 only → contact appears in Partial Signup with
   attribution + trial_end_date; after 1 h, Email 1 sends.
2. Complete page 2 (check TCPA box) → tag swap, WF1 exit, opportunity moves
   to Trial Active – Not Activated, value = estimated_mrr,
   `sms_consent_at` populated in DB.
3. Create a project, upload 5 photos → `activated_at` set once, opportunity
   moves to Trial Active – Activated. Upload a 6th photo → no duplicate fire.
4. Subscribe via Stripe test mode → Paid – Active, value overwritten with
   real MRR, removed from nurtures.
5. Cancel in Stripe test mode → Churned + winback.
6. Repeat #1 with a Google OAuth signup → confirm the OAuth call site fires.
7. Confirm exactly ONE contact and ONE opportunity exist for the test email
   at every step.
