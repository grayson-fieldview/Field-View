import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateAnthropicCostUsd,
  calculateDeepgramCostUsd,
} from "./aiCost";

test("calculates Claude Sonnet 4.6 input, output, and cache costs", () => {
  assert.equal(
    calculateAnthropicCostUsd("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    }),
    22.05,
  );
});

test("calculates Claude Haiku 4.5 input, output, and cache costs", () => {
  assert.equal(
    calculateAnthropicCostUsd("claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    }),
    7.35,
  );
});

test("calculates pre-recorded Nova-3 at $0.0043 per minute", () => {
  assert.equal(calculateDeepgramCostUsd("nova-3", 60), 0.0043);
});

test("preserves fractional seconds in sub-minute Nova-3 costs", () => {
  const expected = (15.5 / 60) * 0.0043;
  assert.equal(calculateDeepgramCostUsd("nova-3", 15.5), expected);
});

test("returns null for models without a configured rate", () => {
  assert.equal(
    calculateAnthropicCostUsd("unknown", {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }),
    null,
  );
  assert.equal(calculateDeepgramCostUsd("unknown", 60), null);
});