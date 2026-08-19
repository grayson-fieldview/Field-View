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
import {
  recordDeepgramUsageEvent,
  type AiUsageAttribution,
} from "./aiUsageEvents";

const API_KEY = process.env.DEEPGRAM_API_KEY;
export const DEEPGRAM_TRANSCRIPTION_MODEL = "nova-3";

if (!API_KEY) {
  console.warn("[transcription] DEEPGRAM_API_KEY not set — voice note transcription will not work");
}

const deepgram: DeepgramClient | null = API_KEY ? new DeepgramClient({ apiKey: API_KEY }) : null;

export async function transcribeAudioFromUrl(
  url: string,
  attribution: AiUsageAttribution,
): Promise<{ transcript: string; durationSeconds: number | null }> {
  let response: any;
  try {
    if (!deepgram) {
      throw new Error("Transcription is not configured (DEEPGRAM_API_KEY missing)");
    }
    // URL source — Deepgram fetches the audio itself; bytes never pass
    // through our serverless function (Vercel caps request bodies at 4.5MB).
    response = await deepgram.listen.v1.media.transcribeUrl({
      url,
      model: DEEPGRAM_TRANSCRIPTION_MODEL,
      smart_format: true,
      punctuate: true,
      language: "en",
    });
  } catch (error) {
    await recordDeepgramUsageEvent({
      attribution,
      feature: "transcription",
      model: DEEPGRAM_TRANSCRIPTION_MODEL,
      error,
    });
    throw error;
  }

  // metadata.duration = seconds of audio Deepgram processed (what it bills
  // on) — used by the caller to reconcile the minutes-based usage bucket.
  const rawDuration = response?.metadata?.duration;
  const durationSeconds =
    typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration >= 0
      ? rawDuration
      : null;
  await recordDeepgramUsageEvent({
    attribution,
    feature: "transcription",
    model: DEEPGRAM_TRANSCRIPTION_MODEL,
    response,
    durationSeconds,
  });

  // The sync endpoint returns ListenV1Response; ListenV1AcceptedResponse only
  // occurs with callback-based (async) requests, which we never make.
  const transcript = response?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") {
    throw new Error("Deepgram returned no transcript");
  }
  return { transcript: transcript.trim(), durationSeconds };
}
