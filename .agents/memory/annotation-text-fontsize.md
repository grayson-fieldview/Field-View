---
name: Annotation text fontSize contract
description: How text annotation font size is stored and resolved across web, mobile, and PDF renderers
---
Text strokes carry TWO sizing fields (additive migration, July 2026):
- `fontSize` (required, legacy): absolute px authored against the full-size viewer's fitted-image box. Meaning must NEVER change — old mobile builds on TestFlight/Play still read/write it and can't be force-updated.
- `fontSizeNorm` (optional, canonical): 0–1 fraction of image height, written alongside fontSize on every web text commit (`typedPx / fittedRectHeight`).

Single resolution rule on EVERY surface (SVG overlay, full-size HTML divs, canvas draw, flatten, mobile, PDF):
`resolvedPx = (fontSizeNorm ?? fontSize / FONT_REFERENCE_HEIGHT) * renderedHeightPx` with `FONT_REFERENCE_HEIGHT = 600` (user-calibrated; corroborated by the old flatten pre-scaler and mobile authoring basis — do not re-derive).

**Why:** fontSize was the only non-normalized payload value; raw px in a different render basis made text invisible/wrong-sized (thumbnail bug). Norm removes calibration; the 600 fallback keeps legacy rows and old-client writes rendering.

**How to apply:** helpers live in the web annotation-svg module; conversion (strokeToShape/shapeToStroke) must carry fontSizeNorm both ways or edits silently downgrade strokes to legacy — a round-trip test guards this. Schema caps fontSizeNorm at 4 (sanity), NOT 1 — typedPx/fittedHeight can exceed 1 on small windows. SVG text uses explicit baseline arithmetic `y = anchorY + resolvedPx*0.8` (no dominant-baseline — Safari/react-native-svg/server renderers differ). Backfill script (`fontSizeNorm = fontSize/600`, idempotent) exists in scripts/migrations; user runs prod themselves.
