import sharp from "sharp";
import pLimit from "p-limit";
import { Readable } from "stream";
import { getObjectStream } from "../s3";

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

export async function fetchAndResize(keys: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const unique = Array.from(new Set(keys.filter(Boolean)));
  const limit = pLimit(10);
  await Promise.all(
    unique.map((key) =>
      limit(async () => {
        try {
          const stream = await getObjectStream(key);
          const raw = await streamToBuffer(stream);
          const resized = await sharp(raw)
            .rotate()
            .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 80 })
            .toBuffer();
          out.set(key, resized);
        } catch (e) {
          console.warn("[pdf] image skip", key, (e as Error).message);
        }
      }),
    ),
  );
  return out;
}
