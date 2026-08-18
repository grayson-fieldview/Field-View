/**
 * Timestamp/address overlay — effective-state resolution.
 *
 * Account-level boolean (accounts.photo_overlay_enabled) with a per-project
 * override (projects.photo_overlay_enabled): NULL inherits the account
 * setting, true/false overrides it. Single resolution point shared by
 * server (PDF rendering) and client (settings UI) so precedence can't drift.
 */
/**
 * Split a project address into Procore-style overlay lines:
 * street / "city, state zip" / country. Comma-based heuristic:
 *   1 part  → as-is
 *   2 parts → street / rest
 *   3 parts → street / "p1, p2" (city + state-zip)
 *   4 parts → street / "p1, p2" / country
 * Anything longer doesn't split cleanly → single line fallback.
 * Used verbatim by both the web strip and the PDF renderer.
 */
export function splitOverlayAddress(address: string | null | undefined): string[] {
  if (!address) return [];
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts;
  if (parts.length === 2) return parts;
  if (parts.length === 3) return [parts[0], `${parts[1]}, ${parts[2]}`];
  if (parts.length === 4) return [parts[0], `${parts[1]}, ${parts[2]}`, parts[3]];
  return [parts.join(", ")];
}

export function resolvePhotoOverlay(
  projectOverride: boolean | null | undefined,
  accountEnabled: boolean | null | undefined,
): boolean {
  if (projectOverride === true || projectOverride === false) return projectOverride;
  return accountEnabled === true;
}
