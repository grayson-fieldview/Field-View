import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { seedDatabase } from "./seed";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { WebhookHandlers } from "./webhookHandlers";
import { authStorage } from "./replit_integrations/auth/storage";
import { db } from "./db";
import { users, accounts } from "@shared/models/auth";
import { eq } from "drizzle-orm";
import { isAccountBillingEnabled, computeSeatCountFromSub } from "./lib/billing";
import { initSentry, Sentry } from "./lib/sentry";
import { logCsrfStartupMode } from "./middleware/csrf";

initSentry();

logCsrfStartupMode();

const app = express();

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

function getPublicBaseUrl(): string | null {
  if (process.env.OAUTH_BASE_URL)
    return process.env.OAUTH_BASE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.REPLIT_DOMAINS) {
    const first = process.env.REPLIT_DOMAINS.split(",")[0]?.trim();
    if (first) return `https://${first}`;
  }
  return null;
}

export async function ensureAuthColumns() {
  try {
    const { pool } = await import("./db");
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider varchar DEFAULT 'local';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id varchar;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_id varchar;
      CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_unique ON users(google_id) WHERE google_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS users_microsoft_id_unique ON users(microsoft_id) WHERE microsoft_id IS NOT NULL;
    `);
    console.log("Auth columns verified");
  } catch (e: any) {
    console.error("Failed to ensure auth columns:", e.message);
  }
}

export async function initStripe() {
  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL environment variable is required for Stripe integration.",
    );
  }

  if (
    databaseUrl.includes("rds.amazonaws.com") &&
    !databaseUrl.includes("sslmode=")
  ) {
    databaseUrl +=
      (databaseUrl.includes("?") ? "&" : "?") + "sslmode=no-verify";
  }

  try {
    console.log("Initializing Stripe schema...");
    await runMigrations({ databaseUrl, schema: "stripe" });
    console.log("Stripe schema ready");

    const stripeSync = await getStripeSync();

    console.log("Setting up managed webhook...");
    const baseUrl = getPublicBaseUrl();
    if (baseUrl) {
      try {
        const result = await stripeSync.findOrCreateManagedWebhook(
          `${baseUrl}/api/stripe/webhook`,
        );
        console.log(
          `Webhook configured: ${result?.webhook?.url || "setup complete"}`,
        );
      } catch (webhookError: any) {
        console.warn("Webhook setup warning:", webhookError.message);
      }
    } else {
      console.warn(
        "No public base URL detected; skipping managed webhook setup. Set OAUTH_BASE_URL or VERCEL_URL.",
      );
    }

    console.log("Syncing Stripe data...");
    stripeSync
      .syncBackfill()
      .then(() => {
        console.log("Stripe data synced");
      })
      .catch((err: any) => {
        console.error("Error syncing Stripe data:", err);
      });
  } catch (error) {
    console.error("Failed to initialize Stripe:", error);
  }
}

export async function bootstrapAdminAndOrphans() {
  try {
    const bcryptMod = await import("bcryptjs");
    const { db } = await import("./db");
    const { users, accounts } = await import("@shared/models/auth");
    const { eq, isNull } = await import("drizzle-orm");

    const adminAccounts: Array<{
      email: string;
      password: string | undefined;
      passwordEnvVar: string;
      firstName: string;
      lastName: string;
    }> = [
      {
        email: "grayson@field-view.com",
        password: process.env.SEED_ADMIN_PASSWORD_PRIMARY,
        passwordEnvVar: "SEED_ADMIN_PASSWORD_PRIMARY",
        firstName: "Grayson",
        lastName: "Gladu",
      },
      {
        email: "grant@field-view.com",
        password: process.env.SEED_ADMIN_PASSWORD_SECONDARY,
        passwordEnvVar: "SEED_ADMIN_PASSWORD_SECONDARY",
        firstName: "Grant",
        lastName: "",
      },
    ];

    for (const admin of adminAccounts) {
      const [existing] = await db
        .select({
          id: users.id,
          subscriptionStatus: users.subscriptionStatus,
          accountId: users.accountId,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(eq(users.email, admin.email));
      if (existing) {
        const updates: Record<string, any> = {};
        if (existing.subscriptionStatus !== "active") {
          updates.subscriptionStatus = "active";
          updates.role = "admin";
        }
        if (!existing.accountId) {
          const [newAccount] = await db
            .insert(accounts)
            .values({ name: `${existing.firstName || "Field View"}'s Team` })
            .returning();
          updates.accountId = newAccount.id;
          console.log(`Created account for ${admin.email}: ${newAccount.id}`);
        }
        if (Object.keys(updates).length > 0) {
          await db
            .update(users)
            .set(updates)
            .where(eq(users.email, admin.email));
          console.log(
            `Admin account ${admin.email} updated:`,
            Object.keys(updates).join(", "),
          );
        }
      } else {
        if (!admin.password) {
          console.warn(
            `[seed-admin] Skipping ${admin.email} — ${admin.passwordEnvVar} not set`,
          );
          continue;
        }
        const hash = await bcryptMod.default.hash(admin.password, 12);
        const [newAccount] = await db
          .insert(accounts)
          .values({ name: `${admin.firstName || "Field View"}'s Team` })
          .returning();
        await db.insert(users).values({
          email: admin.email,
          password: hash,
          firstName: admin.firstName,
          lastName: admin.lastName,
          role: "admin",
          accountId: newAccount.id,
          subscriptionStatus: "active",
        });
        console.log(
          `Created admin account ${admin.email} with account ${newAccount.id}`,
        );
      }
    }

    const orphanUsers = await db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(isNull(users.accountId));
    for (const orphan of orphanUsers) {
      const [newAccount] = await db
        .insert(accounts)
        .values({
          name:
            `${orphan.firstName || "User"} ${orphan.lastName || ""}`.trim() +
            "'s Team",
        })
        .returning();
      await db
        .update(users)
        .set({ accountId: newAccount.id })
        .where(eq(users.id, orphan.id));
      console.log(
        `Created account for orphan user ${orphan.email}: ${newAccount.id} (role preserved: ${orphan.role})`,
      );
    }

    const { projects } = await import("@shared/schema");
    const orphanProjects = await db
      .select({ id: projects.id, createdById: projects.createdById })
      .from(projects)
      .where(isNull(projects.accountId));
    for (const proj of orphanProjects) {
      if (proj.createdById) {
        const [creator] = await db
          .select({ accountId: users.accountId })
          .from(users)
          .where(eq(users.id, proj.createdById));
        if (creator?.accountId) {
          await db
            .update(projects)
            .set({ accountId: creator.accountId })
            .where(eq(projects.id, proj.id));
          console.log(
            `Fixed orphan project ${proj.id} -> account ${creator.accountId}`,
          );
        }
      }
    }
  } catch (e) {
    console.error("Account setup skipped:", e);
  }
}

