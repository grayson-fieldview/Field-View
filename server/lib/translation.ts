/**
 * On-demand comment translation (Claude).
 *
 * Auto-target: English source → Spanish, anything else → English. The
 * caller never picks a language. Nothing is persisted — the client caches
 * the result in component state.
 *
 * Module-scope lazy Anthropic client — same pattern as aiCaptions.ts:
 * import never throws; a missing key fails per-request inside translateText.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  recordAnthropicUsageEvent,
  type AiUsageAttribution,
} from "./aiUsageEvents";

export const TRANSLATION_MODEL = "claude-haiku-4-5";
export const TRANSLATION_MAX_TOKENS = 1000;

export const TRANSLATION_SYSTEM_PROMPT = `Detect the language of the text. If it is English, translate it to Spanish. If it is any other language, translate it to English. Return ONLY the translation — no preamble, no quotes, no explanation, no notes about the source language. Preserve trade terminology and keep the register plain and practical.`;

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

/**
 * Translate one text. Throws on API failure — the route decides the
 * user-facing response (classifyAnthropicApiError, then generic 503).
 */
export async function translateText(
  text: string,
  attribution: AiUsageAttribution,
): Promise<string> {
  let response: Anthropic.Message;
  try {
    response = await getClient().messages.create({
      model: TRANSLATION_MODEL,
      max_tokens: TRANSLATION_MAX_TOKENS,
      system: TRANSLATION_SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });
  } catch (error) {
    await recordAnthropicUsageEvent({
      attribution,
      feature: "translation",
      model: TRANSLATION_MODEL,
      error,
    });
    throw error;
  }
  await recordAnthropicUsageEvent({
    attribution,
    feature: "translation",
    model: TRANSLATION_MODEL,
    response,
  });
  const block = response.content.find((b) => b.type === "text");
  const translation = block && block.type === "text" ? block.text.trim() : "";
  if (!translation) throw new Error("Empty translation response");
  return translation;
}
