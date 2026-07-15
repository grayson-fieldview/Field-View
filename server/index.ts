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
import { eq, sql } from "drizzle-orm";
import { normalizeEmail } from "./lib/normalizeEmail";
import { initSentry, Sentry } from "./lib/sentry";
import { logCsrfStartupMode } from "./middleware/csrf";
import { handleSubscriptionEvent } from "./lib/stripeWebhook";

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
        .where(sql`lower(${users.email}) = ${normalizeEmail(admin.email)}`);
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
            .where(sql`lower(${users.email}) = ${normalizeEmail(admin.email)}`);
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

// writeAccountBilling + handleSubscriptionEvent extracted to ./lib/stripeWebhook.ts
// so the standalone Vercel function (server/vercelStripeWebhook.ts → api/stripe/webhook.js)
// can import them without pulling in the Express startup side-effect graph.

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

      console.log("[stripe-webhook] received", {
        hasRawBody: Buffer.isBuffer((req as any).rawBody),
        rawBodyLen: Buffer.isBuffer((req as any).rawBody)
          ? (req as any).rawBody.length
          : null,
        bodyIsBuf: Buffer.isBuffer(req.body),
        bodyLen: Buffer.isBuffer(req.body) ? req.body.length : null,
        sigPresent: !!sig,
      });

      // Prefer req.rawBody (populated by @vercel/node with the byte-perfect
      // original payload before any JSON auto-parsing). Fall back to req.body
      // when running under plain Express (Replit dev), where express.raw
      // gives us the raw Buffer directly. Stripe's constructEvent computes
      // HMAC over these exact bytes — any re-serialization breaks it.
      const rawPayload: Buffer | undefined = Buffer.isBuffer(
        (req as any).rawBody,
      )
        ? ((req as any).rawBody as Buffer)
        : Buffer.isBuffer(req.body)
          ? (req.body as Buffer)
          : undefined;
      if (!rawPayload) {
        console.error("STRIPE WEBHOOK ERROR: no raw body available", {
          rawBodyType: typeof (req as any).rawBody,
          bodyType: typeof req.body,
          bodyIsBuffer: Buffer.isBuffer(req.body),
        });
        return res.status(500).json({ error: "Webhook processing error" });
      }

      await WebhookHandlers.processWebhook(rawPayload, sig);

      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      let event: any;
      if (webhookSecret) {
        try {
          const stripe = await getUncachableStripeClient();
          event = stripe.webhooks.constructEvent(rawPayload, sig, webhookSecret);
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
          event = JSON.parse(rawPayload.toString());
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
