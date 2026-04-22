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
    beforeSend(event) {
      if (event.exception?.values?.[0]?.value?.includes("ResizeObserver")) {
        return null;
      }
      return event;
    },
  });
}

export { Sentry };
