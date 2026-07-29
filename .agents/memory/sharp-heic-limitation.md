---
name: sharp cannot decode HEIC
description: Why HEIC images need the WASM heic-decode package before sharp, on Vercel and Replit
---
sharp's official prebuilt libvips binaries (all platforms, incl. Vercel linux-x64) have **no HEVC/HEIC decoder** — HEIF support is AVIF-only, for patent-licensing reasons. `sharp(heicBuffer)` fails with "No decoding plugin installed for this compression format". Not fixable by config; a custom libvips build is impossible on Vercel.

**Why it matters:** S3 keys preserve client extensions, so real .heic objects exist (~2% of photos). Any sharp-based feature fed raw S3 bytes silently breaks for them.

**How to apply:** decode first with the WASM `heic-decode` package (in deps, typed in server/types/heic-decode.d.ts), then `sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })`. Do NOT `.rotate()` the raw pixels — libheif already applies the file's orientation/crop transforms. It's slow (~2–3s per photo) — keep it out of request paths (defer via waitUntil, like the thumbnail generation in server/lib/thumbnails.ts).
