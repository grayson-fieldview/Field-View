import type { CSSProperties } from "react";
import type { AnnotationStroke } from "@shared/schema";

interface AnnotationOverlayProps {
  strokes: AnnotationStroke[];
  className?: string;
  style?: CSSProperties;
  /**
   * Aspect ratio (width/height) of the box the overlay is stretched onto.
   * When omitted, it is derived from numeric style.width/height (the
   * photo-viewer passes the fitted-image rect), else falls back to 1.
   */
  aspectRatio?: number;
}

const ARROW_HEAD_LEN_FRAC = 0.025;

export function AnnotationOverlay({ strokes, className, style, aspectRatio }: AnnotationOverlayProps) {
  if (strokes.length === 0) return null;
  const positionClasses = style ? "absolute" : "absolute inset-0 w-full h-full";

  // AR-correct viewBox fix (oval-circles bug): the old square
  // viewBox="0 0 1000 1000" anisotropically stretched geometry onto
  // non-square photos — circle radii computed in square space rendered as
  // ellipses, and stroke thickness varied by direction. Rendering in a
  // viewBox whose AR matches the target box makes all geometry isotropic.
  // preserveAspectRatio="none" stays: with a matching-AR viewBox it is an
  // identity stretch, and for the ar=1 fallback (thumbnails without a
  // numeric style) it preserves the previous fill behavior instead of
  // letterboxing the overlay. Endpoints map to identical pixels (x·W, y·H),
  // so existing strokes do NOT move — only circles regain their true shape.
  const styleW = typeof style?.width === "number" ? style.width : 0;
  const styleH = typeof style?.height === "number" ? style.height : 0;
  const ar = aspectRatio || (styleW && styleH ? styleW / styleH : 1);
  const vbW = 1000 * ar;
  const vbH = 1000;

  return (
    <svg
      viewBox={`0 0 ${vbW} ${vbH}`}
      preserveAspectRatio="none"
      className={`pointer-events-none ${positionClasses} ${className || ""}`}
      style={style}
      data-testid="annotation-overlay"
    >
      <defs>
        {strokes
          .filter((s) => s.type === "arrow")
          .map((s) => (
            <marker
              key={`m-${s.id}`}
              id={`arrow-${s.id}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={s.color} />
            </marker>
          ))}
      </defs>
      {strokes.map((s) => renderStroke(s, vbW, vbH))}
    </svg>
  );
}

function renderStroke(s: AnnotationStroke, vbW: number, vbH: number) {
  // Text annotations are rendered by the parent (photo-viewer) as HTML divs.
  if (s.type === "text") return null;
  const stroke = s.color;
  const strokeWidth = s.width;
  const common = {
    stroke,
    strokeWidth,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (s.type === "pencil") {
    if (s.points.length < 2) return null;
    const pts = s.points.map((p) => `${p.x * vbW},${p.y * vbH}`).join(" ");
    return <polyline key={s.id} points={pts} {...common} />;
  }
  if (s.type === "line") {
    const [p1, p2] = s.points;
    if (!p1 || !p2) return null;
    return (
      <line
        key={s.id}
        x1={p1.x * vbW}
        y1={p1.y * vbH}
        x2={p2.x * vbW}
        y2={p2.y * vbH}
        {...common}
      />
    );
  }
  if (s.type === "arrow") {
    const [p1, p2] = s.points;
    if (!p1 || !p2) return null;
    return (
      <line
        key={s.id}
        x1={p1.x * vbW}
        y1={p1.y * vbH}
        x2={p2.x * vbW}
        y2={p2.y * vbH}
        {...common}
        markerEnd={`url(#arrow-${s.id})`}
      />
    );
  }
  if (s.type === "rectangle") {
    const [p1, p2] = s.points;
    if (!p1 || !p2) return null;
    const x = Math.min(p1.x, p2.x) * vbW;
    const y = Math.min(p1.y, p2.y) * vbH;
    const w = Math.abs(p2.x - p1.x) * vbW;
    const h = Math.abs(p2.y - p1.y) * vbH;
    return <rect key={s.id} x={x} y={y} width={w} height={h} {...common} />;
  }
  if (s.type === "circle") {
    const [center, edge] = s.points;
    if (!center || !edge) return null;
    const cx = center.x * vbW;
    const cy = center.y * vbH;
    const dx = (edge.x - center.x) * vbW;
    const dy = (edge.y - center.y) * vbH;
    const r = Math.sqrt(dx * dx + dy * dy);
    return <circle key={s.id} cx={cx} cy={cy} r={r} {...common} />;
  }
  return null;
}

void ARROW_HEAD_LEN_FRAC;
