import type { CSSProperties } from "react";
import { TAG_COLORS } from "@shared/tagColors";

export { TAG_COLORS };

/**
 * Inline style for a colored tag badge: tinted background, tinted border,
 * full-strength text. Returns undefined for null/missing color so the
 * badge keeps its current default variant styling.
 */
export function tagBadgeStyle(color?: string | null): CSSProperties | undefined {
  if (!color) return undefined;
  return {
    backgroundColor: `${color}1f`,
    borderColor: `${color}80`,
    color,
  };
}

/** name → color lookup from the /api/tags list (case-insensitive). */
export function buildTagColorMap(
  tags: { name: string; color?: string | null }[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tags || []) {
    if (t.color) map.set(t.name.toLowerCase(), t.color);
  }
  return map;
}
