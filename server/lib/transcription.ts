/**
 * Deepgram transcription for voice notes.
 *
 * Audio is NOT stored — the caller receives raw bytes, forwards them here,
 * and discards them. No S3, no DB row, no retention job.
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

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  if (!deepgram) {
    throw new Error("Transcription is not configured (DEEPGRAM_API_KEY missing)");
  }
  const response = await deepgram.listen.v1.media.transcribeFile(buffer, {
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
