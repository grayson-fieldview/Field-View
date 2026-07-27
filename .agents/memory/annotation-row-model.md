---
name: Annotation row model
description: media_annotations one-row-per-(media,user) invariant, merge-on-save semantics, and stroke-id caveats
---

# media_annotations row model

Rule: exactly ONE media_annotations row per (media_id, user_id), enforced by unique index `media_annotations_media_user_uniq` (created by `scripts/migrations/migrate_media_annotations_dedupe.ts`). Server POST maps 23505 → 409; clients must fall back to merge-and-PUT.

**Why:** July 2026 build-43 incident — web POSTed a duplicate row per save while mobile rendered only the newest row per user, making older strokes invisible on mobile (no DB loss, silent divergence). Cross-client conventions must be DB constraints.

**How to apply:**
- Web save merges: refetch annotations immediately before every save (block save if the GET fails — blind PUT against the render-time TanStack cache is the destructive stale-PUT hole).
- Edit-mode merge uses a baseline id set captured at seed time: final = session strokes ∪ (fresh strokes not in baseline). Preserves eraser deletions AND concurrent adds from other clients.
- Caveat: `shapeToStroke` regenerates ids for non-text strokes on every save, so stroke identity does not survive a web edit round-trip; only the baseline-set approach works, id-equality across saves does not.
- Web photo-viewer displays the UNION of all rows; mobile displays one row per user — until the dedupe migration runs, duplicates look fine on web and broken on mobile.
