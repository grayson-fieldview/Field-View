import type { RequestHandler } from "express";

export const requireAdmin: RequestHandler = (req: any, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden", message: "Admin role required" });
  }
  return next();
};

export const requireAdminOrManager: RequestHandler = (req: any, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (req.user.role !== "admin" && req.user.role !== "manager") {
    return res.status(403).json({ error: "forbidden", message: "Admin or Manager role required" });
  }
  return next();
};

// Owner-only gate: caller must be an admin AND the account owner.
// req.user.account.ownerId is populated in deserializeUser (replitAuth.ts) on
// every authenticated request, sourced from accounts.owner_id.
export const requireOwnerAdmin: RequestHandler = (req: any, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden", message: "Admin role required" });
  }
  const ownerId = req.user.account?.ownerId;
  if (!ownerId || req.user.id !== ownerId) {
    return res.status(403).json({ error: "forbidden", message: "Account owner role required" });
  }
  return next();
};
