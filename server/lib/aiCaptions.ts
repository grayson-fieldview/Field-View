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
 * HEIC/HEIF is NOT supported by the vision API directly, but the thumbnail
 * pipeline already WASM-decodes HEIC to a 400px JPEG at thumbUrl — so for
 * heic/heif rows the caption is generated from thumbUrl instead of url.
 * A heic/heif row with a null thumbUrl (thumbnail not generated yet — an
 * expected transient state on live upload) is skipped silently; the
 * thumbnail pipeline triggers the caption itself once thumbUrl is written
 * (see generateThumbnail). Other unsupported mimes (avif, video/*) are
 * still skipped. Native vision inputs: jpeg/png/gif/webp.
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

// HEIC/HEIF: not a native vision input, but captionable via the JPEG
// thumbnail rendition once thumbUrl exists.
const HEIC_MIME_TYPES = new Set(["image/heic", "image/heif"]);
export function isHeicMime(mimeType: string): boolean {
  return HEIC_MIME_TYPES.has(mimeType);
}

export const AI_CAPTION_SYSTEM_PROMPT = `You caption photos uploaded by trade contractors. Respond with exactly one plain sentence of 20-40 words describing what is visible: materials, surfaces, and equipment, in plain trade language. Do not describe or attempt to identify people. No preamble, no "This image shows", no marketing adjectives — just the sentence. Caption EVERY photo: contractors photograph finished rooms, empty spaces, renderings, product shots, paint swatches, driveways, equipment, invoices, and screenshots — not just active work. All of these get a normal descriptive sentence. Never return UNCLEAR because a photo isn't active trade work, isn't a construction scene, or seems unrelated to a job — describe what is actually visible. If the photo is a document, receipt, whiteboard, equipment label, or screenshot, transcribe the key visible text instead of describing the scene. UNCLEAR is ONLY for images with no discernible content: fully black, fully blank, or so blurred or overexposed that nothing can be made out. When returning UNCLEAR, return exactly that one word and nothing else — no explanation, no reasoning, no additional sentence.`;

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

export type CaptionSource = {
  id: number;
  url: string;
  mimeType: string;
  aiCaption?: string | null;
  thumbUrl?: string | null;
};

/**
 * Generate + store the AI caption for one media row. Returns true on
 * success; on ANY failure logs, reports to Sentry, and returns false
 * (ai_caption stays null). Never throws. Same contract as generateThumbnail.
 */
export async function generateCaption(row: CaptionSource): Promise<boolean> {
  try {
    // Idempotent: already captioned (incl. "UNCLEAR") — nothing to do.
    if (row.aiCaption != null) return false;

    // Pick the image source. HEIC/HEIF: the vision API can't read the
    // original, but the thumbnail pipeline's 400px JPEG rendition can be
    // used instead once it exists.
    let imageUrl: string;
    let imageSource: "url" | "thumbUrl";
    if (SUPPORTED_MIME_TYPES.has(row.mimeType)) {
      imageUrl = row.url;
      imageSource = "url";
    } else if (isHeicMime(row.mimeType)) {
      if (!row.thumbUrl) {
        // Expected transient state on live upload (thumbnail not written
        // yet) — the thumbnail pipeline will trigger the caption itself.
        // Debug-level only; NOT an error, no Sentry.
        console.debug(`[ai-captions] media ${row.id}: heic without thumbUrl yet, deferring to thumbnail pipeline`);
        return false;
      }
      imageUrl = row.thumbUrl;
      imageSource = "thumbUrl";
    } else {
      console.log(`[ai-captions] media ${row.id}: unsupported mime ${row.mimeType} (avif/video etc.), skipping`);
      return false;
    }
    // Auditable source line (backfill output shows url-vs-thumbUrl).
    console.log(`[ai-captions] media ${row.id}: captioning from ${imageSource} (${row.mimeType})`);

    const response = await getClient().messages.create({
      model: AI_CAPTION_MODEL,
      max_tokens: AI_CAPTION_MAX_TOKENS,
      system: AI_CAPTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "url", url: imageUrl } },
            { type: "text", text: "Caption this job site photo." },
          ],
        },
      ],
    });

    let text = response.content
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

    // Normalize the sentinel: the model sometimes appends reasoning prose
    // after UNCLEAR despite the prompt — store the bare sentinel and keep
    // prompt drift visible in logs.
    if (text.toUpperCase().startsWith("UNCLEAR")) {
      const trailing = text.slice("UNCLEAR".length).trim();
      if (text !== "UNCLEAR") {
        console.warn(
          `[ai-captions] media ${row.id}: normalized UNCLEAR sentinel, discarded trailing text: ${JSON.stringify(trailing)}`,
        );
      }
      text = "UNCLEAR";
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
  // Native vision mimes only. HEIC/HEIF is deliberately NOT queued here:
  // at route time thumbUrl is still null, and the thumbnail pipeline
  // triggers the caption itself right after writing thumbUrl (see
  // generateThumbnail) — queueing it here too would double-fire.
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