async function writeAccountBilling(
  event: string,
  stripeCustomerId: string,
  fields: {
    subscriptionStatus?: string;
    stripeSubscriptionId?: string;
    trialEndsAt?: Date | null;
    seatCount?: number;
    subscriptionLapsedAt?: Date | null;
  },
) {
  if (!isAccountBillingEnabled()) return;
  if (!stripeCustomerId) return;

  const matches = await db
    .select({ id: users.id, accountId: users.accountId })
    .from(users)
    .where(eq(users.stripeCustomerId, stripeCustomerId));

  if (matches.length === 0) return;

  const chosen = matches[0];

  if (matches.length > 1) {
    console.warn(
      "[webhook-dual-write]",
      JSON.stringify({
        stripeCustomerId,
        matchCount: matches.length,
        chosenAccountId: chosen.accountId,
        reason: "multiple_users_share_stripe_customer",
      }),
    );
  }

  if (!chosen.accountId) {
    console.warn(
      "[webhook-dual-write]",
      JSON.stringify({
        event,
        stripeCustomerId,
        userId: chosen.id,
        reason: "user_has_no_account_id",
      }),
    );
    return;
  }

  const cleanFields: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) cleanFields[k] = v;
  }
  if (Object.keys(cleanFields).length === 0) return;

  await db.update(accounts).set(cleanFields).where(eq(accounts.id, chosen.accountId));

  console.log(
    "[webhook-dual-write]",
    JSON.stringify({
      event,
      accountId: chosen.accountId,
      userId: chosen.id,
      flagEnabled: isAccountBillingEnabled(),
      fieldsWritten: Object.keys(cleanFields),
    }),
  );
}

