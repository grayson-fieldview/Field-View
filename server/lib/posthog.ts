import { createHash } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { PostHog } from "posthog-node";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

let client: PostHog | null | undefined;
let warnedMissingKey = false;

function keepAlive(promise: Promise<unknown>): void {
  const settled = promise.catch((error) => {
    console.error("[posthog] server flush failed (non-fatal):", error);
  });
  try {
    waitUntil(settled);
  } catch {
    // Local development has no Vercel request context. The settled promise
    // remains in flight and cannot produce an unhandled rejection.
  }
}

function getPostHogClient(): PostHog | null {
  if (client !== undefined) return client;

  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn("[posthog] POSTHOG_API_KEY not set — server events disabled");
    }
    client = null;
    return client;
  }

  try {
    client = new PostHog(apiKey, {
      host: process.env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
      waitUntil: keepAlive,
    });
  } catch (error) {
    console.error("[posthog] server initialization failed (non-fatal):", error);
    client = null;
  }

  return client;
}

export function postHogEventUuid(dedupeKey: string): string {
  const bytes = createHash("sha256").update(dedupeKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

export function capturePostHogEvent(input: {
  event: string;
  userId: string;
  accountId: string;
  properties?: Record<string, unknown>;
  dedupeKey?: string;
}): void {
  try {
    const posthog = getPostHogClient();
    if (!posthog) return;

    posthog.capture({
      distinctId: input.userId,
      event: input.event,
      properties: {
        ...input.properties,
        account_id: input.accountId,
      },
      ...(input.dedupeKey
        ? { uuid: postHogEventUuid(input.dedupeKey) }
        : {}),
    });
  } catch (error) {
    console.error(`[posthog] ${input.event} capture failed (non-fatal):`, error);
  }
}
