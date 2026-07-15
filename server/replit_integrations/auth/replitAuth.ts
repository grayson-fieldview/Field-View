import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
// @ts-ignore - no types published for passport-microsoft
import { Strategy as MicrosoftStrategy } from "passport-microsoft";
import session from "express-session";
import cookieParser from "cookie-parser";
import type { Express, RequestHandler, Request } from "express";
import connectPg from "connect-pg-simple";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { authStorage } from "./storage";
import { db, pool } from "../../db";
import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { passwordResetTokens, users, accounts, invitations, type User } from "@shared/models/auth";
import { projectAssignments } from "@shared/schema";
import { sendPasswordResetEmail, sendEmailVerificationEmail, sendAccountRestoredEmail } from "../../services/email";
import { getAccountBilling, overlayAccountBillingOnUser, computeAccessLevel } from "../../lib/billing";
import { sanitizeUserForViewer } from "../../lib/userVisibility";
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
import { sendGhlEvent } from "../../lib/ghl";
import { normalizeEmail } from "../../lib/normalizeEmail";
import { csrfGuard } from "../../middleware/csrf";
import { touchLastActive } from "../../middleware/touch-last-active";
import { attributionCapture } from "../../middleware/attribution";

// Slack "team member joined" alert for invite acceptances. Fully
// fire-and-forget: the account-name lookup and the Slack post both run
// detached from the request path, and any failure degrades gracefully
// (falls back to the account id, then to omitting the company entirely).
function notifyTeamMemberJoined(
  user: Pick<User, "id" | "email" | "firstName" | "lastName" | "accountId">,
): void {
  void (async () => {
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
    let company = "";
    try {
      if (user.accountId != null) {
        const [acct] = await db
          .select({ name: accounts.name })
          .from(accounts)
          .where(eq(accounts.id, user.accountId))
          .limit(1);
        company = acct?.name?.trim() || `account ${user.accountId}`;
      }
    } catch {
      company = user.accountId != null ? `account ${user.accountId}` : "";
    }
    const suffix = company ? ` → ${company}` : "";
    await sendSlackNotification(`➕ Team member joined: ${user.email} — ${name}${suffix}`);
  })().catch(() => {});
}

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
}): Promise<{
  user: User;
  isNewSignup: boolean;
  // S46 GHL: true ONLY when a brand-new self-serve account was created here
  // (branch 3, no invite). False for returning users, email-linked sign-ins,
  // AND invite acceptances — partial_signup must not fire for those.
  isNewAccount: boolean;
  // Name of the freshly-created account (null unless isNewAccount).
  newAccountName: string | null;
}> {
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
    return { user: restoreResult.user, isNewSignup: false, isNewAccount: false, newAccountName: null };
  }

  // 2. Match by email — link the provider id to the existing account.
  // Normalized for symmetry with /api/register.
  const normalizedEmail = normalizeEmail(opts.email) || null;
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
      return { user: updated!, isNewSignup: false, isNewAccount: false, newAccountName: null };
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
  // S41: stash the validated invitation here so we can run the
  // applyInvitationAcceptance tx AFTER the user row is created.
  let invitationForAssignment: typeof invitations.$inferSelect | null = null;
  let isNewAccount = false;
  let newAccountName: string | null = null;

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
    if (normalizeEmail(invitation.email) !== normalizedEmail) {
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
    // S41: defer status flip + project_assignments seed until after user upsert.
    invitationForAssignment = invitation;
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
    isNewAccount = true;
    newAccountName = account.name;
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

  // S46 GHL: stamp the self-serve creator as account owner, mirroring
  // /api/register. Done after upsertUser because the user id only exists
  // now. Without this, OAuth-created accounts had owner_id NULL, which
  // would skip the owner-gated trial_started event.
  if (isNewAccount) {
    await db.update(accounts).set({ ownerId: created.id }).where(eq(accounts.id, accountId));
  }

  // S41: invite acceptance — atomically mark invitation accepted and seed
  // project_assignments for any restricted-role pre-assignments. If a
  // referenced project was deleted between invite-send and acceptance,
  // the FK violation rolls back BOTH the status flip and the assignments
  // (invitation stays pending — admin can cancel/resend or re-invite).
  if (invitationForAssignment) {
    await applyInvitationAcceptance(invitationForAssignment, created.id);
  }

  return { user: created, isNewSignup: true, isNewAccount, newAccountName };
}

