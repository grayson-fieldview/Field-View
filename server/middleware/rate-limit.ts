import type { Request, Response, NextFunction, RequestHandler } from "express";
import { RateLimiterPostgres, RateLimiterRes } from "rate-limiter-flexible";
import { pool } from "../db";

const isDev = process.env.NODE_ENV === "development";

type LimiterConfig = {
  keyPrefix: string;
  points: number;
  durationSeconds: number;
  message: string;
  logLabel: string;
};

function makeLimiter({ keyPrefix, points, durationSeconds, message, logLabel }: LimiterConfig): RequestHandler {
  const limiter = new RateLimiterPostgres({
    storeClient: pool,
    storeType: "pg",
    tableName: "auth_rate_limits",
    keyPrefix,
    points,
    duration: durationSeconds,
  });

  return async (req: Request, res: Response, next: NextFunction) => {
    if (isDev) return next();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    try {
      const result = await limiter.consume(key);
      res.setHeader("X-RateLimit-Limit", String(points));
      res.setHeader("X-RateLimit-Remaining", String(result.remainingPoints));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil((Date.now() + result.msBeforeNext) / 1000)));
      next();
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        const retrySeconds = Math.ceil(err.msBeforeNext / 1000);
        console.warn(`[rate-limit] ${logLabel} blocked for ${key} — retry in ${retrySeconds}s`);
        res.setHeader("Retry-After", String(retrySeconds));
        res.setHeader("X-RateLimit-Limit", String(points));
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader("X-RateLimit-Reset", String(Math.ceil((Date.now() + err.msBeforeNext) / 1000)));
        return res.status(429).json({
          error: "too_many_requests",
          message,
          retryAfterSeconds: retrySeconds,
        });
      }
      console.error(`[rate-limit] ${logLabel} store error:`, err);
      next();
    }
  };
}

export const loginLimiter = makeLimiter({
  keyPrefix: "rl_login",
  points: 10,
  durationSeconds: 15 * 60,
  message: "Too many login attempts. Please try again in 15 minutes.",
  logLabel: "login",
});

export const registerLimiter = makeLimiter({
  keyPrefix: "rl_register",
  points: 5,
  durationSeconds: 60 * 60,
  message: "Too many sign-up attempts. Please try again in an hour.",
  logLabel: "register",
});

export const forgotPasswordLimiter = makeLimiter({
  keyPrefix: "rl_forgot",
  points: 5,
  durationSeconds: 60 * 60,
  message: "Too many password reset requests. Please try again in an hour.",
  logLabel: "forgot-password",
});

export const resetPasswordLimiter = makeLimiter({
  keyPrefix: "rl_reset",
  points: 10,
  durationSeconds: 15 * 60,
  message: "Too many password reset attempts. Please try again in 15 minutes.",
  logLabel: "reset-password",
});

export const resendVerificationLimiter = makeLimiter({
  keyPrefix: "rl_resend",
  points: 5,
  durationSeconds: 60 * 60,
  message: "Too many verification email requests. Please try again in an hour.",
  logLabel: "resend-verification",
});

export const verifyEmailLimiter = makeLimiter({
  keyPrefix: "rl_verify",
  points: 20,
  durationSeconds: 15 * 60,
  message: "Too many verification attempts. Please try again in 15 minutes.",
  logLabel: "verify-email",
});
