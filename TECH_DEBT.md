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
