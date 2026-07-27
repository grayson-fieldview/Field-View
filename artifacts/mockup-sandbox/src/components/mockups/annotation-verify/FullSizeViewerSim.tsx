import { AnnotationOverlay } from "./_annotation-svg";
import type { AnnotationStroke } from "./annotation-types";

const strokes: AnnotationStroke[] = [
  { id: "t1", type: "text", x: 0.3, y: 0.2, content: "LEAK HERE", color: "#f97316", fontSize: 28 },
  { id: "c1", type: "circle", color: "#ef4444", width: 4, points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }] },
  { id: "r1", type: "rectangle", color: "#3b82f6", width: 4, points: [{ x: 0.15, y: 0.6 }, { x: 0.45, y: 0.85 }] },
];

// Replicates photo-viewer.tsx full-size path: fitted-image rect with numeric
// style (drives AR-correct viewBox), renderText={false} on the SVG, and the
// HTML div text layer with the exact styles from photo-viewer.tsx.
function Viewer({ renderText, label }: { renderText: boolean; label: string }) {
  const rect = { width: 600, height: 450 }; // fitted 4:3 image rect
  return (
    <div>
      <div className="text-xs font-mono mb-1 text-gray-300">{label}</div>
      <div className="relative bg-black" style={rect}>
        <img src="/__mockup/images/seed-plumbing-1.png" alt="" style={{ ...rect, objectFit: "contain", position: "absolute", left: 0, top: 0 }} />
        <AnnotationOverlay strokes={strokes} style={{ left: 0, top: 0, ...rect }} renderText={renderText} />
        {strokes.filter((s): s is Extract<AnnotationStroke, { type: "text" }> => s.type === "text").map((t) => (
          <div
            key={t.id}
            className="absolute select-none"
            style={{
              left: `${t.x * 100}%`,
              top: `${t.y * 100}%`,
              color: t.color,
              fontSize: t.fontSize,
              fontWeight: 600,
              lineHeight: 1.1,
              whiteSpace: "nowrap",
              textShadow: "0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)",
              pointerEvents: "none",
            }}
          >
            {t.content}
          </div>
        ))}
      </div>
    </div>
  );
}

export function FullSizeViewerSim() {
  return (
    <div className="min-h-screen bg-gray-900 p-8 flex flex-wrap gap-8 items-start">
      <Viewer renderText={false} label="AFTER (renderText=false + HTML div — production wiring)" />
      <Viewer renderText={false} label="BEFORE (identical — old overlay also skipped text)" />
    </div>
  );
}
