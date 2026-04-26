# Field View - Jobsite Photo Documentation & Project Management

## Overview
Field View is an "Field Intelligence Platform" designed for field service teams to capture, organize, and share job site photos, track project progress, collaborate, and manage tasks. It aims to be a comprehensive project management tool differentiating itself from basic photo documentation solutions. The platform supports key features like advanced photo annotations, project-specific data organization, multi-team collaboration, and detailed analytics for construction and inspection industries.

## User Preferences
- Dark mode toggle saved to localStorage
- Sidebar navigation with collapsible functionality

## System Architecture
Field View utilizes a modern web application architecture with a clear separation between frontend and backend.

**Frontend:**
- Built with React 18 and TypeScript, styled using Tailwind CSS and shadcn/ui components for a clean, professional, enterprise-grade look inspired by Procore.
- Uses `wouter` for client-side routing and `TanStack React Query v5` for state management.
- Features include:
    - **UI/UX**: Orange primary (#F09000), green accents (#267D32), charcoal sidebar (#1E1E1E), warm cream backgrounds (#F0EDEA). Fonts are Inter (sans) and DM Serif Display (serif headings).
    - **Core Pages**: Landing, Login, Register, Forgot Password, Subscribe, Dashboard, Project Detail (Photos, Tasks, Checklists, Reports, Daily Log tabs), Photos (global gallery), Map, Team, Settings, Checklists (global), Reports (global), Gallery (public).
    - **Photo Features**: Annotations (5 tools, 8 colors), batch upload with preview, mobile camera capture support. Inline description (caption) editing, tag management from account-defined photo tags.
    - **Tagging System**: Account-level custom tags for photos and projects. Managed in Settings. Tags are `text[]` arrays on both `media` and `projects` tables. Account tag definitions stored in `account_tags` table with `type` enum (photo/project).
    - **Project Management**: Project creation/management with status, address, color, cover photo, project tags. Task management, Checklist management with templates, Report generation with templates.
    - **Collaboration**: User roles (Admin, Manager, Standard, Restricted), user invitations, project assignments.
    - **Analytics**: Dashboard with KPI strip, various charts (photos by user, over time, by project, task status), mini-map, activity feed, time period filtering.
    - **Unique Features**: Before/After Photo Comparison slider, Daily Log auto-generation, shareable photo galleries.

**Backend:**
- Developed with Node.js and Express.
- Uses PostgreSQL with Drizzle ORM for data persistence.
- **Multi-Tenancy**: Account-based isolation where each organization is an `account`. Users, projects, templates, and all child data are linked to an `accountId`. All API endpoints enforce `accountId` verification to prevent cross-account access.
- **Authentication**: Custom email/password authentication using Passport.js local strategy with bcryptjs for password hashing. Sessions are stored in PostgreSQL using `connect-pg-simple`. User profiles include subscription status and Stripe customer IDs.
- **File Storage**: Photos are uploaded to AWS S3 (`fieldview-storage` bucket in `us-east-2`) via presigned URL direct uploads. The browser requests a presigned PUT URL from `POST /api/uploads/sign`, uploads the file directly to S3, then posts the resulting S3 key/URL to `POST /api/projects/:id/media` to create the database record. This bypasses the serverless function body-size limit and is forward-compatible with Vercel.
- **Vercel readiness**: `server/index.ts` exports the Express `app` and only calls `httpServer.listen()` when `!process.env.VERCEL`. Startup work (Stripe sync, seed, admin bootstrap, orphan cleanup, auth-column migration) is gated the same way and lives in named exported functions so it can be invoked manually post-deploy. `server/serverless.ts` is the Vercel serverless entry, esbuilt to `api/index.js` during `npm run build` (see "Build artifacts: api/index.js" below). `vercel.json` rewrites `/api/*` to the function and everything else to the SPA. PG pool size is `1` when running on Vercel, `10` otherwise.
- **API Endpoints**: Comprehensive RESTful API for all frontend functionalities including user management, project operations, media handling, task/checklist/report management, invitations, analytics, and billing.

## Build artifacts: api/index.js
`api/index.js` is a ~1.3MB pre-built minified Vercel serverless bundle, **intentionally tracked in git**. The committed bytes are expected to be stale and that is by design — Vercel rebuilds the file from current source on every deploy, so production always runs a fresh bundle.

- **Why it's tracked**: Vercel's serverless-function auto-detection scanner runs against the **uploaded** git tree *before* `buildCommand` executes. If `api/index.js` isn't present at upload time, Vercel never registers the function, the `/api/(.*) → /api/index` rewrite in `vercel.json` resolves to nothing, and every `/api/*` request returns Vercel's 404 HTML. Documented in commit `6fc02e5` ("fix(vercel): commit bundled api/index.js so Vercel detects the function"), which un-gitignored the file after the previous gitignored-bundle approach caused a zero-runtime-logs production outage.
- **How it gets refreshed**: `vercel.json` has `"buildCommand": "npm run build"`. That runs `tsx script/build.ts`, which esbuilds `server/serverless.ts` → `api/index.js` (CJS, minified, `node20` target, all allowlisted server deps inlined). The committed bytes get overwritten on every deploy.
- **Do NOT manually rebuild and commit it.** Source changes in `server/` will appear stale in the committed `api/index.js` until the next deploy — that is harmless. Manual rebuilds just create 1.3MB of diff churn and can mislead code search (`rg` returns matches against the stale bundle that don't reflect production). If you need to verify what production runs, read `server/serverless.ts` and the `server/` source it imports, not the bundle.
- **Companion file**: `api/package.json` contains `{"type":"commonjs"}` to override the root `type:module`, so Node loads the bundle as CJS. Without this, `module.exports` is a no-op under ESM and Vercel sees an empty handler → 404 on every request (also documented in commit `aea4a10`).

## External Dependencies
- **PostgreSQL**: Primary database for all application data, including user sessions.
- **Stripe**: For subscription billing, managed via `stripe-replit-sync`. Integrates with Stripe Checkout for payment collection and Stripe Billing Portal for customer management. Webhooks handle subscription status updates.
- **AWS S3**: Cloud storage for all uploaded photos and media assets.
- **Google Maps JavaScript API**: Used for displaying project locations on a map and providing address autocomplete functionality via the Places API.
- **bcryptjs**: Library for hashing user passwords securely.
- **Passport.js**: Authentication middleware for Node.js, used for local email/password strategy.
- **@aws-sdk/client-s3**: AWS SDK for JavaScript to interact with S3.
- **Multer**: Middleware for handling `multipart/form-data`, primarily for file uploads.