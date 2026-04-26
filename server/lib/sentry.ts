import * as Sentry from "@sentry/node";

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.warn(
      "[sentry] SENTRY_DSN not set — server-side Sentry disabled",
    );
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 1.0,
  });

  console.log(
    "[sentry] initialized for environment:",
    process.env.NODE_ENV || "development",
  );
}

export { Sentry };
