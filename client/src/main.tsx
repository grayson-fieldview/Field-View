import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initSentry, Sentry } from "./lib/sentry";
import { initMetaPixel } from "./lib/meta-pixel";
import { initGoogleAnalytics } from "./lib/google-analytics";

initSentry();
initMetaPixel();
initGoogleAnalytics();

createRoot(document.getElementById("root")!).render(
  <Sentry.ErrorBoundary
    fallback={<p>Something went wrong. Our team has been notified.</p>}
    showDialog
  >
    <App />
  </Sentry.ErrorBoundary>
);
