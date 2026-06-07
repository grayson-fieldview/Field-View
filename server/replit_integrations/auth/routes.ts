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
import { syncProfileToHubSpot } from "../../services/hubspot";

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
      const { firstName, lastName, phone, industry, companySize } = req.body || {};

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

      const updated = await authStorage.updateUser(req.user.id, userUpdate);
      if (!updated) {
        return res.status(404).json({ message: "User not found" });
      }

      if (Object.keys(accountUpdate).length > 0 && updated.accountId) {
        await db.update(accounts).set(accountUpdate).where(eq(accounts.id, updated.accountId));
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

      // HubSpot profile sync (signup step 2). Fire-and-forget + non-fatal —
      // refreshes Contact name/phone and Company type/size. Associations already
      // exist from the new-account HubSpot hook. `industry` is the app's
      // company-type field; companySize maps to numberofemployees.
      //
      // OWNER-ONLY GATE: only the account owner (the self-serve admin who created
      // the account) is synced. Invited/standard users — and any account whose
      // owner_id is null — never reach HubSpot, so invitees are never created as
      // Contacts. The owner lookup is wrapped so a DB hiccup can't break the PATCH.
      try {
        if (updated.email && updated.accountId) {
          const [acct] = await db
            .select({ ownerId: accounts.ownerId })
            .from(accounts)
            .where(eq(accounts.id, updated.accountId))
            .limit(1);
          if (acct?.ownerId === updated.id) {
            syncProfileToHubSpot({
              email: updated.email,
              accountId: updated.accountId,
              firstName: updated.firstName,
              lastName: updated.lastName,
              phone: updated.phone,
              companyType: accountUpdate.industry ?? undefined,
              companySize: accountUpdate.companySize ?? undefined,
            });
          }
        }
      } catch (hubspotGateErr) {
        console.error("[auth/me] HubSpot owner-gate lookup failed:", hubspotGateErr);
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
