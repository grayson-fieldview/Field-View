// Google Analytics 4 (gtag.js) — loaded app-wide from main.tsx.
// Automatic page_view is disabled (send_page_view: false); SPA page tracking
// is handled by trackPageView() from the router root in App.tsx, and
// conversion events fire via trackEvent() adjacent to the existing Meta
// Pixel milestones. All helpers no-op safely (never throw) when gtag is
// unavailable — e.g. ad blockers preventing the script from loading.

const GA_MEASUREMENT_ID = "G-0NJ8BV5VP2";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function initGoogleAnalytics(): void {
  try {
    if (typeof window === "undefined") return;
    if (window.gtag) return; // already initialized

    window.dataLayer = window.dataLayer || [];
    const gtag = (...args: unknown[]) => {
      window.dataLayer!.push(args);
    };
    window.gtag = gtag;
    gtag("js", new Date());
    // send_page_view: false — the SPA route tracker owns ALL page_view
    // events (including the initial load) so full loads and client-side
    // navigations are counted identically, with no double-count on boot.
    gtag("config", GA_MEASUREMENT_ID, { send_page_view: false });

    const script = document.createElement("script");
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.appendChild(script);
  } catch {
    // Analytics must never break the app.
  }
}

export function trackPageView(path: string): void {
  try {
    if (typeof window === "undefined" || !window.gtag) return;
    window.gtag("event", "page_view", { page_path: path });
  } catch {
    // never throw from analytics
  }
}

export function trackEvent(name: string, params?: Record<string, unknown>): void {
  try {
    if (typeof window === "undefined" || !window.gtag) return;
    window.gtag("event", name, params);
  } catch {
    // never throw from analytics
  }
}
