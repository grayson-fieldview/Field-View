// PostHog browser integration.
// Autocapture and automatic page_view are both disabled; the SPA route
// tracker in App.tsx owns all $pageview events. Session replay is enabled
// with all inputs masked. Init is non-fatal — a failure here must never
// prevent the app from rendering.

import posthog from "posthog-js";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";

// Set to true only after posthog.init() succeeds with a present key. All
// capture/identify/reset helpers no-op until this is true so nothing fires
// when init didn't run (missing key) or threw.
let initialized = false;

export function initPostHog(): void {
  if (!POSTHOG_KEY) {
    console.warn("[posthog] VITE_POSTHOG_KEY not set — PostHog disabled");
    return;
  }
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: false,
    session_recording: {
      maskAllInputs: true,
    },
  });
  initialized = true;
}

/** Capture a $pageview for the given path. No-ops if PostHog is not loaded. */
export function capturePageView(path: string): void {
  if (!initialized) return;
  try {
    posthog.capture("$pageview", { $current_url: window.location.origin + path });
  } catch {
    // non-fatal
  }
}

/** Identify a user. No-ops if PostHog is not loaded. */
export function identifyUser(distinctId: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    posthog.identify(distinctId, properties);
  } catch {
    // non-fatal
  }
}

/** Reset the PostHog identity (on logout). No-ops if PostHog is not loaded. */
export function resetPostHog(): void {
  if (!initialized) return;
  try {
    posthog.reset();
  } catch {
    // non-fatal
  }
}

/** Capture a custom event. No-ops if PostHog is not loaded. */
export function captureEvent(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    posthog.capture(event, properties);
  } catch {
    // non-fatal
  }
}
