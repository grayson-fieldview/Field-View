import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { seedDatabase } from "./seed";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync, getUncachableStripeClient } from "./stripeClient";
import { WebhookHandlers } from "./webhookHandlers";
import { authStorage } from "./replit_integrations/auth/storage";

const app = express();
const httpServer = createServer(app);

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

async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required for Stripe integration.');
  }

  try {
    console.log('Initializing Stripe schema...');
    await runMigrations({ databaseUrl, schema: 'stripe' });
    console.log('Stripe schema ready');

    const stripeSync = await getStripeSync();

    console.log('Setting up managed webhook...');
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
    try {
      const result = await stripeSync.findOrCreateManagedWebhook(
        `${webhookBaseUrl}/api/stripe/webhook`
      );
      console.log(`Webhook configured: ${result?.webhook?.url || 'setup complete'}`);
    } catch (webhookError: any) {
      console.warn('Webhook setup warning:', webhookError.message);
    }

    console.log('Syncing Stripe data...');
    stripeSync.syncBackfill()
      .then(() => {
        console.log('Stripe data synced');
      })
      .catch((err: any) => {
        console.error('Error syncing Stripe data:', err);
      });
  } catch (error) {
    console.error('Failed to initialize Stripe:', error);
  }
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
          try {
            const stripe = await getUncachableStripeClient();
            const sub = await stripe.subscriptions.retrieve(subscriptionId as string);
            if (sub.status === "active") appStatus = "active";
            else if (sub.status === "trialing") appStatus = "trialing";
            else if (sub.status === "past_due") appStatus = "past_due";
          } catch (e) {}
          await authStorage.updateUser(user.id, {
            stripeSubscriptionId: subscriptionId as string,
            subscriptionStatus: appStatus,
          });
          console.log(`User ${user.id} subscription updated to ${appStatus} via checkout`);
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
        else if (status === "canceled" || status === "unpaid") appStatus = "canceled";

        await authStorage.updateUser(user.id, {
          subscriptionStatus: appStatus,
          stripeSubscriptionId: data.id,
        });
        console.log(`User ${user.id} subscription updated to ${appStatus}`);
      }
    } else if (type === "customer.subscription.deleted") {
      const customerId = data.customer;
      const user = await authStorage.getUserByStripeCustomerId(customerId);
      if (user) {
        await authStorage.updateUser(user.id, {
          subscriptionStatus: "canceled",
        });
        console.log(`User ${user.id} subscription canceled`);
      }
    }
  } catch (err: any) {
    console.error("Error handling subscription event:", err.message);
  }
}

(async () => {
  await initStripe();

  app.post(
    '/api/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const signature = req.headers['stripe-signature'];

      if (!signature) {
        return res.status(400).json({ error: 'Missing stripe-signature' });
      }

      try {
        const sig = Array.isArray(signature) ? signature[0] : signature;

        if (!Buffer.isBuffer(req.body)) {
          console.error('STRIPE WEBHOOK ERROR: req.body is not a Buffer.');
          return res.status(500).json({ error: 'Webhook processing error' });
        }

        await WebhookHandlers.processWebhook(req.body as Buffer, sig);

        try {
          const stripe = await getUncachableStripeClient();
          const event = stripe.webhooks.constructEvent(req.body, sig, '');
          await handleSubscriptionEvent(event);
        } catch (eventErr: any) {
          try {
            const rawEvent = JSON.parse(req.body.toString());
            await handleSubscriptionEvent(rawEvent);
          } catch (parseErr) {
          }
        }

        res.status(200).json({ received: true });
      } catch (error: any) {
        console.error('Webhook error:', error.message);
        res.status(400).json({ error: 'Webhook processing error' });
      }
    }
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

  await registerRoutes(httpServer, app);
  await seedDatabase();

  try {
    const bcryptMod = await import("bcryptjs");
    const { db } = await import("./db");
    const { users, accounts } = await import("@shared/models/auth");
    const { eq, isNull } = await import("drizzle-orm");

    const adminAccounts = [
      { email: "grayson@field-view.com", password: "Georgia#22", firstName: "Grayson", lastName: "Gladu" },
      { email: "grant@field-view.com", password: "Roswell#2018", firstName: "Grant", lastName: "" },
    ];

    for (const admin of adminAccounts) {
      const [existing] = await db.select({ id: users.id, subscriptionStatus: users.subscriptionStatus, accountId: users.accountId, firstName: users.firstName, lastName: users.lastName }).from(users).where(eq(users.email, admin.email));
      if (existing) {
        const updates: Record<string, any> = {};
        if (existing.subscriptionStatus !== "active") {
          updates.subscriptionStatus = "active";
          updates.role = "admin";
        }
        if (!existing.accountId) {
          const [newAccount] = await db.insert(accounts).values({ name: `${existing.firstName || "Field View"}'s Team` }).returning();
          updates.accountId = newAccount.id;
          console.log(`Created account for ${admin.email}: ${newAccount.id}`);
        }
        if (Object.keys(updates).length > 0) {
          await db.update(users).set(updates).where(eq(users.email, admin.email));
          console.log(`Admin account ${admin.email} updated:`, Object.keys(updates).join(", "));
        }
      } else {
        const hash = await bcryptMod.default.hash(admin.password, 12);
        const [newAccount] = await db.insert(accounts).values({ name: `${admin.firstName || "Field View"}'s Team` }).returning();
        await db.insert(users).values({
          email: admin.email,
          password: hash,
          firstName: admin.firstName,
          lastName: admin.lastName,
          role: "admin",
          accountId: newAccount.id,
          subscriptionStatus: "active",
        });
        console.log(`Created admin account ${admin.email} with account ${newAccount.id}`);
      }
    }

    const orphanUsers = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email, role: users.role }).from(users).where(isNull(users.accountId));
    for (const orphan of orphanUsers) {
      const [newAccount] = await db.insert(accounts).values({ name: `${orphan.firstName || "User"} ${orphan.lastName || ""}`.trim() + "'s Team" }).returning();
      await db.update(users).set({ accountId: newAccount.id }).where(eq(users.id, orphan.id));
      console.log(`Created account for orphan user ${orphan.email}: ${newAccount.id} (role preserved: ${orphan.role})`);
    }

    const { projects } = await import("@shared/schema");
    const orphanProjects = await db.select({ id: projects.id, createdById: projects.createdById }).from(projects).where(isNull(projects.accountId));
    for (const proj of orphanProjects) {
      if (proj.createdById) {
        const [creator] = await db.select({ accountId: users.accountId }).from(users).where(eq(users.id, proj.createdById));
        if (creator?.accountId) {
          await db.update(projects).set({ accountId: creator.accountId }).where(eq(projects.id, proj.id));
          console.log(`Fixed orphan project ${proj.id} -> account ${creator.accountId}`);
        }
      }
    }
  } catch (e) {
    console.error("Account setup skipped:", e);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

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
