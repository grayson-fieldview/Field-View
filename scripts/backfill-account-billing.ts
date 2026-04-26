import { db, pool } from "../server/db";
import { accounts, users } from "@shared/models/auth";
import { eq, asc } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;
if (process.argv.includes("--dry-run") && APPLY) {
  console.error("Refusing to run: both --dry-run and --apply were passed. Pick one.");
  process.exit(2);
}

type Stats = {
  total: number;
  skipped: number;
  promoted: number;
  noUsers: number;
  backfilled: number;
};

function dryLog(msg: string, ...rest: any[]) {
  console.log(DRY_RUN ? "[DRY RUN]" : "[apply]   ", msg, ...rest);
}

async function main() {
  console.log("=".repeat(72));
  console.log("Account Billing Backfill");
  console.log("Mode    :", DRY_RUN ? "DRY RUN (no writes)" : "APPLY (writes WILL be made)");
  try {
    console.log("DB host :", new URL(process.env.DATABASE_URL!).hostname);
    console.log("DB name :", new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, ""));
  } catch {
    console.log("DB host : (could not parse DATABASE_URL)");
  }
  console.log("=".repeat(72));
  console.log("");

  const stats: Stats = { total: 0, skipped: 0, promoted: 0, noUsers: 0, backfilled: 0 };

  const allAccounts = await db.select().from(accounts).orderBy(asc(accounts.createdAt));
  stats.total = allAccounts.length;
  console.log(`Found ${allAccounts.length} account(s) in the accounts table.\n`);

  for (const account of allAccounts) {
    console.log(`--- Account ${account.id} (${account.name}) ---`);

    if (account.ownerId) {
      console.log(`[backfill] account ${account.id} already has ownerId (${account.ownerId}), skipping`);
      stats.skipped++;
      console.log("");
      continue;
    }

    const accountUsers = await db
      .select()
      .from(users)
      .where(eq(users.accountId, account.id))
      .orderBy(asc(users.createdAt));

    if (accountUsers.length === 0) {
      console.error(`[backfill] ERROR account ${account.id} has zero users — skipping`);
      stats.noUsers++;
      console.log("");
      continue;
    }

    const admins = accountUsers.filter((u) => u.role === "admin");

    let owner: typeof accountUsers[number];
    let promoted = false;

    if (admins.length === 0) {
      owner = accountUsers[0];
      promoted = true;
      console.warn(`[backfill] account ${account.id} had no admin, promoting user ${owner.email} to admin`);
    } else if (admins.length === 1) {
      owner = admins[0];
    } else {
      const withStripe = admins.filter((a) => a.stripeCustomerId);
      const candidates = withStripe.length > 0 ? withStripe : admins;
      candidates.sort(
        (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0)
      );
      owner = candidates[0];
    }

    const seatCount = Math.max(accountUsers.length, 3);
    const billingCycle = "monthly";
    console.log(
      `[backfill] account ${account.id} billingCycle defaulted to monthly (will be reconciled with Stripe in next session)`
    );

    const updates = {
      ownerId: owner.id,
      stripeCustomerId: owner.stripeCustomerId,
      stripeSubscriptionId: owner.stripeSubscriptionId,
      subscriptionStatus: owner.subscriptionStatus,
      trialEndsAt: owner.trialEndsAt,
      seatCount,
      billingCycle,
    };

    dryLog(
      `Owner    : ${owner.email} (${owner.id})${promoted ? " [PROMOTED to admin]" : ""}`
    );
    dryLog(`UserCount: ${accountUsers.length}  →  seatCount=${seatCount}`);
    dryLog(`UPDATE accounts SET`, JSON.stringify(updates, null, 2));
    if (promoted) {
      dryLog(`UPDATE users SET role='admin' WHERE id='${owner.id}'`);
    }

    if (!DRY_RUN) {
      await db.transaction(async (tx) => {
        if (promoted) {
          await tx.update(users).set({ role: "admin" }).where(eq(users.id, owner.id));
        }
        await tx.update(accounts).set(updates).where(eq(accounts.id, account.id));
      });
    }

    if (promoted) stats.promoted++;
    stats.backfilled++;
    console.log("");
  }

  console.log("=".repeat(72));
  console.log("SUMMARY");
  console.log("=".repeat(72));
  console.log(`Total accounts processed     : ${stats.total}`);
  console.log(`Already backfilled (skipped) : ${stats.skipped}`);
  console.log(`Successfully backfilled      : ${stats.backfilled}`);
  console.log(`Admin promoted               : ${stats.promoted}`);
  console.log(`Errors (no users)            : ${stats.noUsers}`);
  if (DRY_RUN) {
    console.log("");
    console.log("DRY RUN MODE — no writes were made. Re-run without --dry-run to apply.");
  }
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Fatal:", err);
    try { await pool.end(); } catch {}
    process.exit(1);
  });
