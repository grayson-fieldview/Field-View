import tzlookup from "tz-lookup";

// Shared source of truth for photo timestamp display in shared reports
// (both the web view and the generated PDF). Timestamps reflect
// media.createdAt (upload time), matching the existing "takenAt = alias of
// createdAt" convention used elsewhere in the app.

function safeLookup(
  lat: number | null | undefined,
  lng: number | null | undefined,
): string | null {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) {
    return null;
  }
  try {
    return tzlookup(lat, lng);
  } catch {
    return null;
  }
}

// Resolve an IANA time zone from coordinates. Fallback chain:
// photo coords -> project coords -> "UTC".
export function resolvePhotoTimeZone(
  photoLat: number | null | undefined,
  photoLng: number | null | undefined,
  projectLat: number | null | undefined,
  projectLng: number | null | undefined,
): string {
  return (
    safeLookup(photoLat, photoLng) ??
    safeLookup(projectLat, projectLng) ??
    "UTC"
  );
}

// Format a date in the given IANA time zone as e.g. "Mar 4, 2026 · 2:37 PM".
// Returns null for missing/invalid dates so callers can skip rendering.
export function formatPhotoTimestamp(
  date: Date | string | null | undefined,
  tz: string,
): string | null {
  if (date == null) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;

  const datePart = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
  const timePart = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);

  return `${datePart} · ${timePart}`;
}
