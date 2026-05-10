import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
// @ts-ignore - no types published for passport-microsoft
import { Strategy as MicrosoftStrategy } from "passport-microsoft";
import session from "express-session";
import type { Express, RequestHandler, Request } from "express";
import connectPg from "connect-pg-simple";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { authStorage } from "./storage";
import { db, pool } from "../../db";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { passwordResetTokens, users, accounts, invitations, type User } from "@shared/models/auth";
import { sendPasswordResetEmail, sendEmailVerificationEmail, sendWelcomeEmail, sendAccountRestoredEmail } from "../../services/email";
import { getAccountBilling, overlayAccountBillingOnUser, computeAccessLevel } from "../../lib/billing";
import { verifyRecaptchaToken } from "../../services/recaptcha";
import { CURRENT_TERMS_VERSION } from "@shared/constants";
import {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  resendVerificationLimiter,
  verifyEmailLimiter,
  loginAccountLimiter,
} from "../../middleware/rate-limit";
import { Sentry } from "../../lib/sentry";
import { sendSlackNotification, isCompAccount } from "../../lib/slack";
import { csrfGuard } from "../../middleware/csrf";

function getBaseUrl(req?: Request) {
  if (process.env.OAUTH_BASE_URL) return process.env.OAUTH_BASE_URL;
  if (process.env.REPLIT_DOMAINS) {
    const first = process.env.REPLIT_DOMAINS.split(",")[0].trim();
    return `https://${first}`;
  }
  if (req) return `${req.protocol}://${req.get("host")}`;
  return "http://localhost:5000";
}

async function findOrCreateOAuthUser(opts: {
  provider: "google" | "microsoft";
  providerId: string;
  email: string | null;
  firstName?: string | null;
  lastName?: string | null;
  profileImageUrl?: string | null;
  inviteToken?: string | null;
}): Promise<{ user: User; isNewSignup: boolean }> {
  const providerIdField = opts.provider === "google" ? "googleId" : "microsoftId";

  // 1. Match by provider id (returning user)
  const byProvider = opts.provider === "google"
    ? await authStorage.getUserByGoogleId(opts.providerId)
    : await authStorage.getUserByMicrosoftId(opts.providerId);
  if (byProvider) {
    const restoreResult = await restoreAccountIfWithinGrace(byProvider);
    if (restoreResult.expired) {
      throw new Error("Account no longer exists");
    }
    return { user: restoreResult.user, isNewSignup: false };
  }

  // 2. Match by email — link the provider id to the existing account.
  // Session 3 BUG 1 fix: normalize casing for symmetry with /api/register.
  const normalizedEmail = opts.email ? opts.email.trim().toLowerCase() : null;
  if (normalizedEmail) {
    const existing = await authStorage.getUserByEmail(normalizedEmail);
    if (existing) {
      const restoreResult = await restoreAccountIfWithinGrace(existing);
      if (restoreResult.expired) {
        throw new Error("Account no longer exists");
      }
      const updated = await authStorage.updateUser(restoreResult.user.id, {
        [providerIdField]: opts.providerId,
        firstName: restoreResult.user.firstName || opts.firstName || null,
        lastName: restoreResult.user.lastName || opts.lastName || null,
        profileImageUrl: restoreResult.user.profileImageUrl || opts.profileImageUrl || null,
      } as any);
      return { user: updated!, isNewSignup: false };
    }
  }

  // 3. Brand new user. Honor invite token if present, else create a new team.
  if (!normalizedEmail) {
    throw new Error("Email permission was not granted by the OAuth provider");
  }

  let accountId: string;
  let role: string;
  let initialSubscriptionStatus: string;
  let initialTrialEndsAt: Date | null;

  // TODO: Terms acceptance gate for OAuth signups. Users signing up via Google
  // currently bypass the terms checkbox on /register. Consider adding a
  // post-OAuth acceptance page that blocks access until terms_accepted_at is set.
  if (opts.inviteToken) {
    const [invitation] = await db.select().from(invitations).where(
      and(eq(invitations.token, opts.inviteToken), eq(invitations.status, "pending"))
    );
    if (!invitation || new Date() > invitation.expiresAt) {
      throw new Error("Invalid or expired invitation");
    }
    if (invitation.email.toLowerCase() !== normalizedEmail) {
      throw new Error("Email does not match invitation");
    }
    accountId = invitation.accountId;
    role = invitation.role;
    // Mirror the parent account's billing onto the new user row so that
    // getAccountBilling's user-fallback path (when ACCOUNT_BILLING_ENABLED
    // is off) does not lock OAuth invitees joining active/trialing accounts.
    // Same fix as the password-invite branch in /api/register.
    const [acct] = await db
      .select({
        subscriptionStatus: accounts.subscriptionStatus,
        trialEndsAt: accounts.trialEndsAt,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    initialSubscriptionStatus = acct?.subscriptionStatus ?? "none";
    initialTrialEndsAt = acct?.trialEndsAt ?? null;
    await db.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, invitation.id));
  } else {
    // Session 1 trial-flow rework: OAuth self-serve signups also start in
    // a 14-day no-card trial, mirroring the /api/register trial branch.
    initialSubscriptionStatus = "trialing";
    initialTrialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const accountName = [opts.firstName, opts.lastName].filter(Boolean).join(" ") || normalizedEmail;
    const [account] = await db.insert(accounts).values({
      name: accountName + "'s Team",
      subscriptionStatus: initialSubscriptionStatus,
      trialEndsAt: initialTrialEndsAt,
    }).returning();
    accountId = account.id;
    role = "admin";
  }

  const created = await authStorage.upsertUser({
    email: normalizedEmail,
    firstName: opts.firstName || null,
    lastName: opts.lastName || null,
    profileImageUrl: opts.profileImageUrl || null,
    authProvider: opts.provider,
    [providerIdField]: opts.providerId,
    role,
    accountId,
    emailVerified: true,
    subscriptionStatus: initialSubscriptionStatus,
    trialEndsAt: initialTrialEndsAt,
  } as any);
  return { user: created, isNewSignup: true };
}

