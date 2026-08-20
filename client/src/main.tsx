import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initSentry, Sentry } from "./lib/sentry";
import { initMetaPixel } from "./lib/meta-pixel";
import { initGoogleAnalytics } from "./lib/google-analytics";
import { initPostHog } from "./lib/posthog";
import { captureAttribution } from "./lib/attribution";

// Non-essential third-party init must NEVER prevent the app (especially the
// /signup form) from rendering. Each init is individually isolated: a throw
// in one must not skip the others or abort boot.
try {
  initSentry();
} catch (e) {
  console.warn("[boot] Sentry init failed (non-fatal)", e);
}
try {
  initMetaPixel();
} catch (e) {
  console.warn("[boot] Meta Pixel init failed (non-fatal)", e);
}
try {
  initGoogleAnalytics();
} catch (e) {
  console.warn("[boot] GA init failed (non-fatal)", e);
}
try {
  initPostHog();
} catch (e) {
  console.warn("[boot] PostHog init failed (non-fatal)", e);
}
try {
  captureAttribution();
} catch (e) {
  console.warn("[boot] attribution capture failed (non-fatal)", e);
}

createRoot(document.getElementById("root")!).render(
  <Sentry.ErrorBoundary
    fallback={<p>Something went wrong. Our team has been notified.</p>}
    showDialog
  >
    <App />
  </Sentry.ErrorBoundary>
);
