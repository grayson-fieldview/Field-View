// server/lib/ghl.ts
// GHL (GoHighLevel) inbound-webhook relay for lifecycle events.
// Mirrors the Slack notification pattern: fire-and-forget, never blocks
// or fails the request path. If an env var is missing (e.g., local dev),
// the call is a silent no-op.

import { and, count, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { accounts, users } from "@shared/models/auth";
import { media, projects } from "@shared/schema";
import { db } from "../db";
import { isCompAccount } from "./slack";

const GHL_URLS = {
  partial_signup: process.env.GHL_PARTIAL_SIGNUP_WEBHOOK_URL,
  trial_started: process.env.GHL_TRIAL_STARTED_WEBHOOK_URL,
  activation_milestone: process.env.GHL_ACTIVATION_WEBHOOK_URL,
  billing_event: process.env.GHL_BILLING_WEBHOOK_URL,
} as const;

export type GhlEvent = keyof typeof GHL_URLS;

export function sendGhlEvent(
  event: GhlEvent,
  payload: Record<string, unknown>,
): void {
  const url = GHL_URLS[event];
  if (!url) return;

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, ...payload }),
  }).catch(() => {
    // Intentionally swallowed — a GHL outage must never break signup,
    // profile completion, uploads, or Stripe webhook processing.
    // (Optional: report to Sentry as a non-fatal breadcrumb.)
  });
}

// ---------------------------------------------------------------------------
// Estimated MRR from the company_size dropdown (accounts.company_size).
// Pricing: $79/mo includes 3 seats; each additional seat is $29/mo.
//
// NOTE: assumed seats are deliberately conservative — a company's headcount
// is not its FieldView seat count (office staff, subs, and part-timers
// usually don't get seats). Tune these as real seat data comes in, then
// compare against actual accounts.seat_count for paid accounts.
// ---------------------------------------------------------------------------

const SEAT_ASSUMPTIONS: Record<string, number> = {
  "1-5": 3, // covered by base plan
  "6-20": 8, // 79 + 5 × 29  = $224
  "21-50": 15, // 79 + 12 × 29 = $427
  "51-100": 25, // 79 + 22 × 29 = $717
  "100+": 40, // 79 + 37 × 29 = $1,152
};

const BASE_PRICE = 79;
const SEAT_PRICE = 29;
const INCLUDED_SEATS = 3;

export function estimatedMrrFromCompanySize(
  companySize?: string | null,
): number {
  const seats = SEAT_ASSUMPTIONS[companySize ?? ""] ?? INCLUDED_SEATS;
  return BASE_PRICE + Math.max(0, seats - INCLUDED_SEATS) * SEAT_PRICE;
}

export function actualMrrFromSeats(seatCount: number, isAnnual: boolean): number {
  const monthlyEquivalentBase = isAnnual ? 588 / 12 : BASE_PRICE; // $49/mo effective on annual
  const monthlyEquivalentSeat = isAnnual ? 240 / 12 : SEAT_PRICE; // $20/mo effective on annual
  return (
    monthlyEquivalentBase +
    Math.max(0, seatCount - INCLUDED_SEATS) * monthlyEquivalentSeat
  );
}

// ---------------------------------------------------------------------------
// Daily usage sync → GHL contact custom fields (REST API 2.0 contact upsert).
// Runs from GET /api/cron/ghl-usage-sync (Vercel Cron, daily). Read-only
// against our DB; writes only to GHL. Env-var fail-safe mirrors the webhook
// relay above: if GHL_API_TOKEN or GHL_LOCATION_ID is unset, the whole sync
// logs a warning and no-ops.
// ---------------------------------------------------------------------------

const GHL_FIELD_KEYS = {
  projects_created: "contact.projects_created",
  photos_uploaded: "contact.photos_uploaded",
  seat_count: "contact.seat_count",
  last_activity_at: "contact.last_activity_at",
  last_synced_at: "contact.last_synced_at",
  photos_last_7d: "contact.photos_last_7d",
} as const;

