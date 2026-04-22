import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initSentry, Sentry } from "./lib/sentry";

initSentry();

createRoot(document.getElementById("root")!).render(
  <Sentry.ErrorBoundary
    fallback={<p>Something went wrong. Our team has been notified.</p>}
    showDialog
  >
    <App />
  </Sentry.ErrorBoundary>
);
