import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { accounts } from "@shared/models/auth";
import {
  accountCreditBalances,
  creditLedger,
} from "@shared/schema";
import { db } from "../db";

export const MONTHLY_AI_CREDITS = 15;
export const INSUFFICIENT_AI_CREDITS_CODE = "INSUFFICIENT_AI_CREDITS";

export type CreditFeature = "report_generation" | "walkthrough_generation";
export type CreditBucket = "monthly" | "purchased";

export type CreditReservation = {
  operationId: string;
  accountId: string;
  userId: string | null;
  feature: CreditFeature;
  refType: string | null;
  refId: number | null;
  cycleStart: Date;
  spentFrom: CreditBucket;
};

export type CreditSnapshot = {
  monthlyRemaining: number;
  purchasedRemaining: number;
  cycleStart: Date;
  nextResetAt: Date;
};

type CreditCycle = {
  cycleStart: Date;
  nextResetAt: Date;
};

type PreparedBalance = CreditSnapshot & {
  anchorAt: Date;
};

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function anchorOccurrence(anchorAt: Date, year: number, month: number): Date {
  const day = Math.min(anchorAt.getUTCDate(), daysInUtcMonth(year, month));
  return new Date(Date.UTC(
    year,
    month,
    day,
    anchorAt.getUTCHours(),
    anchorAt.getUTCMinutes(),
    anchorAt.getUTCSeconds(),
    anchorAt.getUTCMilliseconds(),
  ));
}

/** Current and next UTC credit-cycle boundaries for an immutable anchor. */
export function computeCreditCycle(anchorAt: Date, now: Date = new Date()): CreditCycle {
  if (!Number.isFinite(anchorAt.getTime()) || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid credit cycle timestamp");
  }

  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let cycleStart = anchorOccurrence(anchorAt, year, month);
  if (cycleStart.getTime() > now.getTime()) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    cycleStart = anchorOccurrence(anchorAt, year, month);
  }

  let nextMonth = month + 1;
  let nextYear = year;
  if (nextMonth > 11) {
    nextMonth = 0;
    nextYear += 1;
  }

  return {
    cycleStart,
    nextResetAt: anchorOccurrence(anchorAt, nextYear, nextMonth),
  };
}

function monthlyGrantKey(accountId: string, cycleStart: Date): string {
  return `credits:monthly-grant:${accountId}:${cycleStart.toISOString()}`;
}

async function appendMonthlyGrant(
  tx: any,
  accountId: string,
  cycleStart: Date,
): Promise<void> {
  await tx
    .insert(creditLedger)
    .values({
      accountId,
      userId: null,
      delta: MONTHLY_AI_CREDITS,
      kind: "monthly_grant",
      bucket: "monthly",
      feature: null,
      refType: null,
      refId: null,
      idempotencyKey: monthlyGrantKey(accountId, cycleStart),
      cycleStart,
    })
    .onConflictDoNothing({ target: creditLedger.idempotencyKey });
}

async function appendMonthlyExpiration(
  tx: any,
  input: {
    accountId: string;
    amount: number;
    cycleStart: Date;
    idempotencyKey: string;
    userId?: string | null;
    feature?: CreditFeature | null;
    refType?: string | null;
    refId?: number | null;
  },
): Promise<void> {
  if (input.amount <= 0) return;
  await tx.insert(creditLedger).values({
    accountId: input.accountId,
    userId: input.userId ?? null,
    delta: -input.amount,
    kind: "monthly_expiration",
    bucket: "monthly",
    feature: input.feature ?? null,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    idempotencyKey: input.idempotencyKey,
    cycleStart: input.cycleStart,
  });
}

/**
 * Initialize or lazily roll an account's balance inside the caller's
 * transaction. INSERT ... ON CONFLICT handles first-use races; the conditional
 * UPDATE lets exactly one concurrent request perform a rollover and ledger
 * grant.
 */
