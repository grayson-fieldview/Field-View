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
  /**
   * When false, text strokes are skipped — for callers (photo-viewer) that
   * render text as their own HTML div layer. Defaults to true so callers
   * without an HTML text layer (e.g. grid thumbnails) get SVG text.
   */
  renderText?: boolean;
}

/**
 * Stored text fontSize is absolute px authored against a notional
 * 1000px-tall image. Both web surfaces, the mobile repo, and any future
 * PDF flatten must resolve it through this exact function so text scales
 * identically everywhere: fontSize is a fixed fraction of rendered height.
 */
export const FONT_REFERENCE_HEIGHT = 1000;
export function resolveFontSize(strokeFontSize: number, renderedHeightPx: number): number {
  return (strokeFontSize / FONT_REFERENCE_HEIGHT) * renderedHeightPx;
}

const ARROW_HEAD_LEN_FRAC = 0.025;

export function AnnotationOverlay({ strokes, className, style, aspectRatio, renderText = true }: AnnotationOverlayProps) {
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
      {strokes.map((s) => renderStroke(s, vbW, vbH, renderText))}
    </svg>
  );
}

function renderStroke(s: AnnotationStroke, vbW: number, vbH: number, renderText: boolean) {
  if (s.type === "text") {
    // photo-viewer renders text as HTML divs and passes renderText={false};
    // all other callers get SVG text on the shared path.
    if (!renderText) return null;
    const fontSize = resolveFontSize(s.fontSize, vbH);
    return (
      <text
        key={s.id}
        x={s.x * vbW}
        // Explicit baseline offset instead of dominant-baseline: attribute
        // support differs across Safari, react-native-svg (Android), and
        // server-side renderers; arithmetic behaves identically everywhere.
        // Matches the mobile repo's shipping expression.
        y={s.y * vbH + fontSize * 0.8}
        fill={s.color}
        fontSize={fontSize}
        fontWeight={600}
        fontFamily="Inter, system-ui, -apple-system, sans-serif"
        textAnchor="start"
        style={{
          // Contrast treatment mirroring the HTML layer's dark text-shadow:
          // dark halo painted under the glyph fill.
          paintOrder: "stroke",
          stroke: "rgba(0,0,0,0.9)",
          strokeWidth: fontSize / 8,
          strokeLinejoin: "round",
        }}
      >
        {s.content}
      </text>
    );
  }
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
