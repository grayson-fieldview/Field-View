/**
 * Deepgram transcription for voice notes.
 *
 * Audio is NOT retained — the client uploads to S3 (presigned PUT, "audio/"
 * prefix), we hand Deepgram a short-lived presigned GET URL, and the route
 * deletes the object after transcription (success or failure). No DB row,
 * no retention job. Bytes never pass through our serverless function.
 *
 * Key handling follows server/services/email.ts: module-scope inline
 * process.env read, warn if missing, null client.
 */
import { DeepgramClient } from "@deepgram/sdk";

const API_KEY = process.env.DEEPGRAM_API_KEY;

if (!API_KEY) {
  console.warn("[transcription] DEEPGRAM_API_KEY not set — voice note transcription will not work");
}

const deepgram: DeepgramClient | null = API_KEY ? new DeepgramClient({ apiKey: API_KEY }) : null;

export async function transcribeAudioFromUrl(url: string): Promise<string> {
  if (!deepgram) {
    throw new Error("Transcription is not configured (DEEPGRAM_API_KEY missing)");
  }
  // URL source — Deepgram fetches the audio itself; bytes never pass
  // through our serverless function (Vercel caps request bodies at 4.5MB).
  const response = await deepgram.listen.v1.media.transcribeUrl({
    url,
    model: "nova-3",
    smart_format: true,
    punctuate: true,
    language: "en",
  });
  // The sync endpoint returns ListenV1Response; ListenV1AcceptedResponse only
  // occurs with callback-based (async) requests, which we never make.
  const transcript = (response as any)?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") {
    throw new Error("Deepgram returned no transcript");
  }
  return transcript.trim();
}
