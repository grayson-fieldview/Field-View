import * as Sentry from "@sentry/react";

const DSN = import.meta.env.VITE_SENTRY_DSN;

export function initSentry() {
  if (!DSN) {
    console.warn("[sentry] VITE_SENTRY_DSN not set — Sentry disabled");
    return;
  }
  Sentry.init({
    dsn: DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE || "unknown",
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.05,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: false,
        blockAllMedia: true,
      }),
    ],
    // Known third-party noise. The webkit/Android bridge errors originate in
    // code injected by iOS/Android in-app browsers (Instagram, Facebook) or
    // remote vendor scripts — NOT first-party code (verified July 2026: zero
    // references to window.webkit / window.Android in this codebase). They
    // are unhandled in a context we don't control and cannot try/catch.
    ignoreErrors: [
      /window\.webkit\.messageHandlers/,
      /Java object is gone/,
    ],
    beforeSend(event) {
      if (event.exception?.values?.[0]?.value?.includes("ResizeObserver")) {
        return null;
      }
      return event;
    },
  });
}

export { Sentry };
