// Safe native-bridge helper. As of July 2026 NO first-party code calls the
// iOS WKWebView bridge (window.webkit.messageHandlers) or the Android bridge
// (window.Android) — the Sentry TypeError on /signup came from third-party /
// in-app-browser-injected code, not ours. This helper exists so that any
// future bridge call goes through here instead of touching window.webkit or
// window.Android directly.
//
// The try/catch is required, not optional: on Android the bridge object can
// exist when checked and be garbage-collected before the call lands
// ("Error invoking postMessage: Java object is gone"). Optional chaining
// alone does not prevent that.
export function callNative(handler: string, payload: unknown): boolean {
  try {
    const ios = (window as any).webkit?.messageHandlers?.[handler];
    if (ios?.postMessage) {
      ios.postMessage(payload);
      return true;
    }
    const android = (window as any).Android;
    if (android?.postMessage) {
      android.postMessage(JSON.stringify(payload));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
