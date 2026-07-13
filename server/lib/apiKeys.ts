import crypto from "crypto";
import { db } from "../db";
import { apiKeys, type ApiKey } from "@shared/schema";
import { accounts, type Account } from "@shared/models/auth";
import { eq } from "drizzle-orm";

// Public key format: fv_live_<43-char base64url>. Only the sha256 hex of the
// full plaintext is ever persisted (keyHash); the plaintext is shown to the
// user exactly once at creation. keyPrefix = first 12 chars (incl. "fv_live_")
// and lastFour are display-only.
const KEY_PREFIX = "fv_live_";

// Throttle lastUsedAt writes so authentication does not incur a write on every
// request. At most one update per key per this window.
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export function generateApiKey(): {
  plaintext: string;
  hash: string;
  prefix: string;
  lastFour: string;
} {
  const random = crypto.randomBytes(32).toString("base64url");
  const plaintext = `${KEY_PREFIX}${random}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, 12),
    lastFour: plaintext.slice(-4),
  };
}

/**
 * Resolve a Bearer token to its api_keys row + owning account.
 * Returns null if the key is unknown, revoked, or the account is missing /
 * soft-deleted. Updates lastUsedAt at most once per LAST_USED_THROTTLE_MS
 * (fire-and-forget — never blocks or fails the request).
 */
export async function authenticateApiKey(
  bearerToken: string,
): Promise<{ key: ApiKey; account: Account } | null> {
  if (!bearerToken) return null;
  const hash = hashApiKey(bearerToken);

  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));
  if (!key) return null;
  if (key.revokedAt) return null;

  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, key.accountId));
  if (!account) return null;
  if (account.deletedAt) return null;

  const now = Date.now();
  const last = key.lastUsedAt ? key.lastUsedAt.getTime() : 0;
  if (now - last > LAST_USED_THROTTLE_MS) {
    // Fire-and-forget; wrapped in Promise.resolve so .catch is always present.
    Promise.resolve(
      db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)),
    ).catch((err) =>
      console.error("[apiKeys] lastUsedAt update failed:", err),
    );
  }

  return { key, account };
}
