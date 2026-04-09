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

export function getS3Url(key: string): string {
  return `https://${BUCKET}.s3.${process.env.AWS_REGION || "us-east-2"}.amazonaws.com/${key}`;
}

export async function getPresignedUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

export function isS3Url(url: string): boolean {
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
  if (!url.includes(".s3.")) return null;
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.slice(1);
  } catch {
    return null;
  }
}
