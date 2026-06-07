/**
 * create-demo-reviewer-account.ts
 *
 * Creates (or idempotently repairs) a permanent, pre-verified Google Play
 * reviewer account directly in the PRODUCTION database.
 *
 * Final state guaranteed for googleplay@field-view.com:
 *   users:    email_verified=true, profile_completed_at=now(),
 *             subscription_status='active', trial_ends_at=NULL,
 *             stripe_customer_id=NULL, stripe_subscription_id=NULL,
 *             role='admin', account_id=<its account>
 *   accounts: subscription_status='active', trial_ends_at=NULL,
 *             stripe_customer_id=NULL, stripe_subscription_id=NULL,
 *             owner_id=<the user>
 *
 * Why this yields immediate full access (see server/lib/billing.ts):
 *   - computeAccessLevel() returns "full" for status==='active' with NO date
 *     or Stripe check (billing.ts:37) → never expires.
 *   - NULL stripe_customer_id → the webhook's only entry point,
 *     getUserByStripeCustomerId() (auth/storage.ts:43-45), can never match it,
 *     so no Stripe event ever mutates the row.
 *   - email_verified=true + profile_completed_at set → skips the /verify-email
 *     and /welcome client redirects (client/src/App.tsx:367,380).
 *
 * Reused app logic (NOT hand-rolled):
 *   - Password hashing: bcrypt.hash(password, 12) — identical call & cost
 *     factor to /api/register (server/replit_integrations/auth/replitAuth.ts:541),
 *     using the same `bcryptjs` import, so the stored hash format matches what
 *     the LocalStrategy bcrypt.compare() expects (replitAuth.ts:359).
 *   - User row shape / upsert semantics mirror authStorage.upsertUser()
 *     (auth/storage.ts:53-66): insert(users).values(...).onConflictDoUpdate(...).
 *     Replicated here against the transaction handle `tx` (the storage helper is
 *     bound to the pool-level `db`, so it cannot enlist in db.transaction()).
 *   - Account row creation mirrors the trial-signup branch of /api/register
 *     (replitAuth.ts:597-601); owner_id assignment mirrors
 *     scripts/backfill-account-billing.ts:93.
 *   - Email normalization (trim+lowercase) and CURRENT_TERMS_VERSION match
 *     /api/register (replitAuth.ts:526,619).
 *
 * Default rows created by signup: the non-invite trial path of /api/register
 * creates ONLY the accounts row + users row (the marketing-attribution and
 * Customer.io calls are best-effort, session/cookie-derived side effects, not
 * required rows). There are no default tags/projects/checklists seeded at
 * signup, so none are created here.
 *
 * NO DDL. DML only, wrapped in a single db.transaction().
 *
 * Run (operator, manually):
 *   ALLOW_PROD_MIGRATION=yes DEMO_ACCOUNT_PASSWORD='********' \
 *     DATABASE_URL='postgres://...rds.amazonaws.com/...' \
 *     npx tsx scripts/create-demo-reviewer-account.ts
 */

import { fileURLToPath } from "url";
import { resolve } from "path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import { accounts, users } from "@shared/models/auth";
import { CURRENT_TERMS_VERSION } from "@shared/constants";

const DEMO_EMAIL = "googleplay@field-view.com";
const ACCOUNT_NAME = "Google Play Reviewer";
const DEMO_FIRST_NAME = "Google Play";
const DEMO_LAST_NAME = "Reviewer";

type Guarded = { databaseUrl: string; host: string; password: string };

/**
 * Refuses to run anywhere except the production RDS host, and only when the
 * operator has explicitly opted in. Also enforces the same >=8 char password
 * rule as /api/register (replitAuth.ts:528).
 */
