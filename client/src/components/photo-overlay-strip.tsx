import { useQuery } from "@tanstack/react-query";
import { resolvePhotoOverlay } from "@shared/photoOverlay";
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

/**
 * The strip itself. Render it inside a `position: relative` (or otherwise
 * positioned) container that exactly bounds the displayed image — it pins
 * itself to that container's bottom edge. Renders nothing when there is
 * neither a timestamp nor an address.
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
  if (!timestamp && !address) return null;
  return (
    <div
      className="absolute bottom-0 left-0 right-0 bg-black/55 px-2 py-1 pointer-events-none"
      data-testid="photo-overlay-strip"
    >
      {timestamp && (
        <p className="text-[11px] leading-snug text-white truncate">{timestamp}</p>
      )}
      {address && (
        <p className="text-[11px] leading-snug text-white truncate">{address}</p>
      )}
    </div>
  );
}
