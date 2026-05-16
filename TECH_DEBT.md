# Tech Debt

## ESM-only server dependencies

ESM-only server deps are incompatible with our CJS bundle (esbuild
target=node, format=cjs). Already known from archiver v7 pin. When
installing any new server dep, check package.json `type` field and
`exports` entries before proceeding. Time bombs only surface at
runtime in prod.

Pinned for CJS compatibility:
- `archiver` — v7 pinned (ESM-only above)
- `p-limit` — v3 pinned (v4+ are ESM-only)

## Stale `shared_galleries.media_ids` after photo hard-delete

`DELETE /api/media/:id` (server/routes.ts:962) removes the media row and lets
FK cascade clean up join tables, but `shared_galleries.media_ids` is a plain
`integer[]` column with no FK — stale ids accumulate there after deletes.
Already broken today; not made worse by the cross-context reference work in
session-on photo-delete-from-gallery. Fix would be either (a) scrub matching
ids from any `shared_galleries.media_ids` row containing the deleted id at
delete time, or (b) filter unknown ids when resolving a shared gallery for
viewing. (b) is cheaper and degrades gracefully.

## Restricted users can hard-delete any in-account photo

`DELETE /api/media/:id` (server/routes.ts:962) currently only checks
`verifyMediaAccess(mediaId, accountId)` — same-account, nothing more. A
restricted user can delete any photo in their account, including photos on
projects they aren't assigned to and can't otherwise see. Should be scoped
to media on projects the caller is assigned to (or created), mirroring the
project-assignment scoping already applied to `/api/reports` and
`/api/checklists`. Likely small fix: add a restricted-user branch that
joins media → projects → project_assignments and rejects with 404 (to match
the "don't leak cross-context ids" convention) when the project isn't in
the caller's visible set.
