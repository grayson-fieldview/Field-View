import type { AnnotationStroke } from "@shared/schema";

export type AnnotationPoint = { x: number; y: number };

export type AnnotationShape =
  | { type: "freehand"; points: AnnotationPoint[]; color: string; width: number }
  | { type: "arrow"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: "circle"; center: AnnotationPoint; radius: AnnotationPoint; color: string; width: number }
  | { type: "rectangle"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: "line"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: "text"; id: string; x: number; y: number; content: string; color: string; fontSize: number; fontSizeNorm?: number };

export type TextAnnotation = Extract<AnnotationStroke, { type: "text" }>;
export const isTextStroke = (s: AnnotationStroke): s is TextAnnotation => s.type === "text";
export const isTextShape = (s: AnnotationShape): s is Extract<AnnotationShape, { type: "text" }> => s.type === "text";

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Next fontSizeNorm for a text commit: typedPx / fitted-image height when the
 * rect is measured; otherwise PRESERVE the previous norm rather than dropping
 * it — overwriting with undefined would silently downgrade an existing
 * normalized stroke to legacy-px on an edit re-save.
 */
export function nextFontSizeNorm(
  typedPx: number,
  fittedHeightPx: number,
  prevNorm?: number,
): number | undefined {
  return fittedHeightPx > 0 ? typedPx / fittedHeightPx : prevNorm;
}

// fontSizeNorm must survive BOTH directions: a strokeToShape → shapeToStroke
// round-trip ("edit mine") that dropped it would silently downgrade the
// stroke to legacy absolute-px sizing.
export function shapeToStroke(shape: AnnotationShape): AnnotationStroke {
  if (shape.type === "text") {
    return {
      id: shape.id,
      type: "text",
      x: shape.x,
      y: shape.y,
      content: shape.content,
      color: shape.color,
      fontSize: shape.fontSize,
      ...(shape.fontSizeNorm !== undefined ? { fontSizeNorm: shape.fontSizeNorm } : {}),
    };
  }
  if (shape.type === "freehand") {
    return { id: newId(), type: "pencil", color: shape.color, width: shape.width, points: shape.points };
  }
  if (shape.type === "circle") {
    return { id: newId(), type: "circle", color: shape.color, width: shape.width, points: [shape.center, shape.radius] };
  }
  return { id: newId(), type: shape.type, color: shape.color, width: shape.width, points: [shape.start, shape.end] };
}

export function strokeToShape(stroke: AnnotationStroke): AnnotationShape {
  if (stroke.type === "text") {
    return {
      type: "text",
      id: stroke.id,
      x: stroke.x,
      y: stroke.y,
      content: stroke.content,
      color: stroke.color,
      fontSize: stroke.fontSize,
      ...(stroke.fontSizeNorm !== undefined ? { fontSizeNorm: stroke.fontSizeNorm } : {}),
    };
  }
  const { color, width, points } = stroke;
  if (stroke.type === "pencil") {
    return { type: "freehand", color, width, points };
  }
  const [a, b] = points;
  const safeA = a || { x: 0, y: 0 };
  const safeB = b || safeA;
  if (stroke.type === "circle") {
    return { type: "circle", color, width, center: safeA, radius: safeB };
  }
  return { type: stroke.type, color, width, start: safeA, end: safeB };
}
