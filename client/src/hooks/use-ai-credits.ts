import { useQuery } from "@tanstack/react-query";

export const AI_CREDITS_QUERY_KEY = ["/api/credits"] as const;
export const INSUFFICIENT_AI_CREDITS_CODE = "INSUFFICIENT_AI_CREDITS";

export type AiCredits = {
  monthly_remaining: number;
  purchased_remaining: number;
  cycle_start: string;
  next_reset_at: string;
};

export function useAiCredits() {
  return useQuery<AiCredits>({ queryKey: AI_CREDITS_QUERY_KEY });
}

export function formatCreditReset(nextResetAt: string | undefined): string | null {
  if (!nextResetAt) return null;
  const resetAt = new Date(nextResetAt);
  if (Number.isNaN(resetAt.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(resetAt);
}

export function getInsufficientAiCreditsError(
  error: Error,
): { nextResetAt?: string } | null {
  const match = error.message.match(/^(\d+):\s*([\s\S]*)$/);
  if (!match || Number(match[1]) !== 402) return null;
  try {
    const body = JSON.parse(match[2]);
    if (body?.code !== INSUFFICIENT_AI_CREDITS_CODE) return null;
    return {
      nextResetAt:
        typeof body.next_reset_at === "string" ? body.next_reset_at : undefined,
    };
  } catch {
    return null;
  }
}