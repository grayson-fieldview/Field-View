/**
 * Fixed tag-color palette, shared by client (swatch picker, badge styling)
 * and server (validation on POST/PATCH /api/tags). account_tags.color must
 * be exactly one of these hex values or null — the API rejects anything
 * else, so the palette can't drift between the picker and the DB.
 */
export const TAG_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // amber
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export function isValidTagColor(value: unknown): value is TagColor {
  return typeof value === "string" && (TAG_COLORS as readonly string[]).includes(value);
}
