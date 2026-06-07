// HubSpot CRM sync (signup Phase 1).
//
// Architecture — deliberately mirrors server/services/customerio.ts:
//   • Server-side only.
//   • Singleton config resolved once at module load from HUBSPOT_SERVICE_KEY.
//   • Fully fire-and-forget + non-fatal. Public orchestrators
//     (syncNewAccountToHubSpot / syncProfileToHubSpot) wrap all work in the
//     same deferToVercel/waitUntil helper customerio.ts uses, catch every
//     error, report via Sentry, and NEVER throw into the request path. A
//     HubSpot outage must never block a signup.
//   • Missing HUBSPOT_SERVICE_KEY (dev / staging) → no-op mode. Warns once on
//     first call, then every public function returns immediately.
//
// Idempotency:
//   • Contacts deduped by email (HubSpot's natural unique key).
//   • Companies + Deals deduped by the custom property `fieldview_account_id`.
//   • upsertDealByAccountId is create-once: if a Deal already exists for the
//     account it is a NO-OP (we never move an existing Deal's stage here).
//   • Associations use v4 `PUT .../associations/default/...` which is idempotent.
//
// Runs ALONGSIDE Customer.io — it does not replace or modify any CIO code.
//
// NOTE ON THE FIRE-AND-FORGET vs. RETURN-VALUE TENSION:
//   The four building-block helpers (upsertContactByEmail, etc.) are awaitable
//   and return the HubSpot object id (or null on failure) because association
//   requires those ids. They each catch + Sentry-log internally and return null
//   rather than throwing. The PUBLIC entry points compose them inside a single
//   deferToVercel-wrapped promise, so from the caller's perspective the whole
//   sync is fire-and-forget and non-fatal, exactly per the guardrails.

import { waitUntil } from "@vercel/functions";
import { Sentry } from "../lib/sentry";

// Identical to customerio.ts: keep the fire-and-forget promise alive on Vercel
// (the lambda freezes at res.json()), fall back to plain catch off-Vercel.
function deferToVercel(promise: Promise<unknown>): void {
  try {
    waitUntil(promise);
  } catch {
    promise.catch(() => {});
  }
}

const HUBSPOT_KEY = process.env.HUBSPOT_SERVICE_KEY;
const BASE_URL = "https://api.hubapi.com";

const hubspotEnabled = !!HUBSPOT_KEY;
if (hubspotEnabled) {
  console.log("[hubspot] initialized");
}

let noopWarned = false;
function noopWarnOnce() {
  if (!noopWarned) {
    noopWarned = true;
    console.warn(
      "[hubspot] HUBSPOT_SERVICE_KEY not set — running in no-op mode. All HubSpot sync calls will be skipped.",
    );
  }
}

export type HubSpotProps = Record<string, unknown>;

// HubSpot v3 expects every property value as a string. Drop null/undefined so
// we never blank out an existing field by accident.
function toProperties(props: HubSpotProps): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

// Thin authenticated fetch wrapper. Throws on non-2xx with the status code and
// response body embedded so the caller's catch can Sentry-log a useful message.
async function hsFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${HUBSPOT_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`HubSpot ${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

async function searchFirstIdBy(
  objectType: "contacts" | "companies" | "deals",
  propertyName: string,
  value: string,
): Promise<string | null> {
  const data = await hsFetch(`/crm/v3/objects/${objectType}/search`, {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName, operator: "EQ", value }] }],
      properties: [propertyName],
      limit: 1,
    }),
  });
  return data?.results?.[0]?.id ?? null;
}

// ── Building-block helpers (awaitable; return id or null) ──────────────────

// Search Contact by email; update if found, otherwise create. Returns id.
export async function upsertContactByEmail(
  email: string,
  props: HubSpotProps,
): Promise<string | null> {
  if (!hubspotEnabled) {
    noopWarnOnce();
    return null;
  }
  try {
    const properties = toProperties({ email, ...props });
    const existingId = await searchFirstIdBy("contacts", "email", email);
    if (existingId) {
      await hsFetch(`/crm/v3/objects/contacts/${existingId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
      return existingId;
    }
    try {
      const created = await hsFetch(`/crm/v3/objects/contacts`, {
        method: "POST",
        body: JSON.stringify({ properties }),
      });
      return created?.id ?? null;
    } catch (createErr) {
      // Lost a create race (409 CONFLICT) — re-find and update instead.
      const raceId = await searchFirstIdBy("contacts", "email", email);
      if (raceId) {
        await hsFetch(`/crm/v3/objects/contacts/${raceId}`, {
          method: "PATCH",
          body: JSON.stringify({ properties }),
        });
        return raceId;
      }
      throw createErr;
    }
  } catch (err) {
    console.error("[hubspot] upsertContactByEmail failed:", err);
    Sentry.captureException(err, { tags: { integration: "hubspot", op: "upsertContact" } });
    return null;
  }
}