// GHL API 2.0's upsert customFields array takes { key, field_value } entries.
// Primary format is the full "contact."-prefixed key. If the live test shows
// fields not populating, strip the prefix here (one-line change):
//   return key.replace(/^contact\./, "");
function toGhlFieldKey(key: string): string {
  return key;
}

// YYYY-MM-DD — GHL date-picker fields are date-only.
function toGhlDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const GHL_UPSERT_URL = "https://services.leadconnectorhq.com/contacts/upsert";
const GHL_API_VERSION = "2021-07-28";
const SYNC_ACCOUNT_CAP = 200; // fits Vercel's 60s maxDuration; no pagination yet
const SYNC_DELAY_MS = 150;

export interface GhlUsageSyncSummary {
  matched: number;
  synced: number;
  skipped_null_owner: number;
  skipped_comp: number;
  failed: number;
  failed_emails: string[];
  truncated: boolean;
}

export async function syncUsageToGhl(): Promise<GhlUsageSyncSummary | null> {
  const token = process.env.GHL_API_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    console.warn(
      "[ghl-sync] GHL_API_TOKEN or GHL_LOCATION_ID not set — skipping usage sync",
    );
    return null;
  }

  // Eligible accounts: paid (active) + recoverable (past_due, intentionally
  // included — sales needs usage context) + unexpired trials. Fetch cap+1 so
  // we can report truncation without a second count query.
  const eligible = await db
    .select({ id: accounts.id, ownerId: accounts.ownerId })
    .from(accounts)
    .where(
      and(
        isNull(accounts.deletedAt),
        or(
          inArray(accounts.subscriptionStatus, ["active", "past_due"]),
          and(
            inArray(accounts.subscriptionStatus, ["trialing", "trial"]),
            gt(accounts.trialEndsAt, sql`NOW()`),
          ),
        ),
      ),
    )
    .limit(SYNC_ACCOUNT_CAP + 1);

  const truncated = eligible.length > SYNC_ACCOUNT_CAP;
  const batch = truncated ? eligible.slice(0, SYNC_ACCOUNT_CAP) : eligible;

  const summary: GhlUsageSyncSummary = {
    matched: batch.length,
    synced: 0,
    skipped_null_owner: 0,
    skipped_comp: 0,
    failed: 0,
    failed_emails: [],
    truncated,
  };

  const accountIds = batch.map((a) => a.id);
  const ownerIds = batch
    .map((a) => a.ownerId)
    .filter((id): id is string => id != null);

  if (accountIds.length === 0) {
    console.log("[ghl-sync] no eligible accounts — nothing to sync");
    return summary;
  }

  // Set-based aggregates (one query per stat, not per account).

  // Owners.
  const ownerRows = ownerIds.length
    ? await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, ownerIds))
    : [];
  const ownersById = new Map(ownerRows.map((u) => [u.id, u]));

  // projects_created — same counting definition as checkActivationMilestone.
  const projectRows = await db
    .select({ accountId: projects.accountId, c: count() })
    .from(projects)
    .where(inArray(projects.accountId, accountIds))
    .groupBy(projects.accountId);
  const projectCounts = new Map(projectRows.map((r) => [r.accountId, Number(r.c)]));

  // photos_uploaded — media joined through projects, images only (videos
  // excluded via mime_type LIKE 'image/%'), same as checkActivationMilestone.
  const photoRows = await db
    .select({ accountId: projects.accountId, c: count() })
    .from(media)
    .innerJoin(projects, eq(media.projectId, projects.id))
    .where(
      and(
        inArray(projects.accountId, accountIds),
        sql`${media.mimeType} LIKE 'image/%'`,
      ),
    )
    .groupBy(projects.accountId);
  const photoCounts = new Map(photoRows.map((r) => [r.accountId, Number(r.c)]));

  // photos_last_7d — same photo definition, last 7 days.
  const photo7dRows = await db
    .select({ accountId: projects.accountId, c: count() })
    .from(media)
    .innerJoin(projects, eq(media.projectId, projects.id))
    .where(
      and(
        inArray(projects.accountId, accountIds),
        sql`${media.mimeType} LIKE 'image/%'`,
        gt(media.createdAt, sql`NOW() - INTERVAL '7 days'`),
      ),
    )
    .groupBy(projects.accountId);
  const photo7dCounts = new Map(photo7dRows.map((r) => [r.accountId, Number(r.c)]));

  // seat_count (active users, deleted_at IS NULL — pattern from lib/seats.ts)
  // + last_activity_at (MAX(last_active_at) over the same rows) in one pass.
  const seatRows = await db
    .select({
      accountId: users.accountId,
      c: count(),
      lastActive: sql<string | null>`MAX(${users.lastActiveAt})`,
    })
    .from(users)
    .where(and(inArray(users.accountId, accountIds), isNull(users.deletedAt)))
    .groupBy(users.accountId);
  const seatCounts = new Map(seatRows.map((r) => [r.accountId, Number(r.c)]));
  const lastActivity = new Map(
    seatRows.map((r) => [r.accountId, r.lastActive ? new Date(r.lastActive) : null]),
  );

  const now = new Date();

  for (const acct of batch) {
    if (!acct.ownerId) {
      summary.skipped_null_owner++;
      continue;
    }
    const owner = ownersById.get(acct.ownerId);
    if (!owner?.email) {
      // Owner row missing/emailless — treat like a null owner: nothing to upsert.
      summary.skipped_null_owner++;
      continue;
    }
    if (isCompAccount(owner.email)) {
      summary.skipped_comp++;
      continue;
    }

    const lastActiveAt = lastActivity.get(acct.id) ?? null;
    const customFields: { key: string; field_value: string | number }[] = [
      { key: toGhlFieldKey(GHL_FIELD_KEYS.projects_created), field_value: projectCounts.get(acct.id) ?? 0 },
      { key: toGhlFieldKey(GHL_FIELD_KEYS.photos_uploaded), field_value: photoCounts.get(acct.id) ?? 0 },
      { key: toGhlFieldKey(GHL_FIELD_KEYS.photos_last_7d), field_value: photo7dCounts.get(acct.id) ?? 0 },
      { key: toGhlFieldKey(GHL_FIELD_KEYS.seat_count), field_value: seatCounts.get(acct.id) ?? 0 },
      { key: toGhlFieldKey(GHL_FIELD_KEYS.last_synced_at), field_value: toGhlDate(now) },
    ];
    if (lastActiveAt) {
      customFields.push({
        key: toGhlFieldKey(GHL_FIELD_KEYS.last_activity_at),
        field_value: toGhlDate(lastActiveAt),
      });
    }

    try {
      const resp = await fetch(GHL_UPSERT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Version: GHL_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          locationId,
          email: owner.email,
          customFields,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "<unreadable body>");
        console.error(
          `[ghl-sync] upsert failed for ${owner.email}: HTTP ${resp.status} — ${body}`,
        );
        summary.failed++;
        summary.failed_emails.push(owner.email);
      } else {
        summary.synced++;
      }
    } catch (err: any) {
      console.error(
        `[ghl-sync] upsert threw for ${owner.email}:`,
        err?.message || err,
      );
      summary.failed++;
      summary.failed_emails.push(owner.email);
    }

    await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_MS));
  }

  console.log(
    `[ghl-sync] done: synced ${summary.synced}, skipped_null_owner ${summary.skipped_null_owner}, ` +
      `skipped_comp ${summary.skipped_comp}, failed ${summary.failed}` +
      (summary.failed ? ` (${summary.failed_emails.join(", ")})` : "") +
      (summary.truncated ? " [TRUNCATED at 200 accounts]" : ""),
  );
  return summary;
}