// 30-day soft-delete grace period. Set deleted_at via DELETE /api/users/me or DELETE /api/account.
// Within grace, sign-in restores both user and account (clears deleted_at). Past grace, sign-in is rejected.
const SOFT_DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

async function restoreAccountIfWithinGrace(
  user: User,
): Promise<{ user: User; restored: boolean; expired: boolean }> {
  if (!user.accountId) {
    if (user.deletedAt) {
      const expired = Date.now() - user.deletedAt.getTime() > SOFT_DELETE_GRACE_MS;
      return { user, restored: false, expired };
    }
    return { user, restored: false, expired: false };
  }

  const [account] = await db.select().from(accounts).where(eq(accounts.id, user.accountId));
  const now = Date.now();
  const userExpired = !!user.deletedAt && now - user.deletedAt.getTime() > SOFT_DELETE_GRACE_MS;
  const accountExpired = !!account?.deletedAt && now - account.deletedAt.getTime() > SOFT_DELETE_GRACE_MS;

  if (userExpired || accountExpired) {
    return { user, restored: false, expired: true };
  }
  if (!user.deletedAt && !account?.deletedAt) {
    return { user, restored: false, expired: false };
  }

  // Conditional updates make this idempotent under concurrent restores: if another request
  // already cleared deleted_at, the WHERE clause matches zero rows and we do nothing.
  await db.transaction(async (tx) => {
    if (user.deletedAt) {
      await tx
        .update(users)
        .set({ deletedAt: null })
        .where(and(eq(users.id, user.id), isNotNull(users.deletedAt)));
    }
    if (account?.deletedAt) {
      await tx
        .update(accounts)
        .set({ deletedAt: null })
        .where(and(eq(accounts.id, account.id), isNotNull(accounts.deletedAt)));
    }
  });

  const fresh = (await authStorage.getUser(user.id)) || user;

  console.log(
    "[account-deletion] user",
    user.id,
    "signed in within grace period, restoring account",
    user.accountId,
  );
  Sentry.captureMessage("Account restored within grace period", {
    level: "info",
    tags: { event: "account-restore" },
    extra: { userId: user.id, accountId: user.accountId },
  });

  if (fresh.email) {
    sendAccountRestoredEmail(fresh.email, {
      firstName: fresh.firstName,
      accountName: account?.name || "your account",
    }).catch((err) => console.error("[account-deletion] restore email failed:", err));
  }

  return { user: fresh, restored: true, expired: false };
}

