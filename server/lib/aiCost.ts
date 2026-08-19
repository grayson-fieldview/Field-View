type AnthropicRate = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
};

export type AnthropicUsageCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

// USD per one million tokens. Verified against the official Claude Platform
// list-price table on 2026-08-19. Report caching uses the default 5-minute
// ephemeral write rate.
// Source: https://platform.claude.com/docs/en/about-claude/pricing
export const ANTHROPIC_RATES_USD_PER_MILLION_TOKENS: Record<string, AnthropicRate> = {
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheCreation: 3.75,
    cacheRead: 0.3,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cacheCreation: 1.25,
    cacheRead: 0.1,
  },
};

// USD per minute for the Deepgram pre-recorded/batch API (S3/object URL →
// Deepgram), monolingual Nova-3. This is intentionally NOT the streaming
// rate. Verified on 2026-08-19.
// Source: https://deepgram.com/pricing
export const DEEPGRAM_RATES_USD_PER_MINUTE: Record<string, number> = {
  "nova-3": 0.0043,
};

export function calculateAnthropicCostUsd(
  model: string,
  usage: AnthropicUsageCounts,
): number | null {
  const rate = ANTHROPIC_RATES_USD_PER_MILLION_TOKENS[model];
  if (!rate) return null;
  return (
    usage.inputTokens * rate.input +
    usage.outputTokens * rate.output +
    usage.cacheCreationTokens * rate.cacheCreation +
    usage.cacheReadTokens * rate.cacheRead
  ) / 1_000_000;
}

export function calculateDeepgramCostUsd(
  model: string,
  audioSeconds: number,
): number | null {
  const rate = DEEPGRAM_RATES_USD_PER_MINUTE[model];
  if (rate === undefined) return null;
  return (audioSeconds / 60) * rate;
}