async function handleSubscriptionEvent(event: any) {
  try {
    const type = event.type;
    const data = event.data?.object;
    if (!data) return;

    if (type === "checkout.session.completed") {
      const customerId = data.customer;
      const subscriptionId = data.subscription;
      if (customerId && subscriptionId) {
        const user = await authStorage.getUserByStripeCustomerId(customerId);
        if (user) {
          let appStatus = "trialing";
          let seatCountFromSub: number | undefined;
          try {
            const stripe = await getUncachableStripeClient();
            const sub = await stripe.subscriptions.retrieve(
              subscriptionId as string,
              { expand: ["items.data.price.product"] },
            );
            if (sub.status === "active") appStatus = "active";
            else if (sub.status === "trialing") appStatus = "trialing";
            else if (sub.status === "past_due") appStatus = "past_due";
            seatCountFromSub = computeSeatCountFromSub(sub);
          } catch (e) {}
          await authStorage.updateUser(user.id, {
            stripeSubscriptionId: subscriptionId as string,
            subscriptionStatus: appStatus,
          });
          console.log(
            `User ${user.id} subscription updated to ${appStatus} via checkout`,
          );
          await writeAccountBilling(type, customerId as string, {
            stripeSubscriptionId: subscriptionId as string,
            subscriptionStatus: appStatus,
            seatCount: seatCountFromSub,
          });
        }
      }
    } else if (type === "customer.subscription.updated") {
      const customerId = data.customer;
      const status = data.status;
      const user = await authStorage.getUserByStripeCustomerId(customerId);
      if (user) {
        let appStatus = "none";
        if (status === "active") appStatus = "active";
        else if (status === "trialing") appStatus = "trialing";
        else if (status === "past_due") appStatus = "past_due";
        else if (status === "canceled" || status === "unpaid")
          appStatus = "canceled";

        let seatCountFromSub: number | undefined;
        try {
          const stripe = await getUncachableStripeClient();
          const fullSub = await stripe.subscriptions.retrieve(data.id, {
            expand: ["items.data.price.product"],
          });
          seatCountFromSub = computeSeatCountFromSub(fullSub);
        } catch (e) {}

        let lapsedAtUpdate: Date | null | undefined = undefined;
        let lapsedAtChange: "set" | "clear" | null = null;
        let lapseAccountId: string | null = null;
        if (user.accountId) {
          lapseAccountId = user.accountId;
          try {
            const [acctRow] = await db
              .select({ subscriptionLapsedAt: accounts.subscriptionLapsedAt })
              .from(accounts)
              .where(eq(accounts.id, user.accountId))
              .limit(1);
            const existingLapsedAt = acctRow?.subscriptionLapsedAt ?? null;
            if (appStatus === "past_due" && existingLapsedAt == null) {
              lapsedAtUpdate = new Date();
              lapsedAtChange = "set";
            } else if (
              (appStatus === "active" || appStatus === "trialing") &&
              existingLapsedAt != null
            ) {
              lapsedAtUpdate = null;
              lapsedAtChange = "clear";
            }
          } catch (e) {
            console.error("Error reading existing lapsed_at:", (e as any)?.message);
          }
        }

        await authStorage.updateUser(user.id, {
          subscriptionStatus: appStatus,
          stripeSubscriptionId: data.id,
        });
        console.log(`User ${user.id} subscription updated to ${appStatus}`);
        await writeAccountBilling(type, customerId as string, {
          subscriptionStatus: appStatus,
          stripeSubscriptionId: data.id,
          seatCount: seatCountFromSub,
          subscriptionLapsedAt: lapsedAtUpdate,
        });

        if (lapsedAtChange === "set") {
          console.log(
            "[lapse-transition]",
            JSON.stringify({
              accountId: lapseAccountId,
              customerId,
              status: appStatus,
              action: "lapse_started",
            }),
          );
        } else if (lapsedAtChange === "clear") {
          console.log(
            "[lapse-transition]",
            JSON.stringify({
              accountId: lapseAccountId,
              customerId,
              status: appStatus,
              action: "lapse_cleared",
            }),
          );
        }
      }
    } else if (type === "customer.subscription.deleted") {
      const customerId = data.customer;
      const user = await authStorage.getUserByStripeCustomerId(customerId);
      if (user) {
        await authStorage.updateUser(user.id, {
          subscriptionStatus: "canceled",
        });
        console.log(`User ${user.id} subscription canceled`);
        await writeAccountBilling(type, customerId as string, {
          subscriptionStatus: "canceled",
        });
      }
    }
  } catch (err: any) {
    console.error("Error handling subscription event:", err.message);
    Sentry.captureException(err, {
      tags: {
        webhook_event_type: event?.type || "unknown",
      },
      extra: {
        eventId: event?.id,
        customerId: event?.data?.object?.customer,
      },
    });
  }
}

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature" });
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!Buffer.isBuffer(req.body)) {
        console.error("STRIPE WEBHOOK ERROR: req.body is not a Buffer.");
        return res.status(500).json({ error: "Webhook processing error" });
      }

      await WebhookHandlers.processWebhook(req.body as Buffer, sig);

      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      let event: any;
      if (webhookSecret) {
        try {
          const stripe = await getUncachableStripeClient();
          event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
        } catch (verifyErr: any) {
          console.error(
            "Stripe webhook signature verification failed:",
            verifyErr.message,
          );
          Sentry.captureMessage("Webhook signature verification failed", {
            level: "error",
            tags: { source: "stripe_webhook" },
            extra: {
              error: verifyErr.message,
              ip: req.ip || "unknown",
            },
          });
          return res
            .status(400)
            .json({ error: "Webhook signature verification failed" });
        }
      } else {
        // STRIPE_WEBHOOK_SECRET not set — local defense-in-depth verification
        // skipped. WebhookHandlers.processWebhook (stripe-replit-sync vendor
        // lib, called above) verifies signatures upstream using the managed
        // webhook secret, so events reaching this point have already been
        // signature-verified.
        console.warn(
          "[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — skipping local signature verification (vendor lib verified upstream)",
        );
        try {
          event = JSON.parse(req.body.toString());
        } catch (parseErr: any) {
          console.error(
            "Stripe webhook body parse failed:",
            parseErr.message,
          );
          return res.status(400).json({ error: "Invalid webhook body" });
        }
      }
      await handleSubscriptionEvent(event);

      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error("Webhook error:", error.message);
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