export function getSession() {
  const sessionTtlSeconds = 14 * 24 * 60 * 60;
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    pool,
    createTableIfMissing: false,
    ttl: sessionTtlSeconds,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: sessionTtlSeconds * 1000,
    },
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());
  // CSRF defense — runs after session/passport so /api/* routes are guarded.
  // See server/middleware/csrf.ts for strategy and CSRF_MODE env var.
  app.use(csrfGuard);

  passport.use(
    new LocalStrategy(
      { usernameField: "email", passwordField: "password", passReqToCallback: true },
      async (req: any, email: string, password: string, done: any) => {
        const logFail = (reason: string) => {
          const normalizedEmail = (email || "").toLowerCase();
          const ip = req.ip || req.socket?.remoteAddress || "unknown";
          const ts = new Date().toISOString();
          console.warn(
            "[auth-fail]",
            JSON.stringify({ email: normalizedEmail, ip, reason, ts }),
          );
          Sentry.captureMessage("Auth failure", {
            level: "warning",
            tags: {
              reason,
              auth_provider: "local",
            },
            extra: { email: normalizedEmail, ip, ts },
          });
        };
        try {
          const user = await authStorage.getUserByEmail(email);
          if (!user || !user.password) {
            logFail("user_not_found");
            return done(null, false, { message: "Invalid email or password" });
          }
          const isValid = await bcrypt.compare(password, user.password);
          if (!isValid) {
            logFail("invalid_password");
            return done(null, false, { message: "Invalid email or password" });
          }
          // Restore-on-signin: if soft-deleted within 30-day grace, clear deleted_at on user + account.
          // If grace expired, reject sign-in entirely.
          const restoreResult = await restoreAccountIfWithinGrace(user);
          if (restoreResult.expired) {
            logFail("account_deleted_expired");
            return done(null, false, { message: "Account no longer exists" });
          }
          const activeUser = restoreResult.user;
          return done(null, activeUser);
        } catch (error) {
          return done(error);
        }
      }
    )
  );

  // Google OAuth strategy (only register if credentials are present)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: `${getBaseUrl()}/api/auth/google/callback`,
          passReqToCallback: true,
        },
        async (req: any, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
          try {
            const email = profile.emails?.[0]?.value || null;
            const inviteToken = (req.session as any)?.oauthInviteToken || null;
            const { user, isNewSignup } = await findOrCreateOAuthUser({
              provider: "google",
              providerId: profile.id,
              email,
              firstName: profile.name?.givenName || null,
              lastName: profile.name?.familyName || null,
              profileImageUrl: profile.photos?.[0]?.value || null,
              inviteToken,
            });
            if (isNewSignup && !isCompAccount(user.email)) {
              const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
              sendSlackNotification(`🎉 New signup (Google): ${user.email} — ${name}`).catch(() => {});
            }
            return done(null, user);
          } catch (err: any) {
            return done(null, false, { message: err.message || "Google sign-in failed" });
          }
        }
      )
    );
  }

  // Microsoft OAuth strategy (only register if credentials are present)
  if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
    passport.use(
      new MicrosoftStrategy(
        {
          clientID: process.env.MICROSOFT_CLIENT_ID,
          clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
          callbackURL: `${getBaseUrl()}/api/auth/microsoft/callback`,
          scope: ["user.read", "openid", "profile", "email"],
          tenant: "common",
          passReqToCallback: true,
        },
        async (req: any, _accessToken: string, _refreshToken: string, profile: any, done: any) => {
          try {
            const email =
              profile.emails?.[0]?.value ||
              profile._json?.mail ||
              profile._json?.userPrincipalName ||
              null;
            const inviteToken = (req.session as any)?.oauthInviteToken || null;
            const { user, isNewSignup } = await findOrCreateOAuthUser({
              provider: "microsoft",
              providerId: profile.id,
              email,
              firstName: profile.name?.givenName || profile._json?.givenName || null,
              lastName: profile.name?.familyName || profile._json?.surname || null,
              profileImageUrl: null,
              inviteToken,
            });
            if (isNewSignup && !isCompAccount(user.email)) {
              const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
              sendSlackNotification(`🎉 New signup (Microsoft): ${user.email} — ${name}`).catch(() => {});
            }
            return done(null, user);
          } catch (err: any) {
            return done(null, false, { message: err.message || "Microsoft sign-in failed" });
          }
        }
      )
    );
  }

  passport.serializeUser((user: any, cb) => cb(null, user.id));
  passport.deserializeUser(async (id: string, cb) => {
    try {
      const user = await authStorage.getUser(id);
      if (!user) return cb(null, null);
      // Soft-delete gate: treat soft-deleted users as not authenticated for all API calls.
      // Defense in depth: also check account.deleted_at in case the two get out of sync.
      if (user.deletedAt) return cb(null, null);
      if (user.accountId) {
        const [account] = await db
          .select({ deletedAt: accounts.deletedAt })
          .from(accounts)
          .where(eq(accounts.id, user.accountId));
        if (account?.deletedAt) return cb(null, null);
      }
      cb(null, user);
    } catch (error) {
      cb(error);
    }
  });

  app.get("/api/invitations/validate/:token", async (req, res) => {
    try {
      const { token } = req.params;
      const [invitation] = await db.select().from(invitations).where(
        and(eq(invitations.token, token), eq(invitations.status, "pending"))
      );
      if (!invitation || new Date() > invitation.expiresAt) {
        return res.status(404).json({ message: "Invalid or expired invitation" });
      }
      const [account] = await db.select().from(accounts).where(eq(accounts.id, invitation.accountId));
      res.json({
        email: invitation.email,
        firstName: invitation.firstName,
        lastName: invitation.lastName,
        role: invitation.role,
        accountName: account?.name || "Team",
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to validate invitation" });
    }
  });

  app.post("/api/register", registerLimiter, async (req, res) => {
    try {
      const { recaptchaToken } = req.body;
      const recaptchaResult = await verifyRecaptchaToken(recaptchaToken, "signup");
      if (!recaptchaResult.valid) {
        console.warn(`[register] reCAPTCHA failed for ${req.body.email}: ${recaptchaResult.reason}, score: ${recaptchaResult.score}`);
        return res.status(403).json({
          error: "security_check_failed",
          message: "Security verification failed. Please try again.",
        });
      }

      if (req.body.termsAccepted !== true) {
        return res.status(400).json({ message: "You must accept the Terms of Service and Privacy Policy to continue." });
      }

      const { email: rawEmail, password, companyName, inviteToken } = req.body;

      if (!rawEmail || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      // Session 3 BUG 1 fix: normalize email casing so the duplicate check
      // and the eventual users.email row are case-insensitive (matches how
      // login + invite-email comparisons already lowercase).
      const email = String(rawEmail).trim().toLowerCase();

      if (password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      const existing = await authStorage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "An account with this email already exists" });
      }

      if (!inviteToken && (!companyName || !companyName.trim())) {
        return res.status(400).json({ message: "Company name is required" });
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      let accountId: string = "";
      let role: string = "standard";
      let firstName: string | null = null;
      let lastName: string | null = null;

      if (inviteToken) {
        const [invitation] = await db.select().from(invitations).where(
          and(eq(invitations.token, inviteToken), eq(invitations.status, "pending"))
        );
        if (!invitation || new Date() > invitation.expiresAt) {
          return res.status(400).json({ message: "Invalid or expired invitation" });
        }
        if (invitation.email.toLowerCase() !== email.toLowerCase()) {
          return res.status(400).json({ message: "Email does not match invitation" });
        }
        accountId = invitation.accountId;
        role = invitation.role;
        firstName = invitation.firstName ?? null;
        lastName = invitation.lastName ?? null;
        await db.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, invitation.id));
      }

      // Session 1 of trial-flow rework: new self-serve signups start in a
      // 14-day no-card trial. Anchor at signup (not email-verify) so the user
      // never floats in the "none"→locked state during onboarding.
      // computeAccessLevel already grants `full` for status="trialing", so no
      // gate change is needed this session. Stripe customer/subscription are
      // NOT created here — that moves to the "Add Card" flow in Session 2.
      let initialSubscriptionStatus: string;
      let initialTrialEndsAt: Date | null;

      if (inviteToken) {
        // Invitee path: copy the EXISTING account's billing fields onto the
        // user row so getAccountBilling's user-fallback path (when
        // ACCOUNT_BILLING_ENABLED is off) does not lock out invitees joining
        // active/trialing accounts. Without this, users.subscriptionStatus
        // defaults to "none" → computeAccessLevel returns "locked".
        const [acct] = await db
          .select({
            subscriptionStatus: accounts.subscriptionStatus,
            trialEndsAt: accounts.trialEndsAt,
          })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1);
        initialSubscriptionStatus = acct?.subscriptionStatus ?? "none";
        initialTrialEndsAt = acct?.trialEndsAt ?? null;
      } else {
        initialSubscriptionStatus = "trialing";
        initialTrialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
        const [account] = await db.insert(accounts).values({
          name: companyName.trim().slice(0, 200),
          subscriptionStatus: initialSubscriptionStatus,
          trialEndsAt: initialTrialEndsAt,
        }).returning();
        accountId = account.id;
        role = "admin";
      }

      const user = await authStorage.upsertUser({
        email,
        password: hashedPassword,
        firstName,
        lastName,
        role,
        accountId,
        emailVerified: false,
        // Mirror billing onto the user row to keep getAccountBilling's
        // user-fallback path consistent with the account-source path.
        subscriptionStatus: initialSubscriptionStatus,
        trialEndsAt: initialTrialEndsAt,
        termsAcceptedAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
        // Invitees skip the /welcome step (their account is already configured
        // by the admin who invited them); trial signups must complete it.
        profileCompletedAt: inviteToken ? new Date() : null,
      });

      if (!isCompAccount(user.email)) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
        sendSlackNotification(`🎉 New signup: ${user.email} — ${name}`).catch(() => {});
      }

      if (inviteToken) {
        const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
        const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await db.update(users).set({
          verificationCode: code,
          verificationCodeExpiresAt: codeExpiresAt,
          verificationCodeAttempts: 0,
          verificationCodeSentAt: new Date(),
        }).where(eq(users.id, user.id));

        try {
          await sendEmailVerificationEmail(user.email!, code, user.firstName);
        } catch (emailErr) {
          console.error("[register] verification email send failed:", emailErr);
        }
      }
      // Trial signups: verification email moved to PATCH /api/auth/me on the
      // profileCompletedAt null→now() transition (Step 2 completion). Sending
      // here would pull the user to their inbox before they finish onboarding.

      // Invitee branch keeps the legacy "create user, return 201, force login"
      // flow — they were already emailed a verification link above and must
      // click it before signing in cleanly.
      if (inviteToken) {
        return res.status(201).json({
          message: "Please check your email to verify your account.",
          email: user.email,
        });
      }

      // Trial branch: auto-login so the freshly-created user can reach the
      // authenticated /welcome (Step 2) page. Without this, AppContent's auth
      // gate sees !user and bounces them back to /login. Mirrors /api/login's
      // req.login + req.session.save + safeUser-with-billing pattern exactly.
      req.login(user, (loginErr) => {
        if (loginErr) {
          console.error("[register] auto-login failed:", loginErr);
          return res.status(500).json({ message: "Registration succeeded but auto-login failed. Please sign in." });
        }
        req.session.save(async (saveErr) => {
          if (saveErr) {
            console.error("[register] session save failed:", saveErr);
            return res.status(500).json({ message: "Registration succeeded but session save failed. Please sign in." });
          }
          const { password: _pw, ...safeUser } = user as any;
          const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
          return res.status(201).json(safeUserWithBilling);
        });
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/login", loginLimiter, async (req, res, next) => {
    const acctKey = loginAccountLimiter.normalizeKey(req);
    const lockState = await loginAccountLimiter.isLocked(acctKey);
    if (lockState.locked) {
      res.setHeader("Retry-After", String(lockState.retryAfterSeconds));
      return res.status(429).json({
        error: "account_locked",
        message: "Too many failed login attempts. Try again in " + lockState.retryAfterSeconds + " seconds or reset your password.",
        retry_after_seconds: lockState.retryAfterSeconds,
      });
    }

    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) return next(err);
      if (!user) {
        loginAccountLimiter.consumeOnFail(acctKey);
        return res.status(401).json({ message: info?.message || "Invalid email or password" });
      }
      req.login(user, (err) => {
        if (err) return next(err);
        req.session.save(async (saveErr) => {
          if (saveErr) {
            return next(saveErr);
          }
          const { password: _, ...safeUser } = user;
          const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
          return res.json(safeUserWithBilling);
        });
      });
    })(req, res, next);
  });

  // ----- Google OAuth routes -----
  app.get("/api/auth/google", (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.redirect("/login?error=google_not_configured");
    }
    const inviteToken = (req.query.invite as string) || null;
    (req.session as any).oauthInviteToken = inviteToken;
    passport.authenticate("google", {
      scope: ["profile", "email"],
      prompt: "select_account",
    })(req, res, next);
  });

  app.get("/api/auth/google/callback", (req, res, next) => {
    passport.authenticate("google", (err: any, user: any, info: any) => {
      if (err || !user) {
        const msg = encodeURIComponent(info?.message || "Google sign-in failed");
        return res.redirect(`/login?error=${msg}`);
      }
      req.login(user, (loginErr) => {
        if (loginErr) return res.redirect(`/login?error=session`);
        delete (req.session as any).oauthInviteToken;
        res.redirect("/");
      });
    })(req, res, next);
  });

  // ----- Microsoft OAuth routes -----
  app.get("/api/auth/microsoft", (req, res, next) => {
    if (!process.env.MICROSOFT_CLIENT_ID) {
      return res.redirect("/login?error=microsoft_not_configured");
    }
    const inviteToken = (req.query.invite as string) || null;
    (req.session as any).oauthInviteToken = inviteToken;
    passport.authenticate("microsoft", {
      scope: ["user.read", "openid", "profile", "email"],
      prompt: "select_account",
    } as any)(req, res, next);
  });

  app.get("/api/auth/microsoft/callback", (req, res, next) => {
    passport.authenticate("microsoft", (err: any, user: any, info: any) => {
      if (err || !user) {
        const msg = encodeURIComponent(info?.message || "Microsoft sign-in failed");
        return res.redirect(`/login?error=${msg}`);
      }
      req.login(user, (loginErr) => {
        if (loginErr) return res.redirect(`/login?error=session`);
        delete (req.session as any).oauthInviteToken;
        res.redirect("/");
      });
    })(req, res, next);
  });

  // Tells the frontend which OAuth providers are enabled
  app.get("/api/auth/providers", (_req, res) => {
    res.json({
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      microsoft: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
    });
  });

  app.post("/api/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      req.session.destroy((err) => {
        res.clearCookie("connect.sid");
        res.json({ message: "Logged out" });
      });
    });
  });

  app.get("/api/logout", (req, res) => {
    req.logout((err) => {
      req.session.destroy((err) => {
        res.clearCookie("connect.sid");
        res.redirect("/");
      });
    });
  });

  app.post("/api/forgot-password", forgotPasswordLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      const user = await authStorage.getUserByEmail(email);
      if (user) {
        await db.update(passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(and(
            eq(passwordResetTokens.userId, user.id),
            isNull(passwordResetTokens.usedAt)
          ));

        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        await db.insert(passwordResetTokens).values({
          userId: user.id,
          token,
          expiresAt,
        });

        try {
          await sendPasswordResetEmail(email, token);
        } catch (emailErr) {
          console.error("[forgot-password] email send failed:", emailErr);
        }
      }

      res.json({ message: "If an account exists with that email, we've sent password reset instructions." });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({ message: "Request failed" });
    }
  });

  app.post("/api/reset-password", resetPasswordLimiter, async (req, res) => {
    try {
      const { token, password } = req.body;
      if (!token || !password) {
        return res.status(400).json({ message: "Token and password are required" });
      }
      if (password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      const [resetRecord] = await db
        .select()
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.token, token));

      if (!resetRecord) {
        return res.status(400).json({ message: "Invalid or expired reset link" });
      }
      if (resetRecord.usedAt) {
        return res.status(400).json({ message: "This reset link has already been used" });
      }
      if (new Date() > resetRecord.expiresAt) {
        return res.status(400).json({ message: "This reset link has expired. Please request a new one." });
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      await authStorage.updateUser(resetRecord.userId, { password: hashedPassword });

      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, resetRecord.id));

      req.session.destroy((err) => {
        if (err) console.error("Session destroy after password reset:", err);
      });

      res.json({ message: "Password has been reset successfully. You can now sign in." });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ message: "Password reset failed" });
    }
  });

  app.get("/api/verify-email", verifyEmailLimiter, async (_req, res) => {
    return res.status(410).json({
      error: "deprecated",
      message: "Verification has been updated — please return to the app and request a new code.",
    });
  });

  app.post("/api/verify-email-code", verifyEmailLimiter, async (req, res) => {
    try {
      const { email, code } = req.body;
      if (!email || typeof email !== "string" || !code || typeof code !== "string") {
        return res.status(400).json({ error: "bad_request", message: "Email and code are required." });
      }

      const user = await authStorage.getUserByEmail(email);
      if (!user) {
        return res.status(404).json({ error: "user_not_found", message: "No account found for this email." });
      }

      if (user.emailVerified) {
        return res.status(200).json({ already_verified: true });
      }

      if (!user.verificationCode) {
        return res.status(410).json({ error: "no_active_code", message: "No active verification code. Request a new one." });
      }

      if ((user.verificationCodeAttempts ?? 0) >= 5) {
        await db.update(users).set({ verificationCode: null }).where(eq(users.id, user.id));
        console.warn("[verify-email-code] too_many_attempts, code invalidated", { userId: user.id });
        return res.status(429).json({ error: "too_many_attempts", message: "Too many wrong attempts. Request a new code." });
      }

      if (user.verificationCodeExpiresAt && user.verificationCodeExpiresAt < new Date()) {
        console.warn("[verify-email-code] code_expired", {
          userId: user.id,
          expiredAgoMs: Date.now() - user.verificationCodeExpiresAt.getTime(),
        });
        return res.status(410).json({ error: "code_expired", message: "Code expired. Request a new code." });
      }

      if (code !== user.verificationCode) {
        const newAttempts = (user.verificationCodeAttempts ?? 0) + 1;
        await db.update(users).set({ verificationCodeAttempts: newAttempts }).where(eq(users.id, user.id));
        console.warn("[verify-email-code] invalid_code", { userId: user.id, attempts: newAttempts });
        return res.status(401).json({ error: "invalid_code", remaining_attempts: 5 - newAttempts });
      }

      await db.update(users).set({
        emailVerified: true,
        verificationCode: null,
        verificationCodeAttempts: 0,
      }).where(eq(users.id, user.id));

      console.info("[verify-email-code] verified", { userId: user.id, email: user.email });

      sendWelcomeEmail(user.email!, user.firstName).catch((err) => {
        console.error("[verify-email-code] welcome email send failed:", err);
      });

      const [verifiedUser] = await db.select().from(users).where(eq(users.id, user.id));
      if (!verifiedUser) {
        return res.json({ verified: true });
      }

      req.login(verifiedUser, (err) => {
        if (err) {
          console.error("[verify-email-code] req.login failed:", err);
          return res.json({ verified: true });
        }
        const { password: _, ...safeUser } = verifiedUser;
        res.json({ verified: true, user: safeUser });
      });
    } catch (error) {
      console.error("Verify email code error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  app.post("/api/resend-verification", resendVerificationLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      const [user] = await db.select().from(users).where(eq(users.email, email));

      if (!user || user.emailVerified) {
        return res.json({ message: "If an unverified account exists, a new verification code has been sent." });
      }

      if (user.verificationCodeSentAt) {
        const elapsed = Date.now() - user.verificationCodeSentAt.getTime();
        const remaining = Math.ceil((60_000 - elapsed) / 1000);
        if (remaining > 0) {
          return res.status(429).json({
            error: "Please wait before requesting another code.",
            retry_after_seconds: remaining,
          });
        }
      }

      const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
      const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
      await db.update(users).set({
        verificationCode: code,
        verificationCodeExpiresAt: codeExpiresAt,
        verificationCodeAttempts: 0,
        verificationCodeSentAt: new Date(),
      }).where(eq(users.id, user.id));

      try {
        await sendEmailVerificationEmail(user.email!, code, user.firstName);
      } catch (err) {
        console.error("[resend-verification] email send failed:", err);
      }

      res.json({ message: "If an unverified account exists, a new verification code has been sent." });
    } catch (error) {
      console.error("Resend verification error:", error);
      res.status(500).json({ error: "Request failed" });
    }
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

export const requireActiveSubscription: RequestHandler = async (req: any, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const billing = await getAccountBilling(req);
  const status = billing.subscriptionStatus;
  if (status === "active") {
    return next();
  }

  // Session 2 trial-flow rework: 'trialing' (and the legacy 'trial')
  // honour the app-side trialEndsAt deadline. Future → write allowed.
  // Expired → 402 with error:'trial_expired' so the client global
  // interceptor can surface a single debounced "Add a card" toast and
  // the BillingBanner can render the red expired-trial state.
  if (status === "trialing" || status === "trial") {
    const trialEndsAt = billing.trialEndsAt ? new Date(billing.trialEndsAt) : null;
    if (trialEndsAt && trialEndsAt > new Date()) {
      return next();
    }
    return res.status(402).json({
      error: "trial_expired",
      message: "Your trial has ended. Add a card to continue.",
      accessLevel: "read_only",
    });
  }

  return res.status(402).json({ message: "Subscription required", accessLevel: "locked" });
};

export const requireReadAccess: RequestHandler = async (req: any, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const billing = await getAccountBilling(req);
  const level = computeAccessLevel(
    billing.subscriptionStatus,
    billing.subscriptionLapsedAt,
    billing.trialEndsAt,
  );
  if (level === "full" || level === "read_only") {
    return next();
  }
  return res.status(402).json({ message: "Subscription required", accessLevel: "locked" });
};

export const requireWriteAccess: RequestHandler = async (req: any, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const billing = await getAccountBilling(req);
  const level = computeAccessLevel(
    billing.subscriptionStatus,
    billing.subscriptionLapsedAt,
    billing.trialEndsAt,
  );
  if (level === "full") {
    return next();
  }
  // Session 2 trial-flow rework: distinguish expired-trial from
  // generic-locked so the client global interceptor (queryClient.ts)
  // can fire a single debounced "Add a card" toast and the
  // BillingBanner can render the red trial-expired state.
  const status = billing.subscriptionStatus;
  if (
    level === "read_only" &&
    (status === "trialing" || status === "trial")
  ) {
    return res.status(402).json({
      error: "trial_expired",
      message: "Your trial has ended. Add a card to continue.",
      accessLevel: "read_only",
    });
  }
  return res.status(402).json({ message: "Subscription required", accessLevel: level });
};
