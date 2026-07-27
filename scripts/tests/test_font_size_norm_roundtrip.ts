/**
 * Test — fontSizeNorm survives the strokeToShape ⇄ shapeToStroke round-trip.
 *
 * An "edit mine" flow converts stored strokes to session shapes and back on
 * save. If either direction dropped fontSizeNorm, the stroke would silently
 * downgrade to legacy absolute-px sizing. Run: npx tsx scripts/tests/test_font_size_norm_roundtrip.ts
 */
import { shapeToStroke, strokeToShape } from "../../client/src/lib/annotation-convert";
import { resolveFontSize, FONT_REFERENCE_HEIGHT } from "../../client/src/lib/annotation-svg";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond) failures++;
}

// 1. Norm-bearing stroke: round-trip preserves fontSizeNorm exactly.
const normStroke = { id: "t1", type: "text" as const, x: 0.3, y: 0.2, content: "hi", color: "#fff", fontSize: 28, fontSizeNorm: 28 / 450 };
const rt1 = shapeToStroke(strokeToShape(normStroke));
check("norm stroke round-trip keeps fontSizeNorm", rt1.type === "text" && rt1.fontSizeNorm === 28 / 450);
check("norm stroke round-trip keeps fontSize", rt1.type === "text" && rt1.fontSize === 28);

// 2. Legacy stroke (no fontSizeNorm): round-trip must NOT invent the field.
const legacyStroke = { id: "t2", type: "text" as const, x: 0.1, y: 0.1, content: "old", color: "#000", fontSize: 18 };
const rt2 = shapeToStroke(strokeToShape(legacyStroke));
check("legacy stroke round-trip has no fontSizeNorm key", rt2.type === "text" && !("fontSizeNorm" in rt2));

// 3. Double round-trip stability.
const rt3 = shapeToStroke(strokeToShape(shapeToStroke(strokeToShape(normStroke))));
check("double round-trip stable", rt3.type === "text" && rt3.fontSizeNorm === 28 / 450 && rt3.fontSize === 28);

// 4. Shared resolution rule: norm wins; legacy falls back to FONT_REFERENCE_HEIGHT.
check("resolveFontSize prefers fontSizeNorm", resolveFontSize(normStroke, 900) === (28 / 450) * 900);
check("resolveFontSize legacy fallback", resolveFontSize(legacyStroke, 900) === (18 / FONT_REFERENCE_HEIGHT) * 900);
check("FONT_REFERENCE_HEIGHT is 600", FONT_REFERENCE_HEIGHT === 600);

// 5. Authoring identity: at the authoring surface, resolved px === typed px.
const typedPx = 24, fittedH = 512;
const authored = { id: "t3", type: "text" as const, x: 0, y: 0, content: "x", color: "#fff", fontSize: typedPx, fontSizeNorm: typedPx / fittedH };
check("authoring identity (resolved === typed at authoring height)", Math.abs(resolveFontSize(authored, fittedH) - typedPx) < 1e-9);

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");

// 6. Review follow-ups: schema accepts norm > 1; nextFontSizeNorm preserves prior norm when rect unmeasured.
import("../../shared/schema").then(({ annotationStrokeSchema }) => {
  import("../../client/src/lib/annotation-convert").then(({ nextFontSizeNorm }) => {
    const big = annotationStrokeSchema.safeParse({ id: "t9", type: "text", x: 0, y: 0, content: "big", color: "#fff", fontSize: 96, fontSizeNorm: 1.5 });
    check("schema accepts fontSizeNorm > 1 (small fitted heights)", big.success);
    const insane = annotationStrokeSchema.safeParse({ id: "t9", type: "text", x: 0, y: 0, content: "big", color: "#fff", fontSize: 96, fontSizeNorm: 5 });
    check("schema rejects fontSizeNorm sanity-cap breach (5)", !insane.success);
    check("nextFontSizeNorm computes when height known", nextFontSizeNorm(24, 480) === 0.05);
    check("nextFontSizeNorm preserves prior norm when height unmeasured", nextFontSizeNorm(24, 0, 0.0625) === 0.0625);
    check("nextFontSizeNorm undefined when no height and no prior", nextFontSizeNorm(24, 0) === undefined);
    if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
    console.log("all checks passed (including review follow-ups)");
  });
});
