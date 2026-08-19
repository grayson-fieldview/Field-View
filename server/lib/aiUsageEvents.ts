import { db } from "../db";
import { aiUsageEvents } from "@shared/schema";
import { Sentry } from "./sentry";
import {
  calculateAnthropicCostUsd,
  calculateDeepgramCostUsd,
} from "./aiCost";

export type AiUsageFeature =
  | "report_generation"
  | "walkthrough_generation"
  | "checklist_generation"
  | "caption"
  | "translation"
  | "transcription";

export type AiUsageAttribution = {
  accountId: string;
  userId: string | null;
};

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requestIdFromError(error: any): string | null {
  const headers = error?.headers;
  const rawHeaders = error?.rawResponse?.headers;
  return (
    stringValue(error?._request_id) ??
    stringValue(error?.requestID) ??
    stringValue(error?.request_id) ??
    stringValue(error?.requestId) ??
    stringValue(error?.body?.request_id) ??
    stringValue(error?.body?.requestId) ??
    stringValue(headers?.get?.("request-id")) ??
    stringValue(headers?.get?.("x-request-id")) ??
    stringValue(rawHeaders?.get?.("request-id")) ??
    stringValue(rawHeaders?.get?.("x-request-id")) ??
    stringValue(headers?.["request-id"]) ??
    stringValue(headers?.["x-request-id"]) ??
    stringValue(rawHeaders?.["request-id"]) ??
    stringValue(rawHeaders?.["x-request-id"])
  );
}

function errorCodeFromError(error: any): string {
  return (
    stringValue(error?.error?.type) ??
    stringValue(error?.code) ??
    (typeof error?.status === "number" ? `http_${error.status}` : null) ??
    stringValue(error?.name) ??
    "unknown_error"
  );
}

async function insertAiUsageEvent(values: typeof aiUsageEvents.$inferInsert): Promise<void> {
  try {
    await db.insert(aiUsageEvents).values(values);
  } catch (err) {
    console.error("[ai-usage-events] failed to insert provider-call event:", (err as Error)?.message);
    try {
      Sentry.captureException(err, {
        tags: {
          source: "ai_usage_events",
          provider: values.provider,
          feature: values.feature,
        },
        extra: {
          accountId: values.accountId,
          userId: values.userId,
          model: values.model,
          success: values.success,
        },
      });
    } catch {
      // Telemetry must never mask or alter the provider call's outcome.
    }
  }
}

export async function recordAnthropicUsageEvent(input: {
  attribution: AiUsageAttribution;
  feature: AiUsageFeature;
  model: string;
  response?: any;
  error?: unknown;
  imageCount?: number | null;
}): Promise<void> {
  const usage = input.response?.usage;
  const inputTokens = nonNegativeInteger(usage?.input_tokens);
  const outputTokens = nonNegativeInteger(usage?.output_tokens);
  const cacheCreationTokens = usage
    ? (nonNegativeInteger(usage.cache_creation_input_tokens) ?? 0)
    : null;
  const cacheReadTokens = usage
    ? (nonNegativeInteger(usage.cache_read_input_tokens) ?? 0)
    : null;
  const completeUsage =
    inputTokens !== null &&
    outputTokens !== null &&
    cacheCreationTokens !== null &&
    cacheReadTokens !== null
      ? { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }
      : null;
  const cost = completeUsage
    ? calculateAnthropicCostUsd(input.model, completeUsage)
    : null;

  await insertAiUsageEvent({
    accountId: input.attribution.accountId,
    userId: input.attribution.userId,
    feature: input.feature,
    provider: "anthropic",
    model: input.model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    audioSeconds: null,
    imageCount: input.imageCount ?? null,
    success: input.error === undefined,
    errorCode: input.error === undefined ? null : errorCodeFromError(input.error),
    providerRequestId:
      stringValue(input.response?._request_id) ??
      (input.error === undefined ? null : requestIdFromError(input.error)),
    costUsd: cost === null ? null : cost.toFixed(6),
  });
}

export async function recordDeepgramUsageEvent(input: {
  attribution: AiUsageAttribution;
  feature: AiUsageFeature;
  model: string;
  response?: any;
  error?: unknown;
  durationSeconds?: number | null;
}): Promise<void> {
  const durationSeconds =
    input.error === undefined &&
    typeof input.durationSeconds === "number" &&
    Number.isFinite(input.durationSeconds) &&
    input.durationSeconds >= 0
      ? input.durationSeconds
      : null;
  const audioSeconds =
    durationSeconds === null ? null : durationSeconds.toFixed(3);
  const cost =
    durationSeconds === null
      ? null
      : calculateDeepgramCostUsd(input.model, durationSeconds);

  await insertAiUsageEvent({
    accountId: input.attribution.accountId,
    userId: input.attribution.userId,
    feature: input.feature,
    provider: "deepgram",
    model: input.model,
    inputTokens: null,
    outputTokens: null,
    cacheCreationTokens: null,
    cacheReadTokens: null,
    audioSeconds,
    imageCount: null,
    success: input.error === undefined,
    errorCode: input.error === undefined ? null : errorCodeFromError(input.error),
    providerRequestId:
      stringValue(input.response?.metadata?.request_id) ??
      stringValue(input.response?.metadata?.requestId) ??
      (input.error === undefined ? null : requestIdFromError(input.error)),
    costUsd: cost === null ? null : cost.toFixed(6),
  });
}