async function prepareCurrentBalance(
  tx: any,
  accountId: string,
  now: Date,
): Promise<PreparedBalance> {
  const [account] = await tx
    .select({ creditsAnchorAt: accounts.creditsAnchorAt })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) {
    throw new Error(`Account ${accountId} not found while preparing AI credits`);
  }

  const anchorAt = new Date(account.creditsAnchorAt);
  const cycle = computeCreditCycle(anchorAt, now);

  const inserted = await tx
    .insert(accountCreditBalances)
    .values({
      accountId,
      cycleStart: cycle.cycleStart,
      monthlyRemaining: MONTHLY_AI_CREDITS,
      purchasedRemaining: 0,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: accountCreditBalances.accountId })
    .returning({ accountId: accountCreditBalances.accountId });
  if (inserted.length > 0) {
    await appendMonthlyGrant(tx, accountId, cycle.cycleStart);
  }

  const rolloverResult = await tx.execute(sql`
    WITH stale AS (
      SELECT
        account_id,
        cycle_start AS old_cycle_start,
        monthly_remaining AS expired_monthly
      FROM account_credit_balances
      WHERE account_id = ${accountId}
        AND cycle_start < ${cycle.cycleStart}
      FOR UPDATE
    )
    UPDATE account_credit_balances AS balance
    SET
      cycle_start = ${cycle.cycleStart},
      monthly_remaining = ${MONTHLY_AI_CREDITS},
      updated_at = ${now}
    FROM stale
    WHERE balance.account_id = stale.account_id
    RETURNING
      stale.old_cycle_start AS "oldCycleStart",
      stale.expired_monthly AS "expiredMonthly"
  `);
  const rollover = rolloverResult.rows[0] as {
    oldCycleStart: Date;
    expiredMonthly: number;
  } | undefined;
  if (rollover) {
    await appendMonthlyExpiration(tx, {
      accountId,
      amount: rollover.expiredMonthly,
      cycleStart: new Date(rollover.oldCycleStart),
      idempotencyKey:
        `credits:monthly-expiration:${accountId}:${new Date(rollover.oldCycleStart).toISOString()}`,
    });
    await appendMonthlyGrant(tx, accountId, cycle.cycleStart);
  }

  const [balance] = await tx
    .select({
      monthlyRemaining: accountCreditBalances.monthlyRemaining,
      purchasedRemaining: accountCreditBalances.purchasedRemaining,
      cycleStart: accountCreditBalances.cycleStart,
    })
    .from(accountCreditBalances)
    .where(eq(accountCreditBalances.accountId, accountId))
    .limit(1);
  if (!balance) {
    throw new Error(`Credit balance for account ${accountId} was not initialized`);
  }

  return {
    anchorAt,
    monthlyRemaining: balance.monthlyRemaining,
    purchasedRemaining: balance.purchasedRemaining,
    cycleStart: new Date(balance.cycleStart),
    nextResetAt: cycle.nextResetAt,
  };
}

export async function getAccountCreditSnapshot(
  accountId: string,
  now: Date = new Date(),
): Promise<CreditSnapshot> {
  return db.transaction(async (tx) => {
    const prepared = await prepareCurrentBalance(tx, accountId, now);
    return {
      monthlyRemaining: prepared.monthlyRemaining,
      purchasedRemaining: prepared.purchasedRemaining,
      cycleStart: prepared.cycleStart,
      nextResetAt: prepared.nextResetAt,
    };
  });
}

export async function reserveGenerationCredit(input: {
  accountId: string;
  userId: string | null;
  feature: CreditFeature;
  refType?: string | null;
  refId?: number | null;
  operationId?: string;
  now?: Date;
}): Promise<
  | { admitted: false; snapshot: CreditSnapshot }
  | { admitted: true; snapshot: CreditSnapshot; reservation: CreditReservation }
