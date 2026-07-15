// tz-lookup ships no .d.ts file (CC0 6.1.x). The require() inside
// formatLocalTime is cast to a callable signature at the call site rather than
// declared ambient — module augmentation is rejected here because TS resolves
// tz-lookup to an untyped JS file (TS2665).

/**
 * Format a UTC timestamp in the local time of a project's geographic location.
 *
 * Why project lat/lng instead of user device timezone: server doesn't reliably
 * know the device timezone, but every project has lat/lng (we use it for
 * geofencing). A painter clocked in at a job site should see push-notification
 * times in that job site's local time, even if their phone is set to a
 * different zone — the job-site time is what matters for payroll reconciliation.
 *
 * Returns "8:51 PM" — 12-hour with AM/PM, no date (push body context implies
 * "today"). On any failure (null/invalid coords, tz-lookup throw) falls back to
 * UTC formatting with " UTC" suffix so the fallback is observable in the wild.
 */
export function formatLocalTime(
  date: Date,
  lat: number | null | undefined,
  lng: number | null | undefined,
): string {
  const utcFallback = () =>
    date.toLocaleString("en-US", {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }) + " UTC";

  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return utcFallback();
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tzlookup = require("tz-lookup") as (lat: number, lng: number) => string;
    const timeZone = tzlookup(lat, lng);
    return date.toLocaleString("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch (err) {
    console.warn("[geo] formatLocalTime fallback to UTC:", err);
    return utcFallback();
  }
}
