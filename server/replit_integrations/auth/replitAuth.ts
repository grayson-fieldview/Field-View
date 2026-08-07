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
import { eq, and, isNull, isNotNull, gt, desc, sql } from "drizzle-orm";
import { passwordResetTokens, users, accounts, invitations, type User } from "@shared/models/auth";
import { projectAssignments } from "@shared/schema";
import { sendPasswordResetEmail, sendEmailVerificationEmail, sendAccountRestoredEmail } from "../../services/email";
import { getAccountBilling, overlayAccountBillingOnUser, computeAccessLevel } from "../../lib/billing";
import { processApplePurchase } from "../../lib/appleIap";
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
import { sendMetaCapiEvent } from "../../lib/metaCapi";
import { normalizeEmail } from "../../lib/normalizeEmail";
import { waitUntil } from "@vercel/functions";
import { csrfGuard } from "../../middleware/csrf";
import {
  isAppleConfigured,
  generateAppleClientSecret,
  verifyAppleIdToken,
  signAppleState,
  verifyAppleState,
  generateAppleNonce,
  nonceMatches,
} from "../../lib/apple-auth";
import { touchLastActive } from "../../middleware/touch-last-active";
import { attributionCapture } from "../../middleware/attribution";

// Slack "team member joined" alert for invite acceptances. Fully
// fire-and-forget: the account-name lookup and the Slack post both run
// detached from the request path, and any failure degrades gracefully
// (falls back to the account id, then to omitting the company entirely).
function notifyTeamMemberJoined(
  user: Pick<User, "id" | "email" | "firstName" | "lastName" | "accountId">,
): void {
  const promise = (async () => {
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
  // On Vercel, keep the instance alive through the account-name lookup +
  // Slack post (sendSlackNotification registers its own waitUntil, but only
  // once it is actually called — the DB lookup before it needs cover too).
  try {
    waitUntil(promise);
  } catch {
    // Local dev / non-Vercel: dangling promise, rejection swallowed above.
  }
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

// ---------------------------------------------------------------------------
// Google ID-token verification for the mobile endpoint (native SDK tokens).
// No passport strategy involved — verify signature against Google's JWKS
// with Node crypto, then iss / aud / exp. JWKS cached in module scope with
// a TTL honoring Cache-Control max-age (same approach as apple-auth.ts).
// ---------------------------------------------------------------------------

type GoogleIdTokenPayload = {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  email?: string;
  email_verified?: boolean | "true" | "false";
  given_name?: string;
  family_name?: string;
  picture?: string;
  [k: string]: unknown;
};

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

let googleJwksCache: { keys: any[]; expiresAt: number } | null = null;

async function getGoogleJwks(forceRefresh = false): Promise<any[]> {
  if (!forceRefresh && googleJwksCache && Date.now() < googleJwksCache.expiresAt) {
    return googleJwksCache.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`Google JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: any[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error("Google JWKS response had no keys");
  }
  // Honor Cache-Control max-age (Google typically serves ~5-6h); floor at
  // 60s so a weird header can't make us refetch per request.
  const cc = res.headers.get("cache-control") || "";
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 3600);
  const ttlMs = Math.max(60, Number.isFinite(maxAge) ? maxAge : 3600) * 1000;
  googleJwksCache = { keys: body.keys, expiresAt: Date.now() + ttlMs };
  return body.keys;
}

async function verifyGoogleIdToken(
  idToken: string,
  allowedAudiences: string[],
): Promise<GoogleIdTokenPayload> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: GoogleIdTokenPayload;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed id_token JSON");
  }
  if (!header.kid) throw new Error("id_token missing kid");

  // Find the signing key; on unknown kid, force one refresh (key rotation).
  let jwk = (await getGoogleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) {
    jwk = (await getGoogleJwks(true)).find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("id_token signed with unknown key");

  // Google signs id_tokens with RS256.
  const publicKey = crypto.createPublicKey({ key: jwk as any, format: "jwk" });
  const valid = crypto.verify(
    "sha256",
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    Buffer.from(sigB64, "base64url"),
  );
  if (!valid) throw new Error("id_token signature verification failed");

  if (!GOOGLE_ISSUERS.includes(payload.iss)) {
    throw new Error(`id_token iss mismatch: ${payload.iss}`);
  }
  if (!allowedAudiences.includes(payload.aud)) {
    throw new Error(`id_token aud mismatch: ${payload.aud}`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("id_token expired");
  }
  if (!payload.sub) throw new Error("id_token missing sub");

  return payload;
}

async function findOrCreateOAuthUser(opts: {
  provider: "google" | "microsoft" | "apple";
  providerId: string;
  email: string | null;
  // REQUIRED: did the OAuth provider assert this email as verified?
  // Gates the email-based pending-invitation lookup in branch 3 — an
  // unverified address must never be able to claim a pending invite
  // (account-joining via spoofed email). No default on purpose: every
  // caller must state what its provider actually asserted.
  emailVerified: boolean;
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
  const providerIdField =
    opts.provider === "google" ? "googleId" : opts.provider === "apple" ? "appleId" : "microsoftId";

  // 1. Match by provider id (returning user)
  const byProvider = opts.provider === "google"
    ? await authStorage.getUserByGoogleId(opts.providerId)
    : opts.provider === "apple"
      ? await authStorage.getUserByAppleId(opts.providerId)
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

  // Terms acceptance: the OAuth buttons on /login and /register display
  // "By continuing, you agree to the Terms of Service and Privacy Policy",
  // so termsAcceptedAt/termsVersion are stamped at user creation below.

  // Resolve an invitation two ways: explicit token (existing flow), or —
  // when the provider asserted the email as VERIFIED — a pending,
  // unexpired invitation matching the email. Without the email fallback,
  // an invitee who signs in with OAuth but doesn't carry the token forks
  // into a brand-new admin account while their invite keeps holding a seat.
  let matchedInvitation: typeof invitations.$inferSelect | null = null;
  let invitePath: "token_invite" | "email_invite" | "new_account" = "new_account";
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
    matchedInvitation = invitation;
    invitePath = "token_invite";
  } else if (opts.emailVerified) {
    // Verified-email invitation lookup. lower() on the stored side for
    // parity with getUserByEmail (legacy rows may predate normalization);
    // normalizedEmail is already lowercased. Most recent invite wins if an
    // email was invited to multiple accounts.
    const [invitation] = await db
      .select()
      .from(invitations)
      .where(
        and(
          sql`lower(${invitations.email}) = ${normalizedEmail}`,
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(invitations.createdAt))
      .limit(1);
    if (invitation) {
      matchedInvitation = invitation;
      invitePath = "email_invite";
    }
  }

  if (matchedInvitation) {
    accountId = matchedInvitation.accountId;
    role = matchedInvitation.role;
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
    invitationForAssignment = matchedInvitation;
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

  // Which branch-3 path was taken. No PII beyond the account id.
  console.info(
    `[oauth-signup] provider=${opts.provider} path=${invitePath} accountId=${accountId} role=${role}`,
  );

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
    // OAuth consent: the register/login pages show "By continuing, you agree
    // to the Terms of Service and Privacy Policy" next to the OAuth buttons.
    // Same columns POST /api/register writes for the checkbox flow.
    termsAcceptedAt: new Date(),
    termsVersion: CURRENT_TERMS_VERSION,
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

// S46 — resolve first-touch attribution for a signup request: session first
// (populated by the attributionCapture middleware in dev / any Express-served
// page hit), falling back to the client-written fv_attr cookie
// (client/src/lib/attribution.ts). On Vercel, non-/api/* requests are served
// statically and never reach the middleware, so the cookie is the only
// source in prod. Session values win when both exist. Cookie values are
// client-controlled, so they are re-sanitized here: allowlisted keys,
// string-only, trimmed, capped at 500 chars. Never throws; returns {} when
// neither source has data. Shared by persistSignupAttribution() and the
// GHL partial_signup payload construction (email + Google + Microsoft).
function resolveSignupAttribution(req: any): Record<string, string | undefined> {
  const sessionAttr = (req.session?.attribution ?? {}) as Record<string, string | undefined>;
  if (Object.keys(sessionAttr).length > 0) return sessionAttr;
  if (!req.cookies?.fv_attr) return sessionAttr;
  try {
    const parsed = JSON.parse(req.cookies.fv_attr);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const ALLOWED = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "fbclid",
        "referrer",
      ] as const;
      const sanitized: Record<string, string> = {};
      for (const key of ALLOWED) {
        const raw = (parsed as Record<string, unknown>)[key];
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        sanitized[key] = trimmed.slice(0, 500);
      }
      return sanitized;
    }
  } catch {
    // Malformed cookie — ignore, fall through with empty attribution.
  }
  return sessionAttr;
}

// S46 — persist first-touch marketing attribution onto a freshly-created user
// row. Shared by /api/register and the Google/Microsoft OAuth callbacks (the
// session survives the OAuth redirect round-trip — same mechanism as
// oauthInviteToken). Non-fatal by design: an attribution write failure must
// never block signup.
async function persistSignupAttribution(req: any, userId: string): Promise<void> {
  try {
    const attr = resolveSignupAttribution(req);
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

// Serialize exactly like GET /api/auth/user (routes.ts): password strip,
// billing overlay, isOwner + account install-prompt fields, sanitize.
// Module-scoped + exported so EVERY auth-mutation response (mobile OAuth,
// register/mobile, PATCH /api/auth/me, verify-email-code) returns the exact
// GET /api/auth/user shape — the mobile AuthGate makes its paywall decision
// from these POST bodies with no follow-up GET (deliberate: avoids the
// req.login() session-id rotation race), so shape drift breaks the gate.
export async function serializeUserForAuthResponse(user: User, req: any) {
  const { password: _pw, ...safeUser } = user as any;
  const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
  let isOwner = false;
  let accountFirstMobileUploadAt: Date | null = null;
  let accountCreatedAt: Date | null = null;
  let accountPaywallSkippedAt: Date | null = null;
  if (user.accountId) {
    const [account] = await db
      .select({
        ownerId: accounts.ownerId,
        firstMobileUploadAt: accounts.firstMobileUploadAt,
        createdAt: accounts.createdAt,
        paywallSkippedAt: accounts.paywallSkippedAt,
      })
      .from(accounts)
      .where(eq(accounts.id, user.accountId))
      .limit(1);
    isOwner = !!account && account.ownerId === user.id;
    accountFirstMobileUploadAt = account?.firstMobileUploadAt ?? null;
    accountCreatedAt = account?.createdAt ?? null;
    accountPaywallSkippedAt = account?.paywallSkippedAt ?? null;
  }
  return sanitizeUserForViewer(
    { ...safeUserWithBilling, isOwner, accountFirstMobileUploadAt, accountCreatedAt, accountPaywallSkippedAt },
    user,
  );
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  // S46 — cookie-parser mounts first so req.cookies (incl. _fbp/_fbc) is
  // populated for every downstream handler. Does not interfere with the
  // session cookie, which express-session parses internally.
  app.use(cookieParser());
  app.use(getSession());
  // TEMP DIAGNOSTIC 2026-08-06 [authdiag-session] — silent-401 investigation.
  // Runs right after express-session for every /api/* request. express-session
  // does not expose "newly created vs loaded" directly; determination method:
  // parse the incoming connect.sid cookie ("s:<sid>.<sig>", URL-encoded) and
  // compare its sid to req.sessionID. express-session keeps the incoming sid
  // only when the store returned a row for it; on a store miss (or no cookie)
  // it generates a fresh sid. So cookieSid === req.sessionID ⇒ loaded from
  // store; mismatch/absent ⇒ newly created. Never throws; zero behavior
  // change. Remove when investigation closes.
  app.use((req: any, _res, next) => {
    try {
      if (req.path?.startsWith("/api/")) {
        let cookieSid8: string | null = null;
        let cookieArrived = false;
        try {
          const rawCookieHeader = req.headers?.cookie || "";
          const match = /(?:^|;\s*)connect\.sid=([^;]+)/.exec(rawCookieHeader);
          if (match) {
            cookieArrived = true;
            let val = decodeURIComponent(match[1]);
            if (val.startsWith("s:")) val = val.slice(2);
            const dot = val.indexOf(".");
            cookieSid8 = (dot > 0 ? val.slice(0, dot) : val).slice(0, 8);
          }
        } catch {}
        const sid8 = typeof req.sessionID === "string" ? req.sessionID.slice(0, 8) : null;
        const loadedFromStore = cookieArrived && cookieSid8 !== null && cookieSid8 === sid8;
        console.info(
          "[authdiag-session]",
          JSON.stringify({
            path: req.path,
            sidCookieArrived: cookieArrived,
            cookieSid8,
            sessionID8: sid8,
            storeReturnedRow: loadedFromStore,
            sessionState: !req.session ? "missing" : loadedFromStore ? "loaded" : "newly_created",
          }),
        );
      }
    } catch {}
    next();
  });
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
            // Google asserts verification via the email_verified claim
            // (surfaced by passport-google-oauth20 as profile.emails[].verified
            // and on the raw _json). Absent claim → false (fail closed).
            const emailVerified =
              profile.emails?.[0]?.verified === true ||
              profile._json?.email_verified === true ||
              profile._json?.email_verified === "true";
            const inviteToken = (req.session as any)?.oauthInviteToken || null;
            const { user, isNewSignup, isNewAccount, newAccountName } = await findOrCreateOAuthUser({
              provider: "google",
              providerId: profile.id,
              email,
              emailVerified,
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
              const ghlAttr = resolveSignupAttribution(req);
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
              // Meta CAPI Lead — same gate as partial_signup above.
              sendMetaCapiEvent({
                eventName: "Lead",
                eventId: crypto.randomUUID(),
                email: user.email!,
                firstName: user.firstName,
                lastName: user.lastName,
                clientIp: req.ip,
                userAgent: req.headers?.["user-agent"],
                fbp: req.cookies?._fbp ?? user.signupFbp,
                fbc: req.cookies?._fbc ?? user.signupFbc,
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
            // Microsoft (Graph /me via passport-microsoft) supplies NO
            // email-verified claim: `mail` / `userPrincipalName` carry no
            // verification assertion. Fail closed — email-invite matching
            // is disabled for Microsoft sign-ins.
            const { user, isNewSignup, isNewAccount, newAccountName } = await findOrCreateOAuthUser({
              provider: "microsoft",
              providerId: profile.id,
              email,
              emailVerified: false,
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
              const ghlAttr = resolveSignupAttribution(req);
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
              // Meta CAPI Lead — same gate as partial_signup above.
              sendMetaCapiEvent({
                eventName: "Lead",
                eventId: crypto.randomUUID(),
                email: user.email!,
                firstName: user.firstName,
                lastName: user.lastName,
                clientIp: req.ip,
                userAgent: req.headers?.["user-agent"],
                fbp: req.cookies?._fbp ?? user.signupFbp,
                fbc: req.cookies?._fbc ?? user.signupFbc,
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
    // TEMP DIAGNOSTIC 2026-08-06 [authdiag-deser] — silent-401 investigation.
    // Records every invocation + which exit was taken. Logging failures are
    // swallowed; zero behavior change. Remove when investigation closes.
    const diag: any = {
      userId8: typeof id === "string" ? id.slice(0, 8) : String(id).slice(0, 8),
      gotUser: false,
      userDeletedAt: null as string | null,
      accountLookupRan: false,
      accountDeletedAt: null as string | null,
      exit: "unknown",
    };
    const diagLog = () => {
      try {
        console.info("[authdiag-deser]", JSON.stringify(diag));
      } catch {}
    };
    try {
      const user = await authStorage.getUser(id);
      diag.gotUser = !!user; // TEMP DIAGNOSTIC 2026-08-06
      if (!user) {
        diag.exit = "cb_null_no_user"; // TEMP DIAGNOSTIC 2026-08-06
        diagLog();
        return cb(null, null);
      }
      diag.userDeletedAt = user.deletedAt ? String(user.deletedAt) : null; // TEMP DIAGNOSTIC 2026-08-06
      // Soft-delete gate: treat soft-deleted users as not authenticated for all API calls.
      // Defense in depth: also check account.deleted_at in case the two get out of sync.
      if (user.deletedAt) {
        diag.exit = "cb_null_user_deleted"; // TEMP DIAGNOSTIC 2026-08-06
        diagLog();
        return cb(null, null);
      }
      if (user.accountId) {
        diag.accountLookupRan = true; // TEMP DIAGNOSTIC 2026-08-06
        const [account] = await db
          .select({ deletedAt: accounts.deletedAt, ownerId: accounts.ownerId })
          .from(accounts)
          .where(eq(accounts.id, user.accountId));
        diag.accountDeletedAt = account?.deletedAt ? String(account.deletedAt) : null; // TEMP DIAGNOSTIC 2026-08-06
        if (account?.deletedAt) {
          diag.exit = "cb_null_account_deleted"; // TEMP DIAGNOSTIC 2026-08-06
          diagLog();
          return cb(null, null);
        }
        // Attach account ownership so requireOwnerAdmin can gate owner-only
        // routes (e.g. API-key management). deserializeUser is the single
        // place req.user is assembled on every authenticated request.
        (user as any).account = { ownerId: account?.ownerId ?? null };
      }
      diag.exit = "cb_success"; // TEMP DIAGNOSTIC 2026-08-06
      diagLog();
      cb(null, user);
    } catch (error) {
      diag.exit = "cb_error"; // TEMP DIAGNOSTIC 2026-08-06
      diagLog();
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
      let metaLeadFired = false;
      if (!inviteToken && !isCompAccount(user.email)) {
        const ghlAttr = resolveSignupAttribution(req);
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
        // Meta CAPI Lead — same gate as partial_signup above. eventId comes
        // from the client (metaEventId in the POST body) so the browser
        // pixel's Lead and this server event dedupe in Meta; falls back to a
        // fresh UUID when the client didn't send one.
        const rawMetaEventId = req.body?.metaEventId;
        const metaEventId =
          typeof rawMetaEventId === "string" && rawMetaEventId.length > 0 && rawMetaEventId.length <= 64
            ? rawMetaEventId
            : crypto.randomUUID();
        sendMetaCapiEvent({
          eventName: "Lead",
          eventId: metaEventId,
          email: user.email!,
          clientIp: req.ip,
          userAgent: req.headers?.["user-agent"],
          fbp: req.cookies?._fbp ?? user.signupFbp,
          fbc: req.cookies?._fbc ?? user.signupFbc,
        });
        metaLeadFired = true;
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
          // Meta dedup pairing: tell the client whether the server-side CAPI
          // Lead actually fired (self-serve, non-comp), so the browser pixel
          // fires ONLY when it has a server twin with the same event_id.
          return res.status(201).json(
            metaLeadFired ? { ...safeUserWithBilling, metaLeadFired: true } : safeUserWithBilling,
          );
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
    // Session-cookie hygiene: only touch the session when there is real
    // data. Unconditionally assigning null marked the session modified,
    // defeating saveUninitialized:false — every bot/prefetch hit on this
    // URL minted an anonymous sessions row. Clearing a stale token only
    // mutates sessions that already persisted one (already saved rows).
    if (inviteToken) {
      (req.session as any).oauthInviteToken = inviteToken;
    } else if ((req.session as any).oauthInviteToken) {
      delete (req.session as any).oauthInviteToken;
    }
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
    // Session-cookie hygiene: see the identical guard on the Google route.
    if (inviteToken) {
      (req.session as any).oauthInviteToken = inviteToken;
    } else if ((req.session as any).oauthInviteToken) {
      delete (req.session as any).oauthInviteToken;
    }
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

  // ----- Apple OAuth routes (web) -----
  // No passport strategy: Apple's flow is implemented directly because its
  // callback is a cross-site form POST (response_mode=form_post). With
  // SameSite=Lax the session cookie is NOT sent on that POST, so unlike
  // Google/Microsoft, state and the invite token CANNOT live in the session
  // — they ride in an HMAC-signed `state` parameter instead (see
  // server/lib/apple-auth.ts).
  app.get("/api/auth/apple", (req, res) => {
    if (!process.env.APPLE_SERVICES_ID) {
      return res.redirect("/login?error=apple_not_configured");
    }
    const inviteToken = (req.query.invite as string) || null;
    // Browser binding: the same nonce goes into the signed state AND a
    // SameSite=None cookie. SameSite=None is required — the callback is a
    // cross-site POST from appleid.apple.com, and Lax/Strict cookies are
    // not sent on it. None requires Secure (fine: prod + replit.dev are
    // HTTPS; Apple can't be tested on plain-HTTP localhost anyway).
    const nonce = generateAppleNonce();
    res.cookie("fv_apple_nonce", nonce, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 10 * 60 * 1000,
      path: "/api/auth/apple/callback",
    });
    const params = new URLSearchParams({
      client_id: process.env.APPLE_SERVICES_ID,
      redirect_uri: `${getBaseUrl()}/api/auth/apple/callback`,
      response_type: "code",
      response_mode: "form_post",
      scope: "name email",
      state: signAppleState(inviteToken, nonce),
    });
    res.redirect(`https://appleid.apple.com/auth/authorize?${params.toString()}`);
  });

  // POST, not GET — Apple uses form_post. Bypassed in csrf.ts PATH_BYPASS;
  // the signed state parameter is the CSRF defense for this route.
  app.post("/api/auth/apple/callback", async (req, res) => {
    // 303 (See Other) on every redirect in this handler: the request is a
    // POST, and a 302/307 would be re-issued as POST / by the browser,
    // hitting the SPA static catch-all with a 405. 303 forces GET.
    const fail = (message: string) =>
      res.redirect(303, `/login?error=${encodeURIComponent(message)}`);
    try {
      const { code, state, user: userJson, error: appleError } = req.body || {};
      if (appleError) {
        // e.g. user_cancelled_authorize
        return fail(appleError === "user_cancelled_authorize" ? "Apple sign-in was cancelled" : String(appleError));
      }
      if (!code) return fail("Apple sign-in failed (no code)");

      // Verify HMAC state (integrity) and extract the invite token + nonce.
      const { inviteToken, nonce } = verifyAppleState(state);
      // Browser binding (login-CSRF defense): the nonce cookie set by
      // /api/auth/apple must match the nonce inside the state. Without this,
      // an attacker could mint a valid state + code for THEIR Apple account
      // and cross-site POST it to log a victim into the attacker's account.
      const cookieNonce = req.cookies?.fv_apple_nonce;
      res.clearCookie("fv_apple_nonce", { path: "/api/auth/apple/callback" });
      if (!nonceMatches(cookieNonce, nonce)) {
        console.error("[apple-auth] nonce cookie/state mismatch");
        return fail("Apple sign-in failed");
      }

      // Exchange the code — client secret is generated fresh per request.
      const tokenRes = await fetch("https://appleid.apple.com/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: `${getBaseUrl()}/api/auth/apple/callback`,
          client_id: process.env.APPLE_SERVICES_ID!,
          client_secret: generateAppleClientSecret(),
        }),
      });
      if (!tokenRes.ok) {
        const errBody = await tokenRes.text().catch(() => "");
        console.error("[apple-auth] token exchange failed:", tokenRes.status, errBody.slice(0, 300));
        return fail("Apple sign-in failed (token exchange)");
      }
      const tokenBody = (await tokenRes.json()) as { id_token?: string };
      if (!tokenBody.id_token) return fail("Apple sign-in failed (no id_token)");

      const payload = await verifyAppleIdToken(tokenBody.id_token, [process.env.APPLE_SERVICES_ID!]);

      // Email-verification gate: Apple sends email_verified as boolean true
      // OR the string "true". findOrCreateOAuthUser links to an existing
      // account by email match (branch 2), so an unverified email must never
      // reach it — pass null instead, which forces provider-id-only matching
      // and prevents account takeover via an unverified address.
      const emailVerified =
        payload.email_verified === true || payload.email_verified === "true";
      let email = (payload.email as string) || null;
      if (email && !emailVerified) {
        console.warn(`[apple-auth] unverified email dropped for sub=${payload.sub}`);
        email = null;
      }

      // Apple name gotcha: `user` arrives ONLY on the very first
      // authorization, as JSON in the POST body, and is never sent again.
      let firstName: string | null = null;
      let lastName: string | null = null;
      if (typeof userJson === "string" && userJson) {
        try {
          const parsed = JSON.parse(userJson);
          firstName = parsed?.name?.firstName || null;
          lastName = parsed?.name?.lastName || null;
        } catch {
          // ignore malformed user JSON — name stays null
        }
      }

      const { user, isNewSignup, isNewAccount, newAccountName } = await findOrCreateOAuthUser({
        provider: "apple",
        providerId: payload.sub,
        email,
        // Boolean-or-"true" handling done above; unverified emails are also
        // dropped to null there, so email==null && emailVerified never
        // reaches the invite lookup (it requires normalizedEmail anyway).
        emailVerified,
        firstName,
        lastName,
        profileImageUrl: null,
        inviteToken,
      });

      // Side effects — identical gating to the Google strategy callback.
      if (isNewAccount && !isCompAccount(user.email)) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
        sendSlackNotification(`🎉 New signup (Apple): ${user.email} — ${name}`).catch(() => {});
      } else if (isNewSignup && !isNewAccount && !isCompAccount(user.email)) {
        notifyTeamMemberJoined(user);
      }
      // Attribution: the cross-site POST carries no cookies/session, so this
      // usually resolves to "direct" — kept for parity with Google (it
      // degrades gracefully inside the helpers).
      if (isNewSignup) {
        await persistSignupAttribution(req, user.id);
      }
      if (isNewAccount && !isCompAccount(user.email)) {
        const ghlAttr = resolveSignupAttribution(req);
        sendGhlEvent("partial_signup", {
          email: user.email,
          app_user_id: user.id,
          company_name: newAccountName,
          trial_ends_at: user.trialEndsAt,
          partial_signup_date: new Date().toISOString().slice(0, 10),
          signup_source: ghlAttr.utm_source ?? "direct",
          utm_medium: ghlAttr.utm_medium ?? null,
          utm_campaign: ghlAttr.utm_campaign ?? null,
          signup_method: "apple",
        });
        sendMetaCapiEvent({
          eventName: "Lead",
          eventId: crypto.randomUUID(),
          email: user.email!,
          firstName: user.firstName,
          lastName: user.lastName,
          clientIp: req.ip,
          userAgent: req.headers?.["user-agent"],
          fbp: req.cookies?._fbp ?? user.signupFbp,
          fbc: req.cookies?._fbc ?? user.signupFbc,
        });
      }

      req.login(user, (loginErr) => {
        if (loginErr) return res.redirect(303, `/login?error=session`);
        // Explicit save before redirect: deterministic Set-Cookie on this
        // cross-site POST response (serverless session stores can otherwise
        // race the redirect). Browsers accept Set-Cookie here — SameSite
        // restricts sending, not setting.
        req.session.save((saveErr) => {
          if (saveErr) return res.redirect(303, `/login?error=session`);
          res.redirect(303, "/");
        });
      });
    } catch (err: any) {
      // Log the detail; never leak internal messages (aud mismatch, JWKS
      // errors, etc.) into the user's address bar.
      console.error("[apple-auth] callback failed:", err?.message || err);
      return fail("Apple sign-in failed");
    }
  });

  // ----- Mobile OAuth endpoints (native SDK id_token → session) -----
  // Mobile is cookie-based: the app POSTs a native identity token here, we
  // verify it server-side, establish a normal express-session via
  // req.login(), and return the FULL user object (same shape as GET
  // /api/auth/user) so AuthContext.signIn never needs a follow-up fetch
  // that would race passport's session-id rotation.

  // serializeUserForAuthResponse hoisted to module scope (exported above) so
  // PATCH /api/auth/me and /api/verify-email-code (auth/routes.ts) reuse it.

  // Map findOrCreateOAuthUser's known throws to distinct client-safe 4xx
  // responses (mobile shows different copy per case). Unknown errors → null
  // (caller falls through to its generic 401/500 handling).
  const mapOAuthUserError = (
    err: any,
  ): { status: number; body: { error: string; message: string } } | null => {
    const msg = String(err?.message || "");
    switch (msg) {
      case "Account no longer exists":
        return {
          status: 410,
          body: { error: "account_deleted", message: "This account was deleted and can no longer be restored." },
        };
      case "Email permission was not granted by the OAuth provider":
        return {
          status: 400,
          body: { error: "email_unverified_or_missing", message: "We couldn't verify your email address with Apple or Google. Please sign in with your email and password instead, or contact support@field-view.com." },
        };
      case "Email does not match invitation":
        return {
          status: 403,
          body: { error: "invite_email_mismatch", message: "This invitation was sent to a different email address. Sign in with the invited email." },
        };
      case "Invalid or expired invitation":
        return {
          status: 400,
          body: { error: "invite_invalid", message: "This invitation link is invalid or has expired. Ask your admin to send a new one." },
        };
      default:
        return null;
    }
  };

  // Shared post-verification path: resolve/create the user, fire the same
  // side effects as the web OAuth callbacks (identical gating; all
  // waitUntil-backed since S41), then req.login → session.save → respond
  // with the full serialized user (same pattern as POST /api/login).
  const completeMobileOAuthLogin = async (
    req: any,
    res: any,
    opts: {
      provider: "google" | "apple";
      providerId: string;
      email: string | null;
      emailVerified: boolean;
      firstName: string | null;
      lastName: string | null;
      profileImageUrl: string | null;
      inviteToken: string | null;
    },
  ) => {
    let result: Awaited<ReturnType<typeof findOrCreateOAuthUser>>;
    try {
      result = await findOrCreateOAuthUser(opts);
    } catch (err: any) {
      const mapped = mapOAuthUserError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      console.error(`[${opts.provider}-mobile] findOrCreateOAuthUser failed:`, err?.message || err);
      return res.status(500).json({ message: "Sign-in failed" });
    }
    let { user } = result;
    const { isNewSignup, isNewAccount, newAccountName } = result;

    // Apple sends the user's name ONLY on the very first authorization.
    // If a name arrived but the stored row has none (e.g. returning user
    // whose row predates name capture), persist it. Never overwrite a
    // non-null stored value, and never write nulls over existing names.
    if (!isNewSignup && (opts.firstName || opts.lastName)) {
      const patch: Record<string, string> = {};
      if (opts.firstName && !user.firstName) patch.firstName = opts.firstName;
      if (opts.lastName && !user.lastName) patch.lastName = opts.lastName;
      if (Object.keys(patch).length > 0) {
        try {
          user = (await authStorage.updateUser(user.id, patch as any)) ?? user;
        } catch (nameErr) {
          console.error(`[${opts.provider}-mobile] name backfill failed (non-fatal):`, nameErr);
        }
      }
    }

    // Side effects — identical gating to the web OAuth callbacks. Slack /
    // GHL / notifyTeamMemberJoined are waitUntil-wrapped inside their
    // helpers (S41); Meta CAPI has been waitUntil-based all along.
    if (isNewAccount && !isCompAccount(user.email)) {
      const providerLabel = opts.provider === "apple" ? "Apple mobile" : "Google mobile";
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
      sendSlackNotification(`🎉 New signup (${providerLabel}): ${user.email} — ${name}`).catch(() => {});
    } else if (isNewSignup && !isNewAccount && !isCompAccount(user.email)) {
      notifyTeamMemberJoined(user);
    }
    if (isNewSignup) {
      await persistSignupAttribution(req, user.id);
    }
    if (isNewAccount && !isCompAccount(user.email)) {
      const ghlAttr = resolveSignupAttribution(req);
      sendGhlEvent("partial_signup", {
        email: user.email,
        app_user_id: user.id,
        company_name: newAccountName,
        trial_ends_at: user.trialEndsAt,
        partial_signup_date: new Date().toISOString().slice(0, 10),
        signup_source: ghlAttr.utm_source ?? "direct",
        utm_medium: ghlAttr.utm_medium ?? null,
        utm_campaign: ghlAttr.utm_campaign ?? null,
        signup_method: `${opts.provider}_mobile`,
      });
      sendMetaCapiEvent({
        eventName: "Lead",
        eventId: crypto.randomUUID(),
        email: user.email!,
        firstName: user.firstName,
        lastName: user.lastName,
        clientIp: req.ip,
        userAgent: req.headers?.["user-agent"],
        fbp: req.cookies?._fbp ?? (user as any).signupFbp,
        fbc: req.cookies?._fbc ?? (user as any).signupFbc,
      });
    }

    // Session: exact POST /api/login pattern — respond only inside
    // session.save's callback so Set-Cookie is committed before the
    // response leaves (mobile's cookie jar only updates on 2xx).
    const finalUser = user;
    req.login(finalUser, (loginErr: any) => {
      if (loginErr) {
        console.error(`[${opts.provider}-mobile] req.login failed:`, loginErr);
        return res.status(500).json({ message: "Sign-in failed" });
      }
      req.session.save(async (saveErr: any) => {
        if (saveErr) {
          console.error(`[${opts.provider}-mobile] session save failed:`, saveErr);
          return res.status(500).json({ message: "Sign-in failed" });
        }
        try {
          return res.json(await serializeUserForAuthResponse(finalUser, req));
        } catch (serErr) {
          // req.login already rotated the sid — NEVER non-2xx now (see the
          // verify-email-code session-stranding note). Degrade the body;
          // mobile falls back to GET /api/auth/user with a valid cookie.
          console.error(`[${opts.provider}-mobile] serialization failed (degrading, NOT 500):`, serErr);
          const { password: _pw, ...safeUser } = finalUser as any;
          return res.json(safeUser);
        }
      });
    });
  };

  app.post("/api/auth/apple/mobile", loginLimiter, async (req, res) => {
    try {
      const { idToken, inviteToken, firstName, lastName } = req.body || {};
      if (typeof idToken !== "string" || !idToken) {
        return res.status(400).json({ message: "Missing idToken" });
      }

      let payload: Awaited<ReturnType<typeof verifyAppleIdToken>>;
      try {
        payload = await verifyAppleIdToken(idToken, [
          process.env.APPLE_MOBILE_BUNDLE_ID || "com.fieldview.app",
        ]);
      } catch (verifyErr: any) {
        console.error("[apple-mobile] id_token verification failed:", verifyErr?.message || verifyErr);
        return res.status(401).json({ message: "Invalid identity token" });
      }

      // Same email_verified handling as the web Apple callback: boolean
      // true OR string "true"; absent → false; unverified email dropped to
      // null so it can never email-match an existing account or invite.
      const emailVerified =
        payload.email_verified === true || payload.email_verified === "true";
      let email = (payload.email as string) || null;
      if (email && !emailVerified) {
        console.warn(`[oauth-mobile-unverified-email] provider=apple sub=${payload.sub}`);
        email = null;
      }

      await completeMobileOAuthLogin(req, res, {
        provider: "apple",
        providerId: payload.sub,
        email,
        emailVerified,
        firstName: typeof firstName === "string" && firstName ? firstName : null,
        lastName: typeof lastName === "string" && lastName ? lastName : null,
        profileImageUrl: null,
        inviteToken: typeof inviteToken === "string" && inviteToken ? inviteToken : null,
      });
    } catch (err: any) {
      console.error("[apple-mobile] failed:", err?.message || err);
      if (!res.headersSent) res.status(500).json({ message: "Sign-in failed" });
    }
  });

  // ----- Apple IAP purchase submission (StoreKit 2 signed transaction) -----
  // Mobile POSTs expo-iap's purchaseToken (the signed transaction JWS) here
  // after a purchase / restore / relaunch-with-unfinished-transaction.
  // Verification + account resolution + billing write all live in
  // lib/appleIap.ts (processApplePurchase — shared pipeline with the ASSN V2
  // handler). Idempotent: a repeat JWS re-resolves via the already-bound
  // originalTransactionId and returns 200 with the current user. Registered
  // here (not routes.ts) because the response reuses the closure-scoped
  // serializeUserForAuthResponse — same pattern as the mobile auth endpoints.
  app.post("/api/billing/apple/purchase", isAuthenticated, async (req: any, res) => {
    try {
      const { jws } = req.body || {};
      if (typeof jws !== "string" || !jws) {
        return res.status(400).json({ message: "Missing jws" });
      }
      const result = await processApplePurchase(jws, req.user?.accountId ?? null);
      if (result.status !== 200) {
        return res.status(result.status).json(result.body ?? { message: "Purchase not applied" });
      }
      // Re-fetch AFTER the billing write so the serialized payload reflects
      // the new provider/status/seatCount (billing overlay reads the account
      // row live).
      const fresh = await authStorage.getUser(req.user.id);
      if (!fresh) {
        return res.status(404).json({ message: "User not found" });
      }
      return res.json(await serializeUserForAuthResponse(fresh, req));
    } catch (err: any) {
      console.error("[apple-iap] purchase endpoint failed:", err?.message || err);
      if (!res.headersSent) res.status(500).json({ message: "Failed to apply purchase" });
    }
  });

  app.post("/api/auth/google/mobile", loginLimiter, async (req, res) => {
    try {
      const allowedAudiences = (process.env.GOOGLE_MOBILE_CLIENT_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowedAudiences.length === 0) {
        // Fail closed: without an aud allowlist any Google-issued token
        // (for ANY app) would pass — never fall open.
        return res.status(503).json({ message: "Provider not configured" });
      }

      const { idToken, inviteToken } = req.body || {};
      if (typeof idToken !== "string" || !idToken) {
        return res.status(400).json({ message: "Missing idToken" });
      }

      let payload: GoogleIdTokenPayload;
      try {
        payload = await verifyGoogleIdToken(idToken, allowedAudiences);
      } catch (verifyErr: any) {
        console.error("[google-mobile] id_token verification failed:", verifyErr?.message || verifyErr);
        return res.status(401).json({ message: "Invalid identity token" });
      }

      // Strict verified-email gate, mirroring the Apple handling above.
      const emailVerified =
        payload.email_verified === true || payload.email_verified === "true";
      let email = (payload.email as string) || null;
      if (email && !emailVerified) {
        console.warn(`[oauth-mobile-unverified-email] provider=google sub=${payload.sub}`);
        email = null;
      }

      await completeMobileOAuthLogin(req, res, {
        provider: "google",
        providerId: payload.sub,
        email,
        emailVerified,
        firstName: (payload.given_name as string) || null,
        lastName: (payload.family_name as string) || null,
        profileImageUrl: (payload.picture as string) || null,
        inviteToken: typeof inviteToken === "string" && inviteToken ? inviteToken : null,
      });
    } catch (err: any) {
      console.error("[google-mobile] failed:", err?.message || err);
      if (!res.headersSent) res.status(500).json({ message: "Sign-in failed" });
    }
  });

  // ----- Mobile email/password registration -----
  // POST /api/register requires a reCAPTCHA token that a native app cannot
  // supply, so mobile gets its own endpoint. Validation/creation mirrors
  // /api/register (8-char minimum, bcrypt 12, 409 duplicate, termsAccepted
  // literal true); session/response mirrors the mobile OAuth endpoints
  // (req.login → session.save → serializeUserForAuthResponse inside the
  // save callback, so Set-Cookie is committed before the response leaves).
  //
  // No companyName: mobile onboarding renames the account later via
  // PATCH /api/account/name, so the account name is synthesized exactly
  // like findOrCreateOAuthUser's: "<First Last>'s Team" | "<email>'s Team"
  // — names aren't collected here, so it is always "<email>'s Team".
  //
  // NO S41-style email-invite resolution here (token-based invites only):
  // a fresh email/password signup has an unverified, unproven email, and
  // resolving a pending invitation by email would let anyone who knows an
  // invitee's address join that team. S41's email resolution is gated on a
  // provider-attested verified email; that guarantee does not exist here.
  app.post("/api/auth/register/mobile", registerLimiter, async (req: any, res) => {
    try {
      if (req.body?.termsAccepted !== true) {
        return res.status(400).json({
          error: "terms_not_accepted",
          message: "You must accept the Terms of Service and Privacy Policy to continue.",
        });
      }

      const { email: rawEmail, password, inviteToken: rawInviteToken } = req.body || {};
      const inviteToken =
        typeof rawInviteToken === "string" && rawInviteToken ? rawInviteToken : null;

      if (!rawEmail || !password) {
        return res.status(400).json({
          error: "missing_credentials",
          message: "Email and password are required",
        });
      }

      const email = normalizeEmail(String(rawEmail));

      if (password.length < 8) {
        return res.status(400).json({
          error: "password_too_short",
          message: "Password must be at least 8 characters",
        });
      }

      const existing = await authStorage.getUserByEmail(email);
      if (existing) {
        return res.status(409).json({
          error: "email_exists",
          message: "An account with this email already exists",
        });
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
          return res.status(400).json({
            error: "invite_invalid",
            message: "Invalid or expired invitation",
          });
        }
        if (normalizeEmail(invitation.email) !== email) {
          return res.status(403).json({
            error: "invite_email_mismatch",
            message: "Email does not match invitation",
          });
        }
        accountId = invitation.accountId;
        role = invitation.role;
        firstName = invitation.firstName ?? null;
        lastName = invitation.lastName ?? null;
        invitationForAssignment = invitation;
      }

      let initialSubscriptionStatus: string;
      let initialTrialEndsAt: Date | null;
      let newAccountName: string | null = null;

      if (inviteToken) {
        // Invitee: copy the EXISTING account's billing fields onto the user
        // row (matches /api/register) so getAccountBilling's user-fallback
        // path does not lock out invitees joining active/trialing accounts.
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
        // Names are not collected on this endpoint, so unlike
        // findOrCreateOAuthUser there is no real name to build a
        // "<First Last>'s Team" from. A neutral placeholder is used because
        // accounts.name is user-visible on PDF covers/footers and public
        // share pages if onboarding is abandoned — never the email address.
        // Mobile onboarding renames it via PATCH /api/account/name.
        const [account] = await db.insert(accounts).values({
          name: "My Company",
          subscriptionStatus: initialSubscriptionStatus,
          trialEndsAt: initialTrialEndsAt,
        }).returning();
        accountId = account.id;
        role = "admin";
        newAccountName = account.name;
      }

      const user = await authStorage.upsertUser({
        email,
        password: hashedPassword,
        firstName,
        lastName,
        role,
        accountId,
        emailVerified: false,
        subscriptionStatus: initialSubscriptionStatus,
        trialEndsAt: initialTrialEndsAt,
        termsAcceptedAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
        // Invitees skip mobile onboarding (their account is already
        // configured); self-serve stays null so the app gates on it.
        profileCompletedAt: inviteToken ? new Date() : null,
      });

      if (!inviteToken) {
        await db.update(accounts).set({ ownerId: user.id }).where(eq(accounts.id, accountId));
      }

      await persistSignupAttribution(req, user.id);

      if (invitationForAssignment) {
        await applyInvitationAcceptance(invitationForAssignment, user.id);
      }

      // Side effects — identical gating to /api/register's branches.
      if (!inviteToken && !isCompAccount(user.email)) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || "(no name)";
        sendSlackNotification(`🎉 New signup (email mobile): ${user.email} — ${name}`).catch(() => {});
      } else if (inviteToken && !isCompAccount(user.email)) {
        notifyTeamMemberJoined(user);
      }

      if (!inviteToken && !isCompAccount(user.email)) {
        const ghlAttr = resolveSignupAttribution(req);
        sendGhlEvent("partial_signup", {
          email: user.email,
          app_user_id: user.id,
          company_name: newAccountName,
          trial_ends_at: initialTrialEndsAt,
          partial_signup_date: new Date().toISOString().slice(0, 10),
          signup_source: ghlAttr.utm_source ?? "direct",
          utm_medium: ghlAttr.utm_medium ?? null,
          utm_campaign: ghlAttr.utm_campaign ?? null,
          signup_method: "email_mobile",
        });
        // Fresh UUID for the Meta CAPI eventId — no browser pixel on mobile
        // to dedupe against (same as the mobile OAuth endpoints).
        sendMetaCapiEvent({
          eventName: "Lead",
          eventId: crypto.randomUUID(),
          email: user.email!,
          clientIp: req.ip,
          userAgent: req.headers?.["user-agent"],
          fbp: req.cookies?._fbp ?? (user as any).signupFbp,
          fbc: req.cookies?._fbc ?? (user as any).signupFbc,
        });
      }

      // Invitee verification code + email — same as /api/register's invitee
      // branch. Self-serve verification email stays deferred to the
      // profileCompletedAt transition in PATCH /api/auth/me.
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
          console.error("[register-mobile] verification email send failed:", emailErr);
        }
      }

      // BOTH branches auto-login — deliberate divergence from web's invitee
      // branch (201 + "check your email", no session). On a phone that flow
      // means leaving the app, finding a code in Mail, coming back to no
      // session, and retyping a just-created password. The security posture
      // is identical: emailVerified stays false, the 6-digit code is still
      // generated and emailed, and gating unverified users in-app is a
      // separate concern.
      req.login(user, (loginErr: any) => {
        if (loginErr) {
          console.error("[register-mobile] req.login failed:", loginErr);
          return res.status(500).json({ error: "registration_failed", message: "Registration succeeded but sign-in failed. Please sign in." });
        }
        req.session.save(async (saveErr: any) => {
          if (saveErr) {
            console.error("[register-mobile] session save failed:", saveErr);
            return res.status(500).json({ error: "registration_failed", message: "Registration succeeded but sign-in failed. Please sign in." });
          }
          try {
            return res.status(201).json(await serializeUserForAuthResponse(user, req));
          } catch (serErr) {
            // sid already rotated — NEVER non-2xx now (see the mobile OAuth
            // serialization note). Degrade the body; mobile falls back to
            // GET /api/auth/user with a valid cookie.
            console.error("[register-mobile] serialization failed (degrading, NOT 500):", serErr);
            const { password: _pw, ...safeUser } = user as any;
            return res.status(201).json(safeUser);
          }
        });
      });
    } catch (error) {
      console.error("[register-mobile] failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "registration_failed", message: "Registration failed" });
      }
    }
  });

  // Tells the frontend which OAuth providers are enabled
  app.get("/api/auth/providers", (_req, res) => {
    res.json({
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      microsoft: !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
      apple: isAppleConfigured(),
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
      //
      // Session-stranding fix (July 2026 login-loop incident): NEVER 500
      // once req.login may have run. Passport 0.7's req.login calls
      // session.regenerate(), which destroys the caller's current session
      // row BEFORE any error can surface — so a non-2xx response here can
      // carry the ONLY surviving sid, which the mobile differing-sid guard
      // discards → stranded session → silent re-login loop. On overlay
      // failure, degrade the body instead of erroring.
      const respondWithUser = async () => {
        try {
          // Full GET /api/auth/user shape via the shared serializer (billing
          // overlay + isOwner + account fields) — previously hand-rolled
          // here WITHOUT isOwner/accountCreatedAt, which diverged from the
          // GET payload the comment above promises.
          res.json(await serializeUserForAuthResponse(verifiedUser, req));
        } catch (overlayErr) {
          console.error(
            "[verify-email-code] billing overlay failed (degrading, NOT 500):",
            overlayErr,
          );
          // Degrade to the sanitized user row WITHOUT the billing overlay —
          // the client setQueryData's this response into ['/api/auth/user'],
          // and AppContent gates on fields like profileCompletedAt/role, so
          // the payload must stay gate-safe. The users row carries all of
          // those; only the billing overlay fields are missing, and the next
          // GET /api/auth/user fills them in.
          try {
            const { password: _pw2, ...safeUser2 } = verifiedUser as any;
            res.json(sanitizeUserForViewer(safeUser2, verifiedUser));
          } catch (sanitizeErr) {
            // Last resort — sanitize itself failed. Still 2xx (see
            // stranding note); minimal shape, client must refetch.
            console.error("[verify-email-code] sanitize failed too:", sanitizeErr);
            res.json({
              id: verifiedUser.id,
              email: verifiedUser.email,
              emailVerified: true,
            });
          }
        }
      };

      // Skip req.login when the caller is ALREADY authenticated as this
      // user (the normal mid-onboarding path). serializeUser stores only
      // user.id — unchanged by verification — and deserializeUser refetches
      // the row on every request, so re-login adds nothing while its
      // regenerate() would put a live session at risk for zero benefit.
      if ((req as any).isAuthenticated?.() && (req as any).user?.id === verifiedUser.id) {
        return void respondWithUser();
      }

      // Unauthenticated caller (fresh device / cross-device verify):
      // req.login is what establishes the session — keep it.
      req.login(verifiedUser, async (err) => {
        if (err) {
          // Still 200 with the user: verification itself succeeded, and a
          // 500 here could carry a fresh sid (see stranding note above).
          console.error("[verify-email-code] req.login failed:", err);
        }
        await respondWithUser();
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

// TEMP DIAGNOSTIC 2026-08-06 [authdiag-guard] — silent-401 investigation.
// Called only when a guard is about to return 401. Synchronous, never throws,
// never logs full sids/cookies (first 8 chars of identifiers only).
// Remove when investigation closes.
function authdiagGuardLog(req: any, guard: string, reason: string) {
  try {
    const sess: any = req.session;
    const passportUser = sess?.passport?.user;
    console.info(
      "[authdiag-guard]",
      JSON.stringify({
        guard,
        reason,
        path: req.path,
        hasCookieHeader: !!req.headers?.cookie,
        hasSessionID: !!req.sessionID,
        sessionID8: typeof req.sessionID === "string" ? req.sessionID.slice(0, 8) : null,
        hasSession: !!sess,
        hasPassport: !!sess?.passport,
        hasPassportUser: passportUser !== undefined && passportUser !== null,
        passportUser8: typeof passportUser === "string" ? passportUser.slice(0, 8) : null,
        client: req.headers?.["x-fieldview-client"] ?? null,
      }),
    );
  } catch {}
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  if (!req.isAuthenticated()) {
    authdiagGuardLog(req, "isAuthenticated", "not_authenticated"); // TEMP DIAGNOSTIC 2026-08-06
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

export const requireActiveSubscription: RequestHandler = async (req: any, res, next) => {
  if (!req.isAuthenticated()) {
    authdiagGuardLog(req, "requireActiveSubscription", "not_authenticated"); // TEMP DIAGNOSTIC 2026-08-06
    return res.status(401).json({ message: "Unauthorized" });
  }

  const user = req.user;
  if (!user) {
    authdiagGuardLog(req, "requireActiveSubscription", "no_req_user"); // TEMP DIAGNOSTIC 2026-08-06
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
    authdiagGuardLog(req, "requireReadAccess", "not_authenticated"); // TEMP DIAGNOSTIC 2026-08-06
    return res.status(401).json({ message: "Unauthorized" });
  }
  const user = req.user;
  if (!user) {
    authdiagGuardLog(req, "requireReadAccess", "no_req_user"); // TEMP DIAGNOSTIC 2026-08-06
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
    authdiagGuardLog(req, "requireWriteAccess", "not_authenticated"); // TEMP DIAGNOSTIC 2026-08-06
    return res.status(401).json({ message: "Unauthorized" });
  }
  const user = req.user;
  if (!user) {
    authdiagGuardLog(req, "requireWriteAccess", "no_req_user"); // TEMP DIAGNOSTIC 2026-08-06
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
