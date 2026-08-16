import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import path from "path";
import crypto from "crypto";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.AWS_S3_BUCKET || "fieldview-storage";
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN || "d14rk4r8qyh1ff.cloudfront.net";

export function getS3Url(key: string): string {
  return `https://${CLOUDFRONT_DOMAIN}/${key}`;
}

export async function getPresignedUrl(key: string): Promise<string> {
  return `https://${CLOUDFRONT_DOMAIN}/${key}`;
}

/**
 * Build an RFC 6266 inline Content-Disposition for an original filename.
 * ASCII-sanitized `filename` fallback plus RFC 5987 `filename*` so UTF-8
 * names survive. Inline so browsers preview (PDF viewer, image) instead of
 * blind-downloading.
 */
export function inlineContentDisposition(originalName: string): string {
  const ascii = originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(originalName).replace(/['()]/g, escape);
  return `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

export async function getPresignedPutUrl(
  originalName: string,
  mimeType: string,
  folder: string = "photos",
  contentLength?: number,
  contentDisposition?: string
): Promise<{ key: string; uploadUrl: string; publicUrl: string }> {
  const ext = path.extname(originalName);
  const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const key = `${folder}/${uniqueName}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: mimeType,
    ...(typeof contentLength === "number" ? { ContentLength: contentLength } : {}),
    // NOTE: when set, the signature covers Content-Disposition, so the client
    // performing the PUT must send the exact same Content-Disposition header
    // (returned to the client as `contentDisposition` by the sign endpoint).
    ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 600 });
  return { key, uploadUrl, publicUrl: getS3Url(key) };
}

/**
 * Real presigned S3 GET (direct to the bucket, signature in the query) —
 * unlike getPresignedUrl above, which returns a plain CloudFront URL. Used
 * where a third party (e.g. Deepgram) must fetch a short-lived, non-public
 * object such as transcription audio.
 */
export async function getPresignedGetUrl(key: string, expiresIn: number = 300): Promise<string> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn });
}

export function isS3Url(url: string): boolean {
  if (!url) return false;
  if (url.includes(CLOUDFRONT_DOMAIN)) return true;
  return url.includes(".s3.") && url.includes("amazonaws.com");
}

export async function uploadToS3(
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
  folder: string = "photos"
): Promise<{ key: string; url: string }> {
  const ext = path.extname(originalName);
  const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const key = `${folder}/${uniqueName}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
    })
  );

  return { key, url: getS3Url(key) };
}

/**
 * Put an object at an EXACT key (unlike uploadToS3, which generates one),
 * with optional Cache-Control. Used for derived renditions (thumbnails)
 * whose keys are deterministic and whose content is immutable.
 */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
  cacheControl?: string
): Promise<string> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(cacheControl ? { CacheControl: cacheControl } : {}),
    })
  );
  return getS3Url(key);
}

export async function deleteFromS3(key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
}

export async function getObjectStream(key: string): Promise<Readable> {
  const result = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!result.Body || typeof (result.Body as any).pipe !== "function") {
    throw new Error(`No readable body for S3 key: ${key}`);
  }
  return result.Body as Readable;
}

export function extractS3KeyFromUrl(url: string): string | null {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname === CLOUDFRONT_DOMAIN) {
      return urlObj.pathname.slice(1);
    }
    if (urlObj.hostname.includes(".s3.") && urlObj.hostname.endsWith("amazonaws.com")) {
      return urlObj.pathname.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}