// Search Company by fieldview_account_id; update if found, otherwise create.
export async function upsertCompanyByAccountId(
  accountId: string,
  props: HubSpotProps,
): Promise<string | null> {
  if (!hubspotEnabled) {
    noopWarnOnce();
    return null;
  }
  try {
    const properties = toProperties({ fieldview_account_id: accountId, ...props });
    const existingId = await searchFirstIdBy("companies", "fieldview_account_id", accountId);
    if (existingId) {
      await hsFetch(`/crm/v3/objects/companies/${existingId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties }),
      });
      return existingId;
    }
    try {
      const created = await hsFetch(`/crm/v3/objects/companies`, {
        method: "POST",
        body: JSON.stringify({ properties }),
      });
      return created?.id ?? null;
    } catch (createErr) {
      // Lost a create race (or search lagged the just-created row) — re-find by
      // the account-id key and patch instead of creating a duplicate Company.
      const raceId = await searchFirstIdBy("companies", "fieldview_account_id", accountId);
      if (raceId) {
        await hsFetch(`/crm/v3/objects/companies/${raceId}`, {
          method: "PATCH",
          body: JSON.stringify({ properties }),
        });
        return raceId;
      }
      throw createErr;
    }
  } catch (err) {
    console.error("[hubspot] upsertCompanyByAccountId failed:", err);
    Sentry.captureException(err, { tags: { integration: "hubspot", op: "upsertCompany" } });
    return null;
  }
}

// Search Deal by fieldview_account_id. Create at the configured pipeline/stage
// if none exists; otherwise NO-OP (return the existing id, never move stage).
export async function upsertDealByAccountId(
  accountId: string,
  props: HubSpotProps,
): Promise<string | null> {
  if (!hubspotEnabled) {
    noopWarnOnce();
    return null;
  }
  try {
    const existingId = await searchFirstIdBy("deals", "fieldview_account_id", accountId);
    if (existingId) {
      // Deal already exists for this account — do not duplicate, do not restage.
      return existingId;
    }
    const properties = toProperties({ fieldview_account_id: accountId, ...props });
    try {
      const created = await hsFetch(`/crm/v3/objects/deals`, {
        method: "POST",
        body: JSON.stringify({ properties }),
      });
      return created?.id ?? null;
    } catch (createErr) {
      // Lost a create race (or search lagged the just-created row) — re-find by
      // the account-id key. If found, NO-OP (never duplicate / restage a Deal).
      const raceId = await searchFirstIdBy("deals", "fieldview_account_id", accountId);
      if (raceId) return raceId;
      throw createErr;
    }
  } catch (err) {
    console.error("[hubspot] upsertDealByAccountId failed:", err);
    Sentry.captureException(err, { tags: { integration: "hubspot", op: "upsertDeal" } });
    return null;
  }
}

// Create the default-labelled associations: Contact↔Company, Deal↔Contact,
// Deal↔Company. v4 PUT is idempotent. Each pairing is independent — a missing
// id (failed upstream upsert) just skips that pairing.
export async function associate(
  contactId: string | null,
  companyId: string | null,
  dealId: string | null,
): Promise<void> {
  if (!hubspotEnabled) {
    noopWarnOnce();
    return;
  }
  const link = async (
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
  ) => {
    await hsFetch(
      `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`,
      { method: "PUT" },
    );
  };
  try {
    if (contactId && companyId) await link("contacts", contactId, "companies", companyId);
    if (dealId && contactId) await link("deals", dealId, "contacts", contactId);
    if (dealId && companyId) await link("deals", dealId, "companies", companyId);
  } catch (err) {
    console.error("[hubspot] associate failed:", err);
    Sentry.captureException(err, { tags: { integration: "hubspot", op: "associate" } });
  }
}

// ── Public fire-and-forget orchestrators (called from the request path) ─────

// HubSpot date properties take midnight-UTC; YYYY-MM-DD is accepted and avoids
// timezone drift.
function toHubSpotDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// HubSpot's standard `numberofemployees` property is numeric, but the app stores
// company size as a range enum ("1-5", "6-20", … "100+"). Map each range to a
// representative integer (upper bound; 100+ → 100) so writes don't fail numeric
// validation. Unknown values → null (skipped).
const COMPANY_SIZE_TO_COUNT: Record<string, number> = {
  "1-5": 5,
  "6-20": 20,
  "21-50": 50,
  "51-100": 100,
  "100+": 100,
};
function companySizeToEmployeeCount(size: string | null | undefined): number | null {
  if (!size) return null;
  return COMPANY_SIZE_TO_COUNT[size] ?? null;
}

// HOOK 1 — new self-serve account creation (no-inviteToken branch only).
// Fire-and-forget: upsert Contact + Company + Deal, then associate the three.
export function syncNewAccountToHubSpot(input: {
  email: string;
  accountId: string;
  accountName: string;
  trialEndsAt: Date | string | null | undefined;
}): void {
  if (!hubspotEnabled) {
    noopWarnOnce();
    return;
  }
  deferToVercel(
    (async () => {
      try {
        const contactId = await upsertContactByEmail(input.email, {
          email: input.email,
          trial_end_date: toHubSpotDate(input.trialEndsAt),
        });
        const companyId = await upsertCompanyByAccountId(input.accountId, {
          name: input.accountName,
          fieldview_account_id: input.accountId,
        });
        const dealId = await upsertDealByAccountId(input.accountId, {
          dealname: `${input.accountName} — Trial`,
          fieldview_account_id: input.accountId,
          pipeline: "default",
          dealstage: "appointmentscheduled",
        });
        await associate(contactId, companyId, dealId);
      } catch (err) {
        console.error("[hubspot] syncNewAccountToHubSpot failed:", err);
        Sentry.captureException(err, {
          tags: { integration: "hubspot", op: "syncNewAccount" },
        });
      }
    })(),
  );
}

// HOOK 2 — profile completion (signup step 2). Fire-and-forget: refresh the
// Contact name/phone and the Company type/size. Associations already exist from
// HOOK 1, so no re-association is needed.
export function syncProfileToHubSpot(input: {
  email: string;
  accountId: string | null | undefined;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  companyType?: string | null;
  companySize?: string | null;
}): void {
  if (!hubspotEnabled) {
    noopWarnOnce();
    return;
  }
  deferToVercel(
    (async () => {
      try {
        await upsertContactByEmail(input.email, {
          firstname: input.firstName,
          lastname: input.lastName,
          phone: input.phone,
        });
        if (input.accountId && (input.companyType || input.companySize)) {
          await upsertCompanyByAccountId(input.accountId, {
            fieldview_company_type: input.companyType,
            numberofemployees: companySizeToEmployeeCount(input.companySize),
          });
        }
      } catch (err) {
        console.error("[hubspot] syncProfileToHubSpot failed:", err);
        Sentry.captureException(err, {
          tags: { integration: "hubspot", op: "syncProfile" },
        });
      }
    })(),
  );
}
