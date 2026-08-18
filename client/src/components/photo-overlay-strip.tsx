import { useQuery } from "@tanstack/react-query";
import { resolvePhotoOverlay, splitOverlayAddress } from "@shared/photoOverlay";
import type { AccountSettings } from "@shared/schema";

/**
 * In-app (web) counterpart of the report-PDF timestamp/address overlay.
 * Same setting, same resolver (shared/photoOverlay.ts) — this is CSS/DOM
 * text layered over the <img>, never pixel compositing, so toggling the
 * setting is instantly reversible and originals are untouched.
 */

/** Resolve the effective overlay state for a project on the client. */
export function usePhotoOverlayEnabled(
  projectOverride: boolean | null | undefined,
): boolean {
  // GET /api/account/settings is requireReadAccess — every role can read it.
  const { data } = useQuery<AccountSettings>({ queryKey: ["/api/account/settings"] });
  return resolvePhotoOverlay(projectOverride, data?.photoOverlayEnabled);
}

/** "Aug 18, 2026, 2:45 PM" in the viewer's locale conventions (en-US). */
export function formatOverlayTimestamp(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Procore-style treatment: no background fill — a text-shadow is the only
// thing standing in for one, keeping thin white text legible on light photos.
// Blur radii scaled 2x in lockstep with the 11px → 22px text size bump —
// at 22px the original 3px glow read as a faint halo, not an outline.
const OVERLAY_TEXT_SHADOW = "0 0 6px rgba(0,0,0,0.9), 0 2px 4px rgba(0,0,0,0.7)";

/**
 * Procore-style overlay: thin white right-aligned text in the TOP-RIGHT
 * corner of the image, no background. Render it inside a `position:
 * relative` (or otherwise positioned) container that exactly bounds the
 * displayed image. Line 1 = date/time, then the address split across
 * lines (street / city, state zip / country). Renders nothing when there
 * is neither a timestamp nor an address.
 */
export function PhotoOverlayStrip({
  takenAt,
  createdAt,
  address,
}: {
  takenAt: Date | string | null | undefined;
  createdAt: Date | string | null | undefined;
  address: string | null | undefined;
}) {
  const timestamp = formatOverlayTimestamp(takenAt ?? createdAt);
  const addressLines = splitOverlayAddress(address);
  if (!timestamp && addressLines.length === 0) return null;
  const lines = [...(timestamp ? [timestamp] : []), ...addressLines];
  return (
    <div
      className="absolute top-0 right-0 px-2 py-1.5 text-right pointer-events-none"
      data-testid="photo-overlay-strip"
    >
      {lines.map((line, i) => (
        <p
          key={i}
          className="text-[22px] font-light leading-snug text-white truncate"
          style={{ textShadow: OVERLAY_TEXT_SHADOW }}
        >
          {line}
        </p>
      ))}
    </div>
  );
}
