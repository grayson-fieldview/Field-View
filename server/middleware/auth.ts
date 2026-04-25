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

// TODO: requires accounts.owner_id column (Session 1 schema migration).
// Currently always returns 403 for safety. Do not apply to any route until owner_id exists.
export const requireOwnerAdmin: RequestHandler = (req: any, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden", message: "Admin role required" });
  }
  const ownerId = req.user.account?.owner_id;
  if (!ownerId || req.user.id !== ownerId) {
    return res.status(403).json({ error: "forbidden", message: "Account owner role required" });
  }
  return next();
};
