/**
 * AI photo captions (Claude vision).
 *
 * Fills media.ai_caption with a single plain-trade-language sentence for each
 * uploaded photo. Structurally mirrors server/lib/thumbnails.ts:
 *
 * Deferral contract (same pattern as thumbnails / CRM syncs / meta-capi):
 *  - queueCaptionGeneration NEVER throws into the request path and never
 *    blocks the response — on Vercel the work is handed to waitUntil(); in
 *    local dev it runs as a dangling promise with swallowed rejection.
 *  - Per-photo failures log + report to Sentry and leave ai_caption null
 *    (a later backfill run retries NULL rows).
 *  - "UNCLEAR" (unusable photo) IS written to ai_caption so the row is not
 *    retried indefinitely.
 *
 * The image is passed to the API as a URL source block — media.url is a
 * public unsigned CloudFront URL, so Anthropic fetches the bytes directly
 * and no image download/base64 happens in our process.
 *
 * HEIC is NOT supported by the vision API — logged and skipped in this
 * phase (no conversion attempt). Supported: jpeg/png/gif/webp only.
 */
import Anthropic from "@anthropic-ai/sdk";
import { waitUntil } from "@vercel/functions";
import { eq, isNull, and } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "../db";
import { media } from "@shared/schema";
import { Sentry } from "./sentry";

export const AI_CAPTION_MODEL = "claude-haiku-4-5";
export const AI_CAPTION_MAX_TOKENS = 150;
export const AI_CAPTION_CONCURRENCY = 5;

// Mime types the Anthropic vision API accepts as URL image sources.
const SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const AI_CAPTION_SYSTEM_PROMPT = `You caption trade contractor job site photos. Respond with exactly one plain sentence of 20-40 words describing the work visible in the photo: the materials, surfaces, and equipment, in plain trade language. Do not describe or attempt to identify people. No preamble, no "This image shows", no marketing adjectives — just the sentence. If the photo is a document, receipt, whiteboard, or equipment label, transcribe the key visible text instead of describing the scene. If the photo is unusable (blurry, dark, featureless), return exactly: UNCLEAR`;

// Module-scope lazy client (mirrors the cached-client pattern elsewhere):
// import never throws; a missing key fails per-row inside generateCaption.
let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

export type CaptionSource = { id: number; url: string; mimeType: string; aiCaption?: string | null };

/**
 * Generate + store the AI caption for one media row. Returns true on
 * success; on ANY failure logs, reports to Sentry, and returns false
 * (ai_caption stays null). Never throws. Same contract as generateThumbnail.
 */
export async function generateCaption(row: CaptionSource): Promise<boolean> {
  try {
    // Idempotent: already captioned (incl. "UNCLEAR") — nothing to do.
    if (row.aiCaption != null) return false;
    if (!SUPPORTED_MIME_TYPES.has(row.mimeType)) {
      console.log(`[ai-captions] media ${row.id}: unsupported mime ${row.mimeType} (HEIC/video etc.), skipping`);
      return false;
    }

    const response = await getClient().messages.create({
      model: AI_CAPTION_MODEL,
      max_tokens: AI_CAPTION_MAX_TOKENS,
      system: AI_CAPTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: row.url } },
            { type: "text", text: "Caption this job site photo." },
          ],
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (!text) {
      // Semantic failure (refusal / no text blocks) — still a reportable
      // failure even though no exception was thrown: without this, model-
      // level failures are invisible to monitoring.
      console.warn(`[ai-captions] media ${row.id}: empty model response (ai_caption stays null)`);
      try {
        Sentry.captureMessage("ai-captions: empty model response", {
          level: "warning",
          tags: { source: "ai_captions" },
          extra: { mediaId: row.id, stopReason: response.stop_reason },
        });
      } catch {
        // Sentry must never break the never-throws contract.
      }
      return false;
    }

    // "UNCLEAR" is written too, so unusable photos are not retried forever.
    // Guard the row again in the WHERE (ai_caption IS NULL) so a concurrent
    // backfill + upload-path race can't overwrite an existing caption.
    await db
      .update(media)
      .set({ aiCaption: text, aiCaptionGeneratedAt: new Date(), aiCaptionModel: AI_CAPTION_MODEL })
      .where(and(eq(media.id, row.id), isNull(media.aiCaption)));
    return true;
  } catch (err) {
    console.warn(`[ai-captions] generation failed for media ${row.id} (ai_caption stays null):`, (err as Error)?.message);
    try {
      Sentry.captureException(err, { tags: { source: "ai_captions" }, extra: { mediaId: row.id } });
    } catch {
      // Sentry must never break the never-throws contract.
    }
    return false;
  }
}

/**
 * Fire-and-forget batch generation. Concurrency-limited to 5 (p-limit) —
 * NOT sequential: a full MAX_UPLOAD_BATCH at ~2-4s per caption would blow
 * past api/index.js's 60s maxDuration sequentially, and the work here is
 * network-bound API calls, not local sharp pipelines.
 */
export function queueCaptionGeneration(rows: CaptionSource[]): void {
  const images = rows.filter((r) => SUPPORTED_MIME_TYPES.has(r.mimeType));
  if (images.length === 0) return;
  const limit = pLimit(AI_CAPTION_CONCURRENCY);
  const promise = Promise.all(images.map((row) => limit(() => generateCaption(row)))).catch(() => {
    // generateCaption never throws; belt-and-suspenders.
  });
  try {
    // On Vercel, keep the instance alive until generation finishes.
    waitUntil(promise);
  } catch {
    // Local dev / non-Vercel request context: dangling promise is fine.
  }
}
