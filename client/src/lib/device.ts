// Client-side OS detection for store-link routing. Deliberately coarse:
// we only need iOS vs Android vs "neither" to pick a store badge.
export type DeviceOS = "ios" | "android" | "desktop";

export function detectDeviceOS(): DeviceOS {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  // iPadOS 13+ reports a Mac user agent; distinguish via touch support.
  if (/macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return "ios";
  return "desktop";
}
