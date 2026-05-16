/**
 * Geofence radius used by both iOS region monitoring and the server-side
 * heartbeat-driven exit path. Hardcoded for now; per-project override is a
 * separate post-launch task that adds projects.geofence_radius_meters.
 */
export const DEFAULT_GEOFENCE_RADIUS_M = 150;

/**
 * Hysteresis buffer applied on top of DEFAULT_GEOFENCE_RADIUS_M for the
 * "outside" determination in heartbeat. Inside the core radius we cancel
 * pending exits; beyond radius+buffer we schedule one. Between the two
 * (radius < d <= radius+buffer) we no-op to avoid flapping at the boundary
 * when the user is parked right on the edge.
 */
export const HEARTBEAT_OUTSIDE_BUFFER_M = 50;

/**
 * Heartbeat-scheduled exits use a shorter dwell than the iOS-Exit path
 * (60s vs 5min). The heartbeat is a deliberate location check from a
 * foregrounded app, so confidence the user is genuinely outside is higher
 * than a flaky background-region-monitoring Exit event.
 */
export const HEARTBEAT_DWELL_MS = 60_000;

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

/**
 * Great-circle distance in meters between two lat/lng points.
 * Standard haversine — accurate to <0.5% over typical job-site distances.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000; // earth mean radius, meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}
