// Meta Pixel browser-only integration. PR 3 of the Meta ads launch.
// No CAPI, no event_id, no server-side fan-out — just the standard
// browser pixel firing PageView (base + SPA route change),
// CompleteRegistration (signup success), and Subscribe (Stripe Checkout
// success). The S46 attribution middleware separately captures _fbc /
// _fbp cookies on the server; that lives on for the future CAPI wiring
// but is not used here.

declare global {
  interface Window {
    fbq?: (...args: any[]) => void;
    _fbq?: any;
  }
}

export function initMetaPixel(): void {
  const pixelId = import.meta.env.VITE_META_PIXEL_ID as string | undefined;
  if (!pixelId) {
    // eslint-disable-next-line no-console
    console.warn(
      "[meta-pixel] VITE_META_PIXEL_ID not set — Meta Pixel disabled",
    );
    return;
  }
  // Standard Meta Pixel bootstrap, verbatim shape from Meta's docs:
  // https://developers.facebook.com/docs/meta-pixel/get-started
  /* eslint-disable */
  (function (f: any, b: any, e: any, v: any, n?: any, t?: any, s?: any) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod
        ? n.callMethod.apply(n, arguments)
        : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n;
    n.loaded = !0;
    n.version = "2.0";
    n.queue = [];
    t = b.createElement(e);
    t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(
    window,
    document,
    "script",
    "https://connect.facebook.net/en_US/fbevents.js",
  );
  /* eslint-enable */
  window.fbq!("init", pixelId);
  window.fbq!("track", "PageView");
}
