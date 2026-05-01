import type { Express } from "express";
import { authStorage } from "./storage";
import { isAuthenticated } from "./replitAuth";
import { overlayAccountBillingOnUser } from "../../lib/billing";
import { sanitizeUserForViewer } from "../../lib/userVisibility";
import { db } from "../../db";
import { accounts } from "@shared/models/auth";
import { eq } from "drizzle-orm";

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
      const { firstName, lastName } = req.body || {};
      if (typeof firstName !== "string" || typeof lastName !== "string") {
        return res
          .status(400)
          .json({ message: "First and last name are required" });
      }
      const trimmedFirst = firstName.trim();
      const trimmedLast = lastName.trim();
      if (!trimmedFirst || !trimmedLast) {
        return res
          .status(400)
          .json({ message: "First and last name cannot be empty" });
      }
      if (trimmedFirst.length > 100 || trimmedLast.length > 100) {
        return res
          .status(400)
          .json({ message: "Name must be 100 characters or less" });
      }
      const updated = await authStorage.updateUser(req.user.id, {
        firstName: trimmedFirst,
        lastName: trimmedLast,
      });
      if (!updated) {
        return res.status(404).json({ message: "User not found" });
      }
      const { password: _, ...safeUser } = updated;
      const safeUserWithBilling = await overlayAccountBillingOnUser(
        safeUser,
        req,
      );
      res.json(sanitizeUserForViewer(safeUserWithBilling, req.user));
    } catch (error) {
      console.error("Error updating user profile:", error);
      res.status(500).json({ message: "Failed to update profile" });
    }
  });
}
