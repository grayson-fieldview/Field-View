import type { Express } from "express";
import { authStorage } from "./storage";
import { isAuthenticated } from "./replitAuth";
import { overlayAccountBillingOnUser } from "../../lib/billing";
import { sanitizeUserForViewer } from "../../lib/userVisibility";
import { db } from "../../db";
import { accounts } from "@shared/models/auth";
import { eq } from "drizzle-orm";
import { INDUSTRY_VALUES, COMPANY_SIZE_VALUES } from "@shared/constants";

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

      const { password: _, ...safeUser } = updated;
      const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
      res.json(sanitizeUserForViewer(safeUserWithBilling, req.user));
    } catch (error) {
      console.error("Error updating user profile:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });
}