const httpServer = createServer(app);
let routesRegistered = false;
let routesRegistering: Promise<void> | null = null;

export async function ensureAppReady(): Promise<void> {
  if (routesRegistered) return;
  if (!routesRegistering) {
    routesRegistering = (async () => {
      await registerRoutes(httpServer, app);
      app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
        const status = err.status || err.statusCode || 500;
        const message = err.message || "Internal Server Error";
        console.error("Internal Server Error:", err);
        if (res.headersSent) return next(err);
        return res.status(status).json({ message });
      });
      routesRegistered = true;
    })();
  }
  await routesRegistering;
}

export { app, httpServer };

const isServerless = !!process.env.VERCEL;

if (!isServerless) {
  (async () => {
    await ensureAuthColumns();
    await initStripe();
    await ensureAppReady();
    await seedDatabase();
    await bootstrapAdminAndOrphans();

    if (process.env.NODE_ENV === "production") {
      serveStatic(app);
    } else {
      const { setupVite } = await import("./vite");
      await setupVite(httpServer, app);
    }

    const port = parseInt(process.env.PORT || "5000", 10);
    httpServer.listen(
      {
        port,
        host: "0.0.0.0",
        reusePort: true,
      },
      () => {
        log(`serving on port ${port}`);
      },
    );
  })();
}
