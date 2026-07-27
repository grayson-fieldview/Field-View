---
name: Annotation text fontSize contract
description: How stored text fontSize scales across web, mobile, and PDF renderers
---
Stored text-stroke `fontSize` is absolute px authored against a notional 1000px-tall image; positions are 0–1 normalized. Every renderer must resolve it via the shared `resolveFontSize(fontSize, renderedHeightPx)` with `FONT_REFERENCE_HEIGHT = 1000` (exported from the web annotation-svg module) — the mobile repo and any PDF flatten must use the identical constant/function.

**Why:** fontSize was the only non-normalized value in the payload; rendering it raw into a differently-sized basis makes text invisible or wrong-sized (thumbnail text bug, July 2026). No payload migration — render-time scaling only.

**How to apply:** SVG overlay path renders text in viewBox units (vbH=1000, so the helper is identity there) with `dominant-baseline="text-before-edge"` + `text-anchor="start"` to match the HTML div top-left anchor; the full-size viewer keeps its HTML div text layer and passes `renderText={false}` to the shared overlay. Android has an unverified issue with `dominant-baseline` — verify on mobile.
