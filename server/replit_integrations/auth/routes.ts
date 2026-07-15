import type { Express } from "express";
import crypto from "crypto";
import { authStorage } from "./storage";
import { isAuthenticated } from "./replitAuth";
import { overlayAccountBillingOnUser } from "../../lib/billing";
import { sanitizeUserForViewer } from "../../lib/userVisibility";
import { db } from "../../db";
import { accounts, users } from "@shared/models/auth";
import { eq } from "drizzle-orm";
import { INDUSTRY_VALUES, COMPANY_SIZE_VALUES } from "@shared/constants";
import { sendEmailVerificationEmail } from "../../services/email";
import { sendGhlEvent, estimatedMrrFromCompanySize } from "../../lib/ghl";
import { isCompAccount } from "../../lib/slack";

export function registerAuthRoutes(app: Express): void {
  app.get("/api/auth/user", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const user = await authStorage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      const { password: _, ...safeUser } = user;
      const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
      // Account ownership flag for client gating (e.g. "Delete account" UI).
      // Defensive defaults: missing accountId or missing account row → false.
      let isOwner = false;
      if (user.accountId) {
        const [account] = await db
          .select({ ownerId: accounts.ownerId })
          .from(accounts)
          .where(eq(accounts.id, user.accountId))
          .limit(1);
        isOwner = !!account && account.ownerId === user.id;
      }
      const sanitized = sanitizeUserForViewer({ ...safeUserWithBilling, isOwner }, user);
      res.json(sanitized);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  app.patch("/api/auth/me", isAuthenticated, async (req: any, res) => {
    try {
      const { firstName, lastName, phone, industry, companySize, tcpaAccepted } = req.body || {};

      const userUpdate: Record<string, any> = {};

      if (firstName !== undefined) {
        if (typeof firstName !== "string") {
          return res.status(400).json({ message: "First name must be a string" });
        }
        const trimmed = firstName.trim();
        if (!trimmed) {
          return res.status(400).json({ message: "First name cannot be empty" });
        }
        if (trimmed.length > 100) {
          return res.status(400).json({ message: "First name must be 100 characters or less" });
        }
        userUpdate.firstName = trimmed;
      }

      if (lastName !== undefined) {
        if (typeof lastName !== "string") {
          return res.status(400).json({ message: "Last name must be a string" });
        }
        const trimmed = lastName.trim();
        if (!trimmed) {
          return res.status(400).json({ message: "Last name cannot be empty" });
        }
        if (trimmed.length > 100) {
          return res.status(400).json({ message: "Last name must be 100 characters or less" });
        }
        userUpdate.lastName = trimmed;
      }

      if (phone !== undefined && phone !== null && phone !== "") {
        if (typeof phone !== "string") {
          return res.status(400).json({ message: "Phone must be a string" });
        }
        const trimmed = phone.trim();
        if (trimmed.length < 10 || trimmed.length > 20) {
          return res.status(400).json({ message: "Phone must be 10-20 characters" });
        }
        userUpdate.phone = trimmed;
      } else if (phone === null || phone === "") {
        userUpdate.phone = null;
      }

      // Account-level fields — admin only. Non-admins: silently ignore.
      const isAdmin = req.user.role === "admin";
      const accountUpdate: Record<string, any> = {};
      if (isAdmin && industry !== undefined && industry !== null && industry !== "") {
        if (typeof industry !== "string" || !INDUSTRY_VALUES.includes(industry)) {
          return res.status(400).json({ message: "Invalid industry" });
        }
        accountUpdate.industry = industry;
      }
      if (isAdmin && companySize !== undefined && companySize !== null && companySize !== "") {
        if (typeof companySize !== "string" || !COMPANY_SIZE_VALUES.includes(companySize)) {
          return res.status(400).json({ message: "Invalid company size" });
        }
        accountUpdate.companySize = companySize;
      }

      // Read the existing user FIRST so we can detect the null→now() transition
      // on profileCompletedAt — that's the moment a trial signup finishes Step 2
      // (the /welcome page) and earns their verification email. Subsequent
      // PATCHes (phone edit, etc.) re-stamp the timestamp but must NOT re-send.
      const existing = await authStorage.getUser(req.user.id);
      if (!existing) {
        return res.status(404).json({ message: "User not found" });
      }
      const isFirstCompletion = existing.profileCompletedAt == null;

      // Always stamp profileCompletedAt on a successful PATCH so the post-signup
      // /welcome gate releases. Idempotent — re-PATCHing later just refreshes it.
      userUpdate.profileCompletedAt = new Date();

      // S46 GHL: persist A2P/TCPA SMS consent. Previously the checkbox was
      // client-side only. Set-once semantics: consent is stamped the first
      // time tcpaAccepted=true arrives and never cleared or re-stamped here
      // (an audit trail timestamp, not a toggle).
      if (tcpaAccepted === true && existing.smsConsentAt == null) {
        userUpdate.smsConsentAt = new Date();
      }

      const updated = await authStorage.updateUser(req.user.id, userUpdate);
      if (!updated) {
        return res.status(404).json({ message: "User not found" });
      }

      if (Object.keys(accountUpdate).length > 0 && updated.accountId) {
        await db.update(accounts).set(accountUpdate).where(eq(accounts.id, updated.accountId));
      }

      // S46 GHL trial_started — fires ONLY on the NULL→set transition of
      // profileCompletedAt (page 2 / "Complete Setup" finished). Re-PATCHes
      // never re-fire. OWNER-ONLY: gated on accounts.ownerId === user.id.
      // ownerId is stamped
      // exclusively on self-serve account creation (both /api/register and
      // the OAuth path leave it untouched for invitees), so this is exactly
      // the user who fired partial_signup. An invited manager/admin finishing
      // page 2 sends nothing. Fire-and-forget; lookup wrapped, non-fatal.
      if (isFirstCompletion && updated.email && updated.accountId && !isCompAccount(updated.email)) {
        try {
          const [acctRow] = await db
            .select({
              ownerId: accounts.ownerId,
              industry: accounts.industry,
              companySize: accounts.companySize,
            })
            .from(accounts)
            .where(eq(accounts.id, updated.accountId))
            .limit(1);
          const acctIndustry = accountUpdate.industry ?? acctRow?.industry ?? null;
          const acctCompanySize = accountUpdate.companySize ?? acctRow?.companySize ?? null;
          if (acctRow?.ownerId === updated.id) sendGhlEvent("trial_started", {
            email: updated.email,
            app_user_id: updated.id,
            first_name: updated.firstName,
            last_name: updated.lastName,
            phone: updated.phone,
            sms_consent: updated.smsConsentAt != null,
            trade_type: acctIndustry,
            crew_size: acctCompanySize,
            trial_ends_at: updated.trialEndsAt,
            estimated_mrr: estimatedMrrFromCompanySize(acctCompanySize),
          });
        } catch (ghlErr) {
          console.error("[auth/me] GHL trial_started lookup failed (non-fatal):", ghlErr);
        }
      }

      // First-completion transition → mint verification token + send email.
      // Mirrors the previous /api/register call site (same args, same 1-hour
      // expiry, same swallow-and-log error handling). Skipped for users who
      // are already email-verified (e.g., legacy users PATCHing for the first
      // time after the column was backfilled).
      if (isFirstCompletion && !updated.emailVerified && updated.email) {
        try {
          const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
          const codeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
          await db.update(users).set({
            verificationCode: code,
            verificationCodeExpiresAt: codeExpiresAt,
            verificationCodeAttempts: 0,
            verificationCodeSentAt: new Date(),
          }).where(eq(users.id, updated.id));
          await sendEmailVerificationEmail(updated.email, code, updated.firstName);
        } catch (emailErr) {
          console.error("[auth/me] verification email send failed:", emailErr);
        }
      }

      const { password: _, ...safeUser } = updated;
      const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
      res.json(sanitizeUserForViewer(safeUserWithBilling, req.user));
    } catch (error) {
      console.error("Error updating user profile:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });
}
