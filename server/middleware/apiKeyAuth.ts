import type { RequestHandler } from "express";
import { RateLimiterPostgres, RateLimiterRes } from "rate-limiter-flexible";
import { pool } from "../db";
import { authenticateApiKey } from "../lib/apiKeys";

const isDev = process.env.NODE_ENV === "development";

// Per-key rate limiter — reuses the existing rate-limiter-flexible /
// RateLimiterPostgres setup and the library-owned auth_rate_limits table
// (mirror-only in shared/schema.ts, never written/renamed by app code).
// Keyed on the api key id (not the client IP), generous 300 req/min.
const apiKeyRateLimiter = new RateLimiterPostgres({
  storeClient: pool,
  storeType: "pg",
  tableName: "auth_rate_limits",
  tableCreated: true,
  keyPrefix: "rl_apikey",
  points: 300,
  duration: 60,
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKeyAccount?: {
        accountId: string;
        ownerId: string | null;
        keyId: string;
      };
    }
  }
}

/**
 * Authenticate a request via an API key in the Authorization: Bearer header.
 *
 * Reads the key ONLY from the Authorization header — there is NO session /
 * cookie fallback of any kind. If the header is absent or the key is invalid,
 * the request is rejected 401 even when a valid session cookie is present.
 * This is what makes the csrfGuard Bearer pass-through safe: an api-key path
 * can never be driven by an ambient cookie.
 *
 * On success attaches req.apiKeyAccount = { accountId, ownerId, keyId }.
 *
 * NOTE: no /api/v1 route consumes this yet — the v1 data endpoints are a
 * separate session. This middleware is the infrastructure they will use.
 */
export const requireApiKey: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "unauthorized", message: "Missing or invalid API key" });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return res
      .status(401)
      .json({ error: "unauthorized", message: "Missing or invalid API key" });
  }

  let result: Awaited<ReturnType<typeof authenticateApiKey>>;
  try {
    result = await authenticateApiKey(token);
  } catch (err) {
    console.error("[apiKeyAuth] authentication error:", err);
    return res
      .status(500)
      .json({ error: "server_error", message: "Authentication failed" });
  }

  if (!result) {
    return res
      .status(401)
      .json({ error: "unauthorized", message: "Missing or invalid API key" });
  }

  // Rate limit by api key id. Skipped in dev, mirroring makeLimiter.
  if (!isDev) {
    try {
      const r = await apiKeyRateLimiter.consume(result.key.id, 1);
      res.setHeader("X-RateLimit-Limit", "300");
      res.setHeader("X-RateLimit-Remaining", String(r.remainingPoints));
      res.setHeader(
        "X-RateLimit-Reset",
        String(Math.ceil((Date.now() + r.msBeforeNext) / 1000)),
      );
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retrySeconds = Math.ceil(err.msBeforeNext / 1000);
        console.warn(
          `[rate-limit] apikey blocked for ${result.key.id} — retry in ${retrySeconds}s`,
        );
        res.setHeader("Retry-After", String(retrySeconds));
        res.setHeader("X-RateLimit-Limit", "300");
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader(
          "X-RateLimit-Reset",
          String(Math.ceil((Date.now() + err.msBeforeNext) / 1000)),
        );
        return res.status(429).json({
          error: "too_many_requests",
          message: "API rate limit exceeded. Please slow down.",
          retryAfterSeconds: retrySeconds,
        });
      }
      // Store error — fail open (do not lock out a valid key on a DB blip).
      console.error("[apiKeyAuth] rate-limit store error:", err);
    }
  }

  req.apiKeyAccount = {
    accountId: result.account.id,
    ownerId: result.account.ownerId ?? null,
    keyId: result.key.id,
  };
  next();
};
