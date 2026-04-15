import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import connectPg from "connect-pg-simple";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { authStorage } from "./storage";
import { db, pool } from "../../db";
import { eq, and } from "drizzle-orm";
import { passwordResetTokens, accounts, invitations } from "@shared/models/auth";

export function getSession() {
  const sessionTtlSeconds = 7 * 24 * 60 * 60;
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
          return done(null, user);
        } catch (error) {
          return done(error);
        }
      }
    )
  );

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

  app.post("/api/register", async (req, res) => {
    try {
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
        subscriptionStatus: "none",
        trialEndsAt: null,
      });

      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({ message: "Failed to log in after registration" });
        }
        const { password: _, ...safeUser } = user;
        return res.status(201).json(safeUser);
      });
    } catch (error) {
      console.error("Registration error:", error);
      res.status(500).json({ message: "Registration failed" });
    }
  });

  app.post("/api/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ message: info?.message || "Invalid email or password" });
      }
      req.login(user, (err) => {
        if (err) return next(err);
        const { password: _, ...safeUser } = user;
        return res.json(safeUser);
      });
    })(req, res, next);
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

  app.post("/api/forgot-password", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ message: "Email is required" });
      }

      const user = await authStorage.getUserByEmail(email);
      if (user) {
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

        await db.insert(passwordResetTokens).values({
          userId: user.id,
          token,
          expiresAt,
        });

        const baseUrl = `${req.protocol}://${req.get("host")}`;
        const resetLink = `${baseUrl}/reset-password?token=${token}`;

        if (process.env.NODE_ENV !== "production") {
          console.log(`[Password Reset] Link for ${email}: ${resetLink}`);
        }
      }

      res.json({ message: "If an account exists with that email, we've sent password reset instructions." });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({ message: "Request failed" });
    }
  });

  app.post("/api/reset-password", async (req, res) => {
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

      res.json({ message: "Password has been reset successfully. You can now sign in." });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ message: "Password reset failed" });
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