> {
  const now = input.now ?? new Date();
  const operationId = input.operationId ?? randomUUID();
  const debitKey = `credits:debit:${operationId}`;

  return db.transaction(async (tx) => {
    // Serialize the vanishingly rare concurrent replay of one operation key.
    // This is independent from the account-row lock, so different operations
    // still compete normally on the atomic balance debit below.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${debitKey}, 0))
    `);

    const prepared = await prepareCurrentBalance(tx, input.accountId, now);
    const [existingDebit] = await tx
      .select({
        accountId: creditLedger.accountId,
        userId: creditLedger.userId,
        feature: creditLedger.feature,
        refType: creditLedger.refType,
        refId: creditLedger.refId,
        cycleStart: creditLedger.cycleStart,
        bucket: creditLedger.bucket,
        kind: creditLedger.kind,
      })
      .from(creditLedger)
      .where(eq(creditLedger.idempotencyKey, debitKey))
      .limit(1);
    if (existingDebit) {
      if (
        existingDebit.kind !== "debit" ||
        existingDebit.accountId !== input.accountId ||
        existingDebit.feature !== input.feature ||
        (existingDebit.bucket !== "monthly" && existingDebit.bucket !== "purchased")
      ) {
        throw new Error(`Credit operation id ${operationId} conflicts with a different operation`);
      }
      const [existingRefund] = await tx
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(eq(
          creditLedger.idempotencyKey,
          `credits:refund:${operationId}`,
        ))
        .limit(1);
      if (existingRefund) {
        throw new Error(`Credit operation id ${operationId} was already refunded`);
      }

      return {
        admitted: true as const,
        reservation: {
          operationId,
          accountId: existingDebit.accountId,
          userId: existingDebit.userId,
          feature: existingDebit.feature as CreditFeature,
          refType: existingDebit.refType,
          refId: existingDebit.refId,
          cycleStart: new Date(existingDebit.cycleStart),
          spentFrom: existingDebit.bucket as CreditBucket,
        },
        snapshot: {
          monthlyRemaining: prepared.monthlyRemaining,
          purchasedRemaining: prepared.purchasedRemaining,
          cycleStart: prepared.cycleStart,
          nextResetAt: prepared.nextResetAt,
        },
      };
    }

    // One SQL statement owns the eligibility check, row lock, bucket choice,
    // decrement, and returned bucket. No read/check/write race is possible.
    const debitResult = await tx.execute(sql`
      WITH eligible AS (
        SELECT
          account_id,
          (monthly_remaining > 0) AS spent_monthly
        FROM account_credit_balances
        WHERE account_id = ${input.accountId}
          AND cycle_start = ${prepared.cycleStart}
          AND monthly_remaining + purchased_remaining > 0
        FOR UPDATE
      )
      UPDATE account_credit_balances AS balance
      SET
        monthly_remaining = CASE
          WHEN eligible.spent_monthly THEN balance.monthly_remaining - 1
          ELSE balance.monthly_remaining
        END,
        purchased_remaining = CASE
          WHEN eligible.spent_monthly THEN balance.purchased_remaining
          ELSE balance.purchased_remaining - 1
        END,
        updated_at = ${now}
      FROM eligible
      WHERE balance.account_id = eligible.account_id
      RETURNING
        balance.monthly_remaining AS "monthlyRemaining",
        balance.purchased_remaining AS "purchasedRemaining",
        eligible.spent_monthly AS "spentMonthly"
    `);

    const debit = debitResult.rows[0] as {
      monthlyRemaining: number;
      purchasedRemaining: number;
      spentMonthly: boolean;
    } | undefined;

    if (!debit) {
      const [current] = await tx
        .select({
          monthlyRemaining: accountCreditBalances.monthlyRemaining,
          purchasedRemaining: accountCreditBalances.purchasedRemaining,
        })
        .from(accountCreditBalances)
        .where(eq(accountCreditBalances.accountId, input.accountId))
        .limit(1);
      return {
        admitted: false as const,
        snapshot: {
          monthlyRemaining: current?.monthlyRemaining ?? 0,
          purchasedRemaining: current?.purchasedRemaining ?? 0,
          cycleStart: prepared.cycleStart,
          nextResetAt: prepared.nextResetAt,
        },
      };
    }

    const refType = input.refType ?? null;
    const refId = input.refId ?? null;
    await tx.insert(creditLedger).values({
      accountId: input.accountId,
      userId: input.userId,
      delta: -1,
      kind: "debit",
      bucket: debit.spentMonthly ? "monthly" : "purchased",
      feature: input.feature,
      refType,
      refId,
      idempotencyKey: debitKey,
      cycleStart: prepared.cycleStart,
    });

    const reservation: CreditReservation = {
      operationId,
      accountId: input.accountId,
      userId: input.userId,
      feature: input.feature,
      refType,
      refId,
      cycleStart: prepared.cycleStart,
      spentFrom: debit.spentMonthly ? "monthly" : "purchased",
    };

    return {
      admitted: true as const,
      reservation,
      snapshot: {
        monthlyRemaining: debit.monthlyRemaining,
        purchasedRemaining: debit.purchasedRemaining,
        cycleStart: prepared.cycleStart,
        nextResetAt: prepared.nextResetAt,
      },
    };
  });
}

/**
 * Restore one failed generation reservation. The refund ledger insert happens
 * first and owns idempotency; duplicate calls return without touching the
 * balance. Monthly credits are restored only while their original cycle is
 * still the hot row, while purchased credits never expire and are always
 * restored.
 */
export async function refundGenerationCredit(
  reservation: CreditReservation,
): Promise<{ refunded: boolean }> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(creditLedger)
      .values({
        accountId: reservation.accountId,
        userId: reservation.userId,
        delta: 1,
        kind: "refund",
        bucket: reservation.spentFrom,
        feature: reservation.feature,
        refType: reservation.refType,
        refId: reservation.refId,
        idempotencyKey: `credits:refund:${reservation.operationId}`,
        cycleStart: reservation.cycleStart,
      })
      .onConflictDoNothing({ target: creditLedger.idempotencyKey })
      .returning({ id: creditLedger.id });
    if (inserted.length === 0) {
      return { refunded: false };
    }

    if (reservation.spentFrom === "monthly") {
      const restored = await tx
        .update(accountCreditBalances)
        .set({
          monthlyRemaining: sql`${accountCreditBalances.monthlyRemaining} + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(accountCreditBalances.accountId, reservation.accountId),
          eq(accountCreditBalances.cycleStart, reservation.cycleStart),
        ))
        .returning({ accountId: accountCreditBalances.accountId });
      if (restored.length === 0) {
        const [currentBalance] = await tx
          .select({ cycleStart: accountCreditBalances.cycleStart })
          .from(accountCreditBalances)
          .where(eq(accountCreditBalances.accountId, reservation.accountId))
          .limit(1);
        if (!currentBalance) {
          throw new Error(`Credit balance for account ${reservation.accountId} disappeared before refund`);
        }

        // The original monthly credit expired with its old cycle. Preserve a
        // truthful refund audit trail without inflating the newer cycle: the
        // +1 refund and immediate -1 expiration are net-zero.
        await appendMonthlyExpiration(tx, {
          accountId: reservation.accountId,
          amount: 1,
          cycleStart: reservation.cycleStart,
          idempotencyKey: `credits:refund-expiration:${reservation.operationId}`,
          userId: reservation.userId,
          feature: reservation.feature,
          refType: reservation.refType,
          refId: reservation.refId,
        });
      }
    } else {
      const restored = await tx
        .update(accountCreditBalances)
        .set({
          purchasedRemaining: sql`${accountCreditBalances.purchasedRemaining} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(accountCreditBalances.accountId, reservation.accountId))
        .returning({ accountId: accountCreditBalances.accountId });
      if (restored.length === 0) {
        throw new Error(`Credit balance for account ${reservation.accountId} disappeared before refund`);
      }
    }

    return { refunded: true };
  });
}