function assertProdGuards(): Guarded {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — refusing to run.");
  }

  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL — refusing to run.");
  }

  if (!host.includes("rds.amazonaws.com")) {
    throw new Error(
      `DATABASE_URL host '${host}' is not the production RDS host ` +
        `(*.rds.amazonaws.com) — refusing to run against a non-prod database.`,
    );
  }

  if (process.env.ALLOW_PROD_MIGRATION !== "yes") {
    throw new Error(
      "ALLOW_PROD_MIGRATION must be set to 'yes' to run a production migration — refusing to run.",
    );
  }

  const password = process.env.DEMO_ACCOUNT_PASSWORD;
  if (!password) {
    throw new Error(
      "DEMO_ACCOUNT_PASSWORD is not set — refusing to run (password must never be hardcoded).",
    );
  }
  if (password.length < 8) {
    throw new Error(
      "DEMO_ACCOUNT_PASSWORD must be at least 8 characters (matches /api/register).",
    );
  }

  return { databaseUrl, host, password };
}

async function main() {
  const { host, password } = assertProdGuards();

  // Log host (NEVER the password or full URL) + mode before touching the DB.
  console.log("=".repeat(72));
  console.log("Create Google Play reviewer account");
  console.log("Mode    : APPLY (writes WILL be made to PRODUCTION)");
  console.log("DB host :", host);
  console.log("Target  :", DEMO_EMAIL);
  console.log("=".repeat(72));

  // Reuse the exact hashing call /api/register uses (replitAuth.ts:541).
  const hashedPassword = await bcrypt.hash(password, 12);

  // Same normalization as /api/register (replitAuth.ts:526) and the
  // case-insensitive lookup in authStorage.getUserByEmail (storage.ts:22-28).
  const email = DEMO_EMAIL.trim().toLowerCase();

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // Resolve the account this user belongs to (reuse existing, else create).
    let accountId: string;
    let accountCreated = false;
    if (existing?.accountId) {
      accountId = existing.accountId;
    } else {
      const [account] = await tx
        .insert(accounts)
        .values({
          name: ACCOUNT_NAME,
          subscriptionStatus: "active",
          trialEndsAt: null,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
        })
        .returning();
      accountId = account.id;
      accountCreated = true;
    }

    // Upsert the user row to the desired final state. Mirrors
    // authStorage.upsertUser (storage.ts:53-66) but keyed on the unique email
    // column for idempotency, and run inside this transaction.
    const userValues = {
      email,
      password: hashedPassword,
      firstName: DEMO_FIRST_NAME,
      lastName: DEMO_LAST_NAME,
      role: "admin",
      accountId,
      emailVerified: true,
      subscriptionStatus: "active",
      trialEndsAt: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      termsAcceptedAt: new Date(),
      termsVersion: CURRENT_TERMS_VERSION,
      profileCompletedAt: new Date(),
    };

    const [user] = await tx
      .insert(users)
      .values(userValues)
      .onConflictDoUpdate({
        target: users.email,
        set: { ...userValues, updatedAt: new Date() },
      })
      .returning();

    // Ensure the account's billing flags are in the comp/permanent state and
    // owner_id points at this user (owner_id mirrors backfill-account-billing.ts:93).
    await tx
      .update(accounts)
      .set({
        subscriptionStatus: "active",
        trialEndsAt: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        ownerId: user.id,
      })
      .where(eq(accounts.id, accountId));

    return {
      userId: user.id,
      accountId,
      accountCreated,
      wasExistingUser: !!existing,
    };
  });

  console.log("");
  console.log("Done.");
  console.log("  User        :", result.userId, result.wasExistingUser ? "(updated existing)" : "(created)");
  console.log("  Account     :", result.accountId, result.accountCreated ? "(created)" : "(reused)");
  console.log("  Login email :", email);
  console.log("  Password    : (from DEMO_ACCOUNT_PASSWORD — not logged)");
}

// Entry-point guard: only run when invoked directly, not when imported.
const invokedDirectly =
  !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("Fatal:", err instanceof Error ? err.message : err);
      try {
        await pool.end();
      } catch {}
      process.exit(1);
    });
}

export { main };
