/**
 * Timestamp/address overlay — effective-state resolution.
 *
 * Account-level boolean (accounts.photo_overlay_enabled) with a per-project
 * override (projects.photo_overlay_enabled): NULL inherits the account
 * setting, true/false overrides it. Single resolution point shared by
 * server (PDF rendering) and client (settings UI) so precedence can't drift.
 */
export function resolvePhotoOverlay(
  projectOverride: boolean | null | undefined,
  accountEnabled: boolean | null | undefined,
): boolean {
  if (projectOverride === true || projectOverride === false) return projectOverride;
  return accountEnabled === true;
}
