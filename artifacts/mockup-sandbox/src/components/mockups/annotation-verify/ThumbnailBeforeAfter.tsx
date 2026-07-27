import { AnnotationOverlay } from "./_annotation-svg";
import type { AnnotationStroke } from "./annotation-types";

// Exact stroke set seeded in the dev DB for media 5 (text + circle + rectangle).
const strokes: AnnotationStroke[] = [
  { id: "t1", type: "text", x: 0.3, y: 0.2, content: "LEAK HERE", color: "#f97316", fontSize: 28 },
  { id: "c1", type: "circle", color: "#ef4444", width: 4, points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }] },
  { id: "r1", type: "rectangle", color: "#3b82f6", width: 4, points: [{ x: 0.15, y: 0.6 }, { x: 0.45, y: 0.85 }] },
];

// Replicates project-detail.tsx grid cell: aspect-[4/3], overflow-hidden,
// object-cover img, AnnotationOverlay with default props (absolute inset-0).
function Thumb({ width, renderText, label }: { width: number; renderText?: boolean; label: string }) {
  return (
    <div>
      <div className="text-xs font-mono mb-1 text-gray-600">{label} — {width}px wide</div>
      <div style={{ width }} className="aspect-[4/3] rounded-md overflow-hidden bg-muted relative">
        <img src="/__mockup/images/seed-plumbing-1.png" alt="" className="w-full h-full object-cover" />
        <AnnotationOverlay strokes={strokes} renderText={renderText} />
      </div>
    </div>
  );
}

export function ThumbnailBeforeAfter() {
  return (
    <div className="min-h-screen bg-white p-8 flex flex-wrap gap-8 items-start">
      <Thumb width={280} renderText={false} label="BEFORE (text dropped)" />
      <Thumb width={280} label="AFTER (default renderText)" />
      <Thumb width={180} label="AFTER — narrower container" />
      <Thumb width={400} label="AFTER — wider container" />
    </div>
  );
}