// S46 — persist first-touch marketing attribution onto a freshly-created user
// row. Shared by /api/register and the Google/Microsoft OAuth callbacks (the
// session survives the OAuth redirect round-trip — same mechanism as
// oauthInviteToken). Non-fatal by design: an attribution write failure must
// never block signup.
async function persistSignupAttribution(req: any, userId: string): Promise<void> {
  try {
    const attr = (req.session?.attribution ?? {}) as Record<string, string | undefined>;
    const fbp = req.cookies?._fbp ?? null;
    const fbc = req.cookies?._fbc ?? null;
    await db.update(users).set({
      signupReferrer: attr.referrer ?? null,
      signupUtmSource: attr.utm_source ?? null,
      signupUtmMedium: attr.utm_medium ?? null,
      signupUtmCampaign: attr.utm_campaign ?? null,
      signupUtmContent: attr.utm_content ?? null,
      signupUtmTerm: attr.utm_term ?? null,
      signupFbclid: attr.fbclid ?? null,
      signupFbp: fbp,
      signupFbc: fbc,
    }).where(eq(users.id, userId));
  } catch (attrErr) {
    console.warn("[attribution] signup write failed (non-fatal):", attrErr);
    Sentry.captureException(attrErr, {
      tags: { stage: "signup_attribution" },
      level: "warning",
    });
  }
}

/**
 * S41: shared acceptance writer. Wraps "mark invitation accepted" + "seed
 * project_assignments rows" in a single tx. Called from both the password
 * (/api/register) and OAuth (findOrCreateOAuthUser) acceptance paths.
 *
 * Failure semantics: any FK or write failure rolls back BOTH the status flip
 * and any partial assignments. The user row is already created (outside this
 * tx) — they exist and can sign in, but their invitation stays pending so
 * an admin can re-attempt. Worst-case orphan is a created user with role +
 * accountId but no auto-assignments; a manager can assign manually via
 * POST /api/projects/:id/assignments.
 */
