// Google Analytics 4 (gtag.js) — loaded ONLY on the pre-auth signup funnel.
// On any other path, no gtag script is injected and no request to
// googletagmanager.com is made. Moved here from a static tag in
// client/index.html so loading can be conditional on the URL.
//
// SPA caveat (accepted): if a user lands on an allowlisted page and then
// client-side-navigates into the app (signup → /welcome → dashboard), the
// already-loaded script stays for that session. No teardown by design.

const GA_MEASUREMENT_ID = "G-0NJ8BV5VP2";

// Signup funnel: step 1 (/signup, alias /register), step 2 (/welcome),
// email verification code page (/verify-email). Prefix matching so any
// sub-paths or query strings still count.
const ALLOWED_PATH_PREFIXES = ["/signup", "/register", "/welcome", "/verify-email"];

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function isSignupFunnelPath(pathname: string): boolean {
  return ALLOWED_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function initGoogleAnalytics(): void {
  if (typeof window === "undefined") return;
  if (!isSignupFunnelPath(window.location.pathname)) return;
  if (window.gtag) return; // already initialized

  window.dataLayer = window.dataLayer || [];
  function gtag(...args: unknown[]) {
    window.dataLayer!.push(args);
  }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_MEASUREMENT_ID);

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);
}
