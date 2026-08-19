import assert from "node:assert/strict";
import test from "node:test";
import { computeCreditCycle } from "./aiCredits";

test("uses the most recent UTC anchor occurrence", () => {
  const anchor = new Date("2025-01-15T13:45:30.250Z");
  const cycle = computeCreditCycle(anchor, new Date("2026-08-15T12:00:00.000Z"));
  assert.equal(cycle.cycleStart.toISOString(), "2026-07-15T13:45:30.250Z");
  assert.equal(cycle.nextResetAt.toISOString(), "2026-08-15T13:45:30.250Z");
});

test("keeps the current occurrence once its UTC time has passed", () => {
  const anchor = new Date("2025-01-15T13:45:30.250Z");
  const cycle = computeCreditCycle(anchor, new Date("2026-08-19T14:00:00.000Z"));
  assert.equal(cycle.cycleStart.toISOString(), "2026-08-15T13:45:30.250Z");
  assert.equal(cycle.nextResetAt.toISOString(), "2026-09-15T13:45:30.250Z");
});

test("clamps a 31st anchor to the last day of shorter months", () => {
  const anchor = new Date("2024-01-31T10:00:00.000Z");
  const leapFebruary = computeCreditCycle(anchor, new Date("2024-02-29T11:00:00.000Z"));
  assert.equal(leapFebruary.cycleStart.toISOString(), "2024-02-29T10:00:00.000Z");
  assert.equal(leapFebruary.nextResetAt.toISOString(), "2024-03-31T10:00:00.000Z");

  const ordinaryFebruary = computeCreditCycle(anchor, new Date("2025-02-28T11:00:00.000Z"));
  assert.equal(ordinaryFebruary.cycleStart.toISOString(), "2025-02-28T10:00:00.000Z");
  assert.equal(ordinaryFebruary.nextResetAt.toISOString(), "2025-03-31T10:00:00.000Z");
});

test("rolls December into the next UTC year", () => {
  const anchor = new Date("2025-12-05T00:00:00.000Z");
  const cycle = computeCreditCycle(anchor, new Date("2026-12-20T00:00:00.000Z"));
  assert.equal(cycle.cycleStart.toISOString(), "2026-12-05T00:00:00.000Z");
  assert.equal(cycle.nextResetAt.toISOString(), "2027-01-05T00:00:00.000Z");
});