async function applyInvitationAcceptance(
  invitation: typeof invitations.$inferSelect,
  newUserId: string,
): Promise<void> {
  const projectIds = (invitation.assignedProjectIds ?? []) as number[];
  await db.transaction(async (tx) => {
    await tx.update(invitations).set({ status: "accepted" }).where(eq(invitations.id, invitation.id));
    if (projectIds.length > 0) {
      await tx.insert(projectAssignments).values(
        projectIds.map((projectId) => ({
          projectId,
          userId: newUserId,
          assignedById: invitation.invitedById ?? null,
        })),
      );
    }
  });
  if (projectIds.length > 0) {
    console.log(
      `[invite-accept] assigned user ${newUserId} to ${projectIds.length} projects from invitation ${invitation.id}`,
    );
  }
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
    // S44: prune expired session rows every 15 min so the table doesn't
    // grow unbounded under serverless (Vercel) where connections are
    // short-lived and the default cleanup heuristic rarely fires.
    pruneSessionInterval: 60 * 15,
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
  // S46 — cookie-parser mounts first so req.cookies (incl. _fbp/_fbc) is
  // populated for every downstream handler. Does not interfere with the
  // session cookie, which express-session parses internally.
  app.use(cookieParser());
  app.use(getSession());
  // S46 — first-touch marketing attribution. Mounts immediately after
  // getSession() so req.session exists, but BEFORE passport/auth/csrf so
  // landing-page hits from logged-out browsers (including hits that would
  // otherwise be CSRF-blocked or 401'd) still stamp UTM/fbclid into the
  // session for the eventual signup write. Never throws.
  app.use(attributionCapture);
  app.use(passport.initialize());
  app.use(passport.session());
  // S45 — touch users.last_active_at on every authenticated request,
  // throttled to 1 write/user/60s. Fire-and-forget. Must run AFTER
  // passport.session() (needs req.user) and BEFORE csrfGuard so it
  // observes even blocked-by-CSRF requests for activity tracking.
  app.use(touchLastActive);
  // CSRF defense — runs after session/passport so /api/* routes are guarded.
  // See server/middleware/csrf.ts for strategy and CSRF_MODE env var.
  app.use(csrfGuard);

  passport.use(
    new LocalStrategy(
      { usernameField: "email", passwordField: "password", passReqToCallback: true },
      async (req: any, email: string, password: string, done: any) => {
        const logFail = (reason: string) => {
          const normalizedEmail = normalizeEmail(email || "");
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
            const { user, isNewSignup, isNewAccount, newAccountName } = await findOrCreateOAuthUser({
              provider: "google",
              providerId: profile.id,
              email,
              firstName: profile.name?.givenName || null,
              lastName: profile.name?.familyName || null,
              profileImageUrl: profile.photos?.[0]?.value || null,
              inviteToken,
            });
            // Mirrors the GHL partial_signup gate below: alert only on
            // brand-new self-serve accounts, never on invite acceptances.
            if (isNewAccount && !isCompAccount(user.email)) {
              const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
              sendSlackNotification(`🎉 New signup (Google): ${user.email} — ${name}`).catch(() => {});
            } else if (isNewSignup && !isNewAccount && !isCompAccount(user.email)) {
              notifyTeamMemberJoined(user);
            }
            // S46 — persist first-touch UTMs for any freshly-created user row
            // (session survives the OAuth redirect, same as oauthInviteToken).
            if (isNewSignup) {
              await persistSignupAttribution(req, user.id);
            }
            // S46 GHL partial_signup — only on first-time ACCOUNT creation
            // (isNewAccount), never on sign-ins or OAuth invite acceptances.
            if (isNewAccount && !isCompAccount(user.email)) {
              const ghlAttr = (req.session?.attribution ?? {}) as Record<string, string | undefined>;
              sendGhlEvent("partial_signup", {
                email: user.email,
                app_user_id: user.id,
                company_name: newAccountName,
                trial_ends_at: user.trialEndsAt, // trial clock starts NOW, at page 1
                partial_signup_date: new Date().toISOString().slice(0, 10),
                signup_source: ghlAttr.utm_source ?? "direct",
                utm_medium: ghlAttr.utm_medium ?? null,
                utm_campaign: ghlAttr.utm_campaign ?? null,
                signup_method: "google",
              });
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
            const { user, isNewSignup, isNewAccount, newAccountName } = await findOrCreateOAuthUser({
              provider: "microsoft",
              providerId: profile.id,
              email,
              firstName: profile.name?.givenName || profile._json?.givenName || null,
              lastName: profile.name?.familyName || profile._json?.surname || null,
              profileImageUrl: null,
              inviteToken,
            });
            // Mirrors the GHL partial_signup gate below: alert only on
            // brand-new self-serve accounts, never on invite acceptances.
            if (isNewAccount && !isCompAccount(user.email)) {
              const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
              sendSlackNotification(`🎉 New signup (Microsoft): ${user.email} — ${name}`).catch(() => {});
            } else if (isNewSignup && !isNewAccount && !isCompAccount(user.email)) {
              notifyTeamMemberJoined(user);
            }
            // S46 — persist first-touch UTMs for any freshly-created user row
            // (session survives the OAuth redirect, same as oauthInviteToken).
            if (isNewSignup) {
              await persistSignupAttribution(req, user.id);
            }
            // S46 GHL partial_signup — only on first-time ACCOUNT creation
            // (isNewAccount), never on sign-ins or OAuth invite acceptances.
            if (isNewAccount && !isCompAccount(user.email)) {
              const ghlAttr = (req.session?.attribution ?? {}) as Record<string, string | undefined>;
              sendGhlEvent("partial_signup", {
                email: user.email,
                app_user_id: user.id,
                company_name: newAccountName,
                trial_ends_at: user.trialEndsAt, // trial clock starts NOW, at page 1
                partial_signup_date: new Date().toISOString().slice(0, 10),
                signup_source: ghlAttr.utm_source ?? "direct",
                utm_medium: ghlAttr.utm_medium ?? null,
                utm_campaign: ghlAttr.utm_campaign ?? null,
                signup_method: "microsoft",
              });
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
          .select({ deletedAt: accounts.deletedAt, ownerId: accounts.ownerId })
          .from(accounts)
          .where(eq(accounts.id, user.accountId));
        if (account?.deletedAt) return cb(null, null);
        // Attach account ownership so requireOwnerAdmin can gate owner-only
        // routes (e.g. API-key management). deserializeUser is the single
        // place req.user is assembled on every authenticated request.
        (user as any).account = { ownerId: account?.ownerId ?? null };
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

      // Normalize email casing so the duplicate check and the eventual
      // users.email row are case-insensitive (matches how login +
      // invite-email comparisons already lowercase).
      const email = normalizeEmail(String(rawEmail));

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

      let invitationForAssignment: typeof invitations.$inferSelect | null = null;
      if (inviteToken) {
        const [invitation] = await db.select().from(invitations).where(
          and(eq(invitations.token, inviteToken), eq(invitations.status, "pending"))
        );
        if (!invitation || new Date() > invitation.expiresAt) {
          return res.status(400).json({ message: "Invalid or expired invitation" });
        }
        if (normalizeEmail(invitation.email) !== email) {
          return res.status(400).json({ message: "Email does not match invitation" });
        }
        accountId = invitation.accountId;
        role = invitation.role;
        firstName = invitation.firstName ?? null;
        lastName = invitation.lastName ?? null;
        // S41: defer the status flip + project_assignments seed until AFTER
        // the user row is created (so we have newUserId to write into
        // project_assignments.user_id). See applyInvitationAcceptance().
        invitationForAssignment = invitation;
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

      // New self-serve account: stamp its owner as the creating admin. Done here
      // (not at the accounts insert above) because the user id only exists after
      // upsertUser. Owner identity gates owner-only GHL events (e.g.
      // trial_started) so invited users never fire them.
      if (!inviteToken) {
        await db.update(accounts).set({ ownerId: user.id }).where(eq(accounts.id, accountId));
      }

      // S46 — persist marketing attribution onto the freshly-created user
      // row. Reads first-touch UTM/fbclid/referrer from req.session.attribution
      // (populated by attributionCapture middleware on any prior landing-page
      // hit) and _fbp/_fbc from cookies (Pixel sets _fbp; middleware sets _fbc
      // from fbclid). All 9 columns are written in one UPDATE; missing fields
      // land as NULL. Wrapped in try/catch — an attribution write failure
      // must never block signup. PR 4/5 will read these on
      // CompleteRegistration / Subscribe CAPI events.
      await persistSignupAttribution(req, user.id);

      // S41: invite acceptance writer — atomic invitation status flip + project_assignments seed.
      if (invitationForAssignment) {
        await applyInvitationAcceptance(invitationForAssignment, user.id);
      }

      // Mirrors the GHL partial_signup gate below: "New signup" only for
      // self-serve account creations; invite acceptances get a distinct alert.
      if (!inviteToken && !isCompAccount(user.email)) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
        sendSlackNotification(`🎉 New signup: ${user.email} — ${name}`).catch(() => {});
      } else if (inviteToken && !isCompAccount(user.email)) {
        notifyTeamMemberJoined(user);
      }

      // S46 GHL partial_signup — self-serve account creations only (invitees
      // join an existing account, so no lifecycle event). Attribution comes
      // from the same session store the attribution UPDATE above used.
      if (!inviteToken && !isCompAccount(user.email)) {
        const ghlAttr = ((req.session as any)?.attribution ?? {}) as Record<string, string | undefined>;
        sendGhlEvent("partial_signup", {
          email: user.email,
          app_user_id: user.id,
          company_name: companyName.trim().slice(0, 200),
          trial_ends_at: initialTrialEndsAt, // trial clock starts NOW, at page 1
          partial_signup_date: new Date().toISOString().slice(0, 10),
          signup_source: ghlAttr.utm_source ?? "direct",
          utm_medium: ghlAttr.utm_medium ?? null,
          utm_campaign: ghlAttr.utm_campaign ?? null,
          signup_method: "email",
        });
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
          // Send to the canonical stored address, not the raw request value
          // (which may carry stray whitespace/casing).
          await sendPasswordResetEmail(user.email!, token);
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
        // Session 3 BUG 2 fix: return the full user (matching PATCH /api/auth/me
        // and /api/register shapes) so the client can setQueryData this response
        // directly into the auth cache instead of invalidate→refetch (which
        // races with Vercel session-cookie propagation and wipes the user).
        const { password: _pw, ...safeUser } = user as any;
        const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
        return res.status(200).json(sanitizeUserForViewer(safeUserWithBilling, user));
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

      const [verifiedUser] = await db.select().from(users).where(eq(users.id, user.id));
      if (!verifiedUser) {
        return res.status(500).json({ error: "user_not_found_after_verify" });
      }

      // Session 3 BUG 2 fix: respond with the full user object as the
      // top-level body (matching /api/register and PATCH /api/auth/me)
      // so the client can setQueryData(["/api/auth/user"], data) directly
      // and skip the invalidate→refetch race that Commit A identified.
      // overlayAccountBillingOnUser + sanitizeUserForViewer match GET
      // /api/auth/user's shape so the cache seed is byte-equivalent.
      req.login(verifiedUser, async (err) => {
        if (err) {
          console.error("[verify-email-code] req.login failed:", err);
          // Even on relogin failure we still return the user — the client
          // already had a valid session before the verify call, and the
          // existing session cookie remains intact.
        }
        try {
          const { password: _pw, ...safeUser } = verifiedUser as any;
          const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
          res.json(sanitizeUserForViewer(safeUserWithBilling, verifiedUser));
        } catch (overlayErr) {
          console.error("[verify-email-code] overlay/sanitize failed:", overlayErr);
          res.status(500).json({ error: "post_verify_serialization_failed" });
        }
      });
    } catch (error) {
      console.error("Verify email code error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  app.post("/api/resend-verification", resendVerificationLimiter, async (req, res) => {
    try {
      const { email: rawEmail } = req.body;
      if (!rawEmail) return res.status(400).json({ error: "Email required" });
      // Session 3 BUG 4 fix: normalize to match how /api/register stores
      // emails (trim+lowercase) so case-variant resend requests still find
      // the row. Use authStorage.getUserByEmail for a single source of truth.
      const user = await authStorage.getUserByEmail(rawEmail);

      if (!user || user.emailVerified) {
        return res.json({ message: "If an unverified account exists, a new verification code has been sent." });
      }
      // Reuse the normalized email throughout the rest of the handler so
      // outbound mail goes to the canonical address, not the raw input.
      const email = user.email!;

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
