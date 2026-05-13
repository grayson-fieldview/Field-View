import { Sentry } from "./sentry";

export const REWARDFUL_CAMPAIGN_ID = "e64e0035-e50b-4de3-aa78-e4bebbd0e123";
const REWARDFUL_API_BASE = "https://api.getrewardful.com/v1";

export class RewardfulError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "RewardfulError";
  }
}

export interface RewardfulAffiliateLink {
  id?: string;
  url: string;
  token?: string;
}

export interface RewardfulAffiliate {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  state?: string;
  visitors?: number;
  leads?: number;
  conversions?: number;
  unconfirmed_commissions?: number;
  unpaid_commissions?: number;
  paid_commissions?: number;
  due_commissions?: number;
  links?: RewardfulAffiliateLink[];
  // Rewardful exposes campaign membership two different ways depending on
  // whether the response is expanded — accept either shape.
  campaign?: { id?: string } | null;
  campaign_id?: string | null;
}

function affiliateCampaignId(a: RewardfulAffiliate): string | undefined {
  return a.campaign?.id ?? a.campaign_id ?? undefined;
}

function getAuthHeader(): string {
  const secret = process.env.REWARDFUL_API_SECRET;
  if (!secret) {
    throw new RewardfulError("REWARDFUL_API_SECRET is not set", 500);
  }
  // Rewardful uses HTTP Basic with the secret as the username and an empty password.
  const token = Buffer.from(`${secret}:`).toString("base64");
  return `Basic ${token}`;
}

async function rewardfulFetch(
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const url = `${REWARDFUL_API_BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers || {}),
      },
    });
  } catch (err: any) {
    Sentry.captureException(err);
    throw new RewardfulError(`Rewardful network error: ${err?.message || err}`);
  }

  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON response body — keep as raw text below
    }
  }

  if (!res.ok) {
    const err = new RewardfulError(
      `Rewardful API ${res.status} on ${path}`,
      res.status,
      parsed ?? text,
    );
    Sentry.captureException(err);
    throw err;
  }

  return parsed;
}

export async function getAffiliateById(
  id: string,
): Promise<RewardfulAffiliate> {
  return (await rewardfulFetch(`/affiliates/${encodeURIComponent(id)}`)) as RewardfulAffiliate;
}

/**
 * Returns the first affiliate matching the given email (and optionally
 * scoped to a specific campaign), or null when none exist. Rewardful's list
 * endpoint paginates under `data`. We post-filter by campaign id because
 * the same email can be enrolled across multiple campaigns on one account
 * — without this guard we'd bind a Field View user to the wrong campaign's
 * referral link.
 */
export async function findAffiliateByEmail(
  email: string,
  campaignId?: string,
): Promise<RewardfulAffiliate | null> {
  const params = new URLSearchParams({ email });
  // Hint to Rewardful to include campaign in the response so post-filter
  // works even on minimal payloads.
  params.append("expand[]", "campaign");
  const body = await rewardfulFetch(`/affiliates?${params.toString()}`);
  const list: RewardfulAffiliate[] = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : [];
  if (list.length === 0) return null;
  if (!campaignId) return list[0];
  const match = list.find((a) => affiliateCampaignId(a) === campaignId);
  return match ?? null;
}

export async function createAffiliate(input: {
  email: string;
  first_name: string;
  last_name: string;
}): Promise<RewardfulAffiliate> {
  return (await rewardfulFetch(`/affiliates`, {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      first_name: input.first_name,
      last_name: input.last_name,
      campaign_id: REWARDFUL_CAMPAIGN_ID,
    }),
  })) as RewardfulAffiliate;
}

/**
 * Extracts the `via=<code>` token from a Rewardful referral URL. Returns "" if
 * the URL is malformed or doesn't contain the param.
 */
export function extractReferralCode(referralUrl: string): string {
  try {
    const parsed = new URL(referralUrl);
    return parsed.searchParams.get("via") ?? "";
  } catch {
    return "";
  }
}
