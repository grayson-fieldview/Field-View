import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

export async function getPresignedPutUrl(
  originalName: string,
  mimeType: string,
  folder: string = "photos"
): Promise<{ key: string; uploadUrl: string; publicUrl: string }> {
  const ext = path.extname(originalName);
  const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const key = `${folder}/${uniqueName}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: mimeType,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 600 });
  return { key, uploadUrl, publicUrl: getS3Url(key) };
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

export async function deleteFromS3(key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    })
  );
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
