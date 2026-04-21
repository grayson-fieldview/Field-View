import type { AnnotationStroke } from "@shared/schema";

interface AnnotationOverlayProps {
  strokes: AnnotationStroke[];
  className?: string;
}

const ARROW_HEAD_LEN_FRAC = 0.025;

export function AnnotationOverlay({ strokes, className }: AnnotationOverlayProps) {
  if (strokes.length === 0) return null;
  return (
    <svg
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      className={`pointer-events-none absolute inset-0 w-full h-full ${className || ""}`}
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
      {strokes.map((s) => renderStroke(s))}
    </svg>
  );
}

function renderStroke(s: AnnotationStroke) {
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
    const pts = s.points.map((p) => `${p.x * 1000},${p.y * 1000}`).join(" ");
    return <polyline key={s.id} points={pts} {...common} />;
  }
  if (s.type === "line") {
    const [p1, p2] = s.points;
    if (!p1 || !p2) return null;
    return (
      <line
        key={s.id}
        x1={p1.x * 1000}
        y1={p1.y * 1000}
        x2={p2.x * 1000}
        y2={p2.y * 1000}
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
        x1={p1.x * 1000}
        y1={p1.y * 1000}
        x2={p2.x * 1000}
        y2={p2.y * 1000}
        {...common}
        markerEnd={`url(#arrow-${s.id})`}
      />
    );
  }
  if (s.type === "rectangle") {
    const [p1, p2] = s.points;
    if (!p1 || !p2) return null;
    const x = Math.min(p1.x, p2.x) * 1000;
    const y = Math.min(p1.y, p2.y) * 1000;
    const w = Math.abs(p2.x - p1.x) * 1000;
    const h = Math.abs(p2.y - p1.y) * 1000;
    return <rect key={s.id} x={x} y={y} width={w} height={h} {...common} />;
  }
  if (s.type === "circle") {
    const [center, edge] = s.points;
    if (!center || !edge) return null;
    const cx = center.x * 1000;
    const cy = center.y * 1000;
    const dx = (edge.x - center.x) * 1000;
    const dy = (edge.y - center.y) * 1000;
    const r = Math.sqrt(dx * dx + dy * dy);
    return <circle key={s.id} cx={cx} cy={cy} r={r} {...common} />;
  }
  return null;
}

void ARROW_HEAD_LEN_FRAC;
