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
import { eq, and, isNull, gt } from "drizzle-orm";
import { passwordResetTokens, emailVerificationTokens, users, accounts, invitations, type User } from "@shared/models/auth";
import { sendPasswordResetEmail, sendEmailVerificationEmail, sendWelcomeEmail } from "../../services/email";
import { verifyRecaptchaToken } from "../../services/recaptcha";
import { CURRENT_TERMS_VERSION } from "@shared/constants";
import {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  resendVerificationLimiter,
  verifyEmailLimiter,
} from "../../middleware/rate-limit";

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
}): Promise<User> {
  const providerIdField = opts.provider === "google" ? "googleId" : "microsoftId";

  // 1. Match by provider id (returning user)
  const byProvider = opts.provider === "google"
    ? await authStorage.getUserByGoogleId(opts.providerId)
    : await authStorage.getUserByMicrosoftId(opts.providerId);
  if (byProvider) return byProvider;

  // 2. Match by email — link the provider id to the existing account
  if (opts.email) {
    const existing = await authStorage.getUserByEmail(opts.email);
    if (existing) {
      const updated = await authStorage.updateUser(existing.id, {
        [providerIdField]: opts.providerId,
        firstName: existing.firstName || opts.firstName || null,
        lastName: existing.lastName || opts.lastName || null,
        profileImageUrl: existing.profileImageUrl || opts.profileImageUrl || null,
      } as any);
      return updated!;
    }
  }

  // 3. Brand new user. Honor invite token if present, else create a new team.
  if (!opts.email) {
    throw new Error("Email permission was not granted by the OAuth provider");
  }

  let accountId: string;
  let role: string;

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
    if (invitation.email.toLowerCase() !== opts.email.toLowerCase()) {
      throw new Error("Email does not match invitation");
    }
    accountId = invitation.accountId;
    role = invitation.role;
    await db.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, invitation.id));
  } else {
    const accountName = [opts.firstName, opts.lastName].filter(Boolean).join(" ") || opts.email;
    const [account] = await db.insert(accounts).values({ name: accountName + "'s Team" }).returning();
    accountId = account.id;
    role = "admin";
  }

  return authStorage.upsertUser({
    email: opts.email,
    firstName: opts.firstName || null,
    lastName: opts.lastName || null,
    profileImageUrl: opts.profileImageUrl || null,
    authProvider: opts.provider,
    [providerIdField]: opts.providerId,
    role,
    accountId,
    emailVerified: true,
    subscriptionStatus: "none",
    trialEndsAt: null,
  } as any);
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

  passport.use(
    new LocalStrategy(
      { usernameField: "email", passwordField: "password" },
      async (email, password, done) => {
        try {
          const user = await authStorage.getUserByEmail(email);
          if (!user || !user.password) {
            return done(null, false, { message: "Invalid email or password" });
          }
          const isValid = await bcrypt.compare(password, user.password);
          if (!isValid) {
            return done(null, false, { message: "Invalid email or password" });
          }
          if (user.authProvider === "local" && !user.emailVerified) {
            return done(null, false, { message: "email_not_verified" });
          }
          return done(null, user);
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
            const user = await findOrCreateOAuthUser({
              provider: "google",
              providerId: profile.id,
              email,
              firstName: profile.name?.givenName || null,
              lastName: profile.name?.familyName || null,
              profileImageUrl: profile.photos?.[0]?.value || null,
              inviteToken,
            });
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
            const user = await findOrCreateOAuthUser({
              provider: "microsoft",
              providerId: profile.id,
              email,
              firstName: profile.name?.givenName || profile._json?.givenName || null,
              lastName: profile.name?.familyName || profile._json?.surname || null,
              profileImageUrl: null,
              inviteToken,
            });
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
      cb(null, user || null);
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

      const { email, password, firstName, lastName, inviteToken } = req.body;

      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      if (password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      const existing = await authStorage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({ message: "An account with this email already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      let accountId: string;
      let role: string;

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
        await db.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, invitation.id));
      } else {
        const accountName = [firstName, lastName].filter(Boolean).join(" ") || email;
        const [account] = await db.insert(accounts).values({ name: accountName + "'s Team" }).returning();
        accountId = account.id;
        role = "admin";
      }

      const user = await authStorage.upsertUser({
        email,
        password: hashedPassword,
        firstName: firstName || null,
        lastName: lastName || null,
        role,
        accountId,
        emailVerified: false,
        subscriptionStatus: "none",
        trialEndsAt: null,
        termsAcceptedAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
      });

      const verificationToken = crypto.randomBytes(32).toString("hex");
      await db.insert(emailVerificationTokens).values({
        userId: user.id,
        token: verificationToken,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      try {
        await sendEmailVerificationEmail(user.email!, verificationToken, user.firstName);
      } catch (emailErr) {
        console.error("[register] verification email send failed:", emailErr);
      }

      return res.status(201).json({
        message: "Please check your email to verify your account.",
        email: user.email,
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/login", loginLimiter, (req, res, next) => {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) return next(err);
      if (!user) {
        if (info?.message === "email_not_verified") {
          return res.status(403).json({ error: "email_not_verified", email: req.body.email });
        }
        return res.status(401).json({ message: info?.message || "Invalid email or password" });
      }
      req.login(user, (err) => {
        if (err) return next(err);
        console.log("[login-diag] req.login complete, sessionID:", req.sessionID, "session.passport:", (req.session as any)?.passport);
        req.session.save((saveErr) => {
          if (saveErr) {
            console.log("[login-diag] session.save ERROR:", saveErr);
            return next(saveErr);
          }
          console.log("[login-diag] session.save complete, sessionID:", req.sessionID);
          const { password: _, ...safeUser } = user;
          return res.json(safeUser);
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

  app.get("/api/verify-email", verifyEmailLimiter, async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.status(400).json({ error: "Token required" });

      const [row] = await db.select().from(emailVerificationTokens).where(eq(emailVerificationTokens.token, token));
      if (!row) return res.status(400).json({ error: "Invalid token" });
      if (row.usedAt) return res.status(400).json({ error: "Token already used" });
      if (row.expiresAt < new Date()) return res.status(400).json({ error: "Token expired" });

      await db.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId));
      await db.update(emailVerificationTokens).set({ usedAt: new Date() }).where(eq(emailVerificationTokens.id, row.id));

      const [verifiedUser] = await db.select().from(users).where(eq(users.id, row.userId));
      if (!verifiedUser) {
        return res.json({ success: true, message: "Email verified successfully" });
      }

      // Fire-and-forget welcome email — never block verification on send failure
      sendWelcomeEmail(verifiedUser.email!, verifiedUser.firstName).catch((err) => {
        console.error("[verify-email] welcome email send failed:", err);
      });

      req.login(verifiedUser, (err) => {
        if (err) {
          console.error("[verify-email] req.login failed:", err);
          return res.json({ success: true, message: "Email verified successfully" });
        }
        const { password: _, ...safeUser } = verifiedUser;
        res.json({ success: true, message: "Email verified successfully", user: safeUser });
      });
    } catch (error) {
      console.error("Verify email error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  app.post("/api/resend-verification", resendVerificationLimiter, async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });

      const [user] = await db.select().from(users).where(eq(users.email, email));

      if (!user || user.emailVerified) {
        return res.json({ message: "If an unverified account exists, a new verification email has been sent." });
      }

      const [recentToken] = await db.select().from(emailVerificationTokens)
        .where(and(
          eq(emailVerificationTokens.userId, user.id),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.createdAt, new Date(Date.now() - 60 * 1000))
        ))
        .limit(1);
      if (recentToken) {
        return res.status(429).json({ error: "Please wait a moment before requesting another verification email." });
      }

      await db.update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(and(
          eq(emailVerificationTokens.userId, user.id),
          isNull(emailVerificationTokens.usedAt)
        ));

      const token = crypto.randomBytes(32).toString("hex");
      await db.insert(emailVerificationTokens).values({
        userId: user.id,
        token,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      try {
        await sendEmailVerificationEmail(user.email!, token, user.firstName);
      } catch (err) {
        console.error("[resend-verification] email send failed:", err);
      }

      res.json({ message: "If an unverified account exists, a new verification email has been sent." });
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

  const status = user.subscriptionStatus;
  if (status === "active" || status === "trialing") {
    return next();
  }

  if (status === "trial") {
    const trialEndsAt = user.trialEndsAt ? new Date(user.trialEndsAt) : null;
    if (trialEndsAt && trialEndsAt > new Date()) {
      return next();
    }
    return res.status(403).json({ message: "Trial expired" });
  }

  return res.status(403).json({ message: "Subscription required" });
};
