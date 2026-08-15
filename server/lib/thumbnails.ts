/**
 * Server-side thumbnail renditions.
 *
 * Generates a 400px-wide JPEG (quality 70) for each image media row and
 * stores it at photos/thumbs/{same-basename}.jpg with a long immutable
 * Cache-Control (thumb keys are distinct and content-addressed by the
 * original's unique basename, so they never change in place).
 *
 * Deferral contract (same pattern as the CRM syncs / meta-capi):
 *  - queueThumbnailGeneration NEVER throws into the request path and never
 *    blocks the response — on Vercel the work is handed to waitUntil(); in
 *    local dev it runs as a dangling promise with swallowed rejection.
 *  - Per-photo failures log and leave thumb_url null. Clients already treat
 *    null as "use full url" (mobile falls back to its on-device cache).
 *
 * HEIC: sharp's prebuilt libvips has NO HEVC decoder (AVIF only — patent
 * licensing), so .heic objects are decoded to raw RGBA via the WASM
 * heic-decode package first (slow path, ~1–2s each — another reason this
 * must stay out of the request path). NOTE: the PDF pipeline and showcase
 * proxy still can't read HEIC — scoped as a separate task.
 */
import sharp from "sharp";
import { waitUntil } from "@vercel/functions";
import { eq } from "drizzle-orm";
import { Readable } from "stream";
import { db } from "../db";
import { media } from "@shared/schema";
import { getObjectStream, putObject, getS3Url, extractS3KeyFromUrl } from "../s3";
import { isHeicMime } from "./aiCaptions";

export const THUMB_WIDTH = 400;
export const THUMB_JPEG_QUALITY = 70;
export const THUMB_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const THUMB_PREFIX = "photos/thumbs/";

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function isHeic(key: string, mimeType: string): boolean {
  return /\.hei[cf]$/i.test(key) || mimeType === "image/heic" || mimeType === "image/heif";
}

export type ThumbSource = { id: number; url: string; mimeType: string };

/**
 * Generate + upload the thumbnail for one media row and set thumb_url.
 * Returns true on success; on ANY failure logs and returns false (thumb_url
 * stays null). Never throws.
 */
export async function generateThumbnail(row: ThumbSource): Promise<boolean> {
  try {
    if (!row.mimeType?.startsWith("image/")) return false; // videos etc.
    const key = extractS3KeyFromUrl(row.url);
    if (!key) {
      console.warn(`[thumbs] media ${row.id}: URL not recognized as ours, skipping`);
      return false;
    }

    const raw = await streamToBuffer(await getObjectStream(key));

    let pipeline: sharp.Sharp;
    if (isHeic(key, row.mimeType)) {
      // WASM decode (libheif applies the file's orientation/crop transforms
      // itself, so no .rotate() on the raw pixels).
      const { default: decode } = await import("heic-decode");
      const { width, height, data } = await decode({ buffer: raw });
      pipeline = sharp(Buffer.from(data), { raw: { width, height, channels: 4 } });
    } else {
      pipeline = sharp(raw).rotate(); // apply EXIF orientation
    }

    const thumb = await pipeline
      .resize(THUMB_WIDTH, null, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }) // JPEG has no alpha (png/webp inputs)
      .jpeg({ quality: THUMB_JPEG_QUALITY })
      .toBuffer();

    // Basename is `${Date.now()}-${8 random bytes hex}` (see getPresignedPutUrl)
    // — cross-folder collision would need the same millisecond AND the same
    // 64-bit random value, so a flat thumbs/ namespace is safe.
    const basename = key.split("/").pop()!.replace(/\.[^.]+$/, "");
    const thumbKey = `${THUMB_PREFIX}${basename}.jpg`;
    await putObject(thumbKey, thumb, "image/jpeg", THUMB_CACHE_CONTROL);

    const thumbUrl = getS3Url(thumbKey);
    await db.update(media).set({ thumbUrl }).where(eq(media.id, row.id));

    // HEIC/HEIF only: the route-level queueCaptionGeneration skips these
    // (no vision-readable source exists until this thumbUrl was just
    // written), so the caption is triggered here instead. Non-HEIC mimes
    // are already captioned from the route — adding them here would
    // double-fire. Own try/catch: a caption failure must never affect the
    // thumbnail result (generateCaption never throws, but do not rely on
    // that here).
    // NOTE: deliberately keyed on MIME only (isHeicMime), NOT isHeic(key,...):
    // the caption pipeline's source selection is MIME-based, so a .heic key
    // mislabeled image/jpeg is already queued at the route as native —
    // triggering it here too would double-fire a paid API call.
    if (isHeicMime(row.mimeType)) {
      try {
        const { generateCaption } = await import("./aiCaptions");
        await generateCaption({ id: row.id, url: row.url, mimeType: row.mimeType, thumbUrl, aiCaption: null });
      } catch (err) {
        console.warn(`[thumbs] media ${row.id}: heic caption trigger failed (thumbnail unaffected):`, (err as Error)?.message);
      }
    }
    return true;
  } catch (err) {
    console.warn(`[thumbs] generation failed for media ${row.id} (thumb_url stays null):`, (err as Error)?.message);
    return false;
  }
}

/**
 * Fire-and-forget batch generation. Sequential on purpose: a 40-photo batch
 * must not fan out 40 concurrent sharp pipelines in one serverless instance.
 */
export function queueThumbnailGeneration(rows: ThumbSource[]): void {
  const images = rows.filter((r) => r.mimeType?.startsWith("image/"));
  if (images.length === 0) return;
  const promise = (async () => {
    for (const row of images) {
      await generateThumbnail(row);
    }
  })().catch(() => {
    // generateThumbnail never throws; belt-and-suspenders.
  });
  try {
    // On Vercel, keep the instance alive until generation finishes.
    waitUntil(promise);
  } catch {
    // Local dev / non-Vercel request context: dangling promise is fine.
  }
}
