import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { accounts } from "@shared/models/auth";
import { accountCreditBalances, creditLedger } from "@shared/schema";
import { db, pool } from "../db";
import {
  MONTHLY_AI_CREDITS,
  getAccountCreditSnapshot,
  refundGenerationCredit,
  reserveGenerationCredit,
} from "./aiCredits";

const runDbTests = process.env.RUN_AI_CREDITS_DB_TESTS === "1";
const integrationTest = runDbTests ? test : test.skip;
const accountIds: string[] = [];

after(async () => {
  if (accountIds.length > 0) {
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
  await pool.end();
});

async function createTestAccount(anchorAt: Date): Promise<string> {
  const id = randomUUID();
  // The development DB intentionally lags several unrelated account columns,
  // so keep this fixture insert scoped to the credit test's actual contract.
  await db.execute(sql`
    INSERT INTO accounts (id, name, credits_anchor_at)
    VALUES (${id}, ${`AI credit test ${id}`}, ${anchorAt})
  `);
  accountIds.push(id);
  return id;
}

integrationTest("initializes a full first cycle and grants only once", async () => {
  const now = new Date("2026-08-19T12:00:00.000Z");
  const accountId = await createTestAccount(new Date("2026-08-10T12:00:00.000Z"));

  const [first, second] = await Promise.all([
    getAccountCreditSnapshot(accountId, now),
    getAccountCreditSnapshot(accountId, now),
  ]);
  assert.equal(first.monthlyRemaining, MONTHLY_AI_CREDITS);
  assert.equal(second.monthlyRemaining, MONTHLY_AI_CREDITS);

  const grants = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(sql`${creditLedger.accountId} = ${accountId} AND ${creditLedger.kind} = 'monthly_grant'`);
  assert.equal(grants.length, 1);
});

integrationTest("rolls a dormant account once, not once per missed month", async () => {
  const accountId = await createTestAccount(new Date("2026-01-31T10:00:00.000Z"));
  const oldCycleDebit = await reserveGenerationCredit({
    accountId,
    userId: null,
    feature: "report_generation",
    operationId: `dormant-${accountId}`,
    now: new Date("2026-01-31T11:00:00.000Z"),
  });
  assert.equal(oldCycleDebit.admitted, true);

  const snapshot = await getAccountCreditSnapshot(accountId, new Date("2026-05-31T11:00:00.000Z"));
  assert.equal(snapshot.monthlyRemaining, MONTHLY_AI_CREDITS);
  assert.equal(snapshot.cycleStart.toISOString(), "2026-05-31T10:00:00.000Z");

  const grants = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(sql`${creditLedger.accountId} = ${accountId} AND ${creditLedger.kind} = 'monthly_grant'`);
  assert.equal(grants.length, 2);

  const [ledgerTotal] = await db
    .select({ total: sql<number>`COALESCE(SUM(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.accountId, accountId));
  assert.equal(Number(ledgerTotal.total), MONTHLY_AI_CREDITS);
});

integrationTest("admits exactly the available concurrent debits", async () => {
  const accountId = await createTestAccount(new Date("2026-08-01T00:00:00.000Z"));
  const now = new Date("2026-08-19T00:00:00.000Z");

  const results = await Promise.all(
    Array.from({ length: MONTHLY_AI_CREDITS + 1 }, (_, index) =>
      reserveGenerationCredit({
        accountId,
        userId: null,
        feature: "report_generation",
        operationId: `concurrent-${accountId}-${index}`,
        now,
      }),
    ),
  );
  assert.equal(results.filter((result) => result.admitted).length, MONTHLY_AI_CREDITS);
  assert.equal(results.filter((result) => !result.admitted).length, 1);

  const snapshot = await getAccountCreditSnapshot(accountId, now);
  assert.equal(snapshot.monthlyRemaining, 0);
  assert.equal(snapshot.purchasedRemaining, 0);
});

integrationTest("spends monthly first, falls back to purchased, and refunds once", async () => {
  const accountId = await createTestAccount(new Date("2026-08-01T00:00:00.000Z"));
  const now = new Date("2026-08-19T00:00:00.000Z");
  await getAccountCreditSnapshot(accountId, now);
  await db
    .update(accountCreditBalances)
    .set({ monthlyRemaining: 1, purchasedRemaining: 1 })
    .where(eq(accountCreditBalances.accountId, accountId));

  const monthly = await reserveGenerationCredit({
    accountId,
    userId: null,
    feature: "report_generation",
    operationId: `monthly-${accountId}`,
    now,
  });
  assert.equal(monthly.admitted, true);
  if (!monthly.admitted) return;
  assert.equal(monthly.reservation.spentFrom, "monthly");

  const purchased = await reserveGenerationCredit({
    accountId,
    userId: null,
    feature: "walkthrough_generation",
    operationId: `purchased-${accountId}`,
    now,
  });
  assert.equal(purchased.admitted, true);
  if (!purchased.admitted) return;
  assert.equal(purchased.reservation.spentFrom, "purchased");

  const denied = await reserveGenerationCredit({
    accountId,
    userId: null,
    feature: "report_generation",
    operationId: `denied-${accountId}`,
    now,
  });
  assert.equal(denied.admitted, false);

  assert.deepEqual(await refundGenerationCredit(purchased.reservation), { refunded: true });
  assert.deepEqual(await refundGenerationCredit(purchased.reservation), { refunded: false });

  const snapshot = await getAccountCreditSnapshot(accountId, now);
  assert.equal(snapshot.monthlyRemaining, 0);
  assert.equal(snapshot.purchasedRemaining, 1);
});

integrationTest("replays an active debit operation without charging twice", async () => {
  const accountId = await createTestAccount(new Date("2026-08-01T00:00:00.000Z"));
  const now = new Date("2026-08-19T00:00:00.000Z");
  const operationId = `replay-${accountId}`;

  const first = await reserveGenerationCredit({
    accountId,
    userId: null,
    feature: "report_generation",
    operationId,
    now,
  });
  const replay = await reserveGenerationCredit({
    accountId,
    userId: null,
    feature: "report_generation",
    operationId,
    now,
  });

  assert.equal(first.admitted, true);
  assert.equal(replay.admitted, true);
  if (!first.admitted || !replay.admitted) return;
  assert.equal(replay.reservation.spentFrom, first.reservation.spentFrom);

  const snapshot = await getAccountCreditSnapshot(accountId, now);
  assert.equal(snapshot.monthlyRemaining, MONTHLY_AI_CREDITS - 1);

  const debits = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(sql`${creditLedger.accountId} = ${accountId} AND ${creditLedger.kind} = 'debit'`);
  assert.equal(debits.length, 1);
});

integrationTest("late monthly refund does not inflate the next cycle", async () => {
  const accountId = await createTestAccount(new Date("2026-01-31T10:00:00.000Z"));
  const oldNow = new Date("2026-01-31T11:00:00.000Z");
  const debit = await reserveGenerationCredit({
    accountId,
    userId: null,
    feature: "report_generation",
    operationId: `late-refund-${accountId}`,
    now: oldNow,
  });
  assert.equal(debit.admitted, true);
  if (!debit.admitted) return;

  const nextCycle = await getAccountCreditSnapshot(
    accountId,
    new Date("2026-02-28T11:00:00.000Z"),
  );
  assert.equal(nextCycle.monthlyRemaining, MONTHLY_AI_CREDITS);

  assert.deepEqual(await refundGenerationCredit(debit.reservation), { refunded: true });
  const afterRefund = await getAccountCreditSnapshot(
    accountId,
    new Date("2026-02-28T11:00:00.000Z"),
  );
  assert.equal(afterRefund.monthlyRemaining, MONTHLY_AI_CREDITS);

  const [ledgerTotal] = await db
    .select({ total: sql<number>`COALESCE(SUM(${creditLedger.delta}), 0)` })
    .from(creditLedger)
    .where(eq(creditLedger.accountId, accountId));
  assert.equal(Number(ledgerTotal.total), MONTHLY_AI_CREDITS);
});