# Field View - Jobsite Photo Documentation & Project Management

## Overview
Field View is an "Field Intelligence Platform" designed for field service teams to capture, organize, and share job site photos, track project progress, collaborate, and manage tasks. It offers comprehensive project management features, including advanced photo annotations, project-specific data organization, multi-team collaboration, and detailed analytics for construction and inspection industries. The platform aims to differentiate itself from basic photo documentation solutions by providing a complete project management ecosystem.

## User Preferences
- Dark mode toggle saved to localStorage
- Sidebar navigation with collapsible functionality

## System Architecture
Field View employs a modern web application architecture with a clear separation between frontend and backend components.

**Frontend:**
- **Technology Stack**: React 18 with TypeScript, styled using Tailwind CSS and shadcn/ui components. `wouter` is used for client-side routing, and `TanStack React Query v5` for state management.
- **UI/UX**: Features an enterprise-grade design inspired by Procore, utilizing an orange primary color (#F09000), green accents (#267D32), charcoal sidebar (#1E1E1E), and warm cream backgrounds (#F0EDEA). Fonts are Inter (sans-serif) and DM Serif Display (serif for headings).
- **Key Features**:
    - **Photo Management**: Advanced annotations, batch uploads via dashed-drop-zone modal (`UploadPhotosDialog`, click-to-pick or drag-drop, per-file status icons, max 20/batch, 50MB images / 500MB video), mobile camera support, inline description editing, and account-defined tag management.
    - **Project Management**: Creation and management of projects with status, address, color, cover photos, and project-specific tags. Includes task management, checklist management with templates, and report generation.
    - **Collaboration**: Supports user roles (Admin, Manager, Standard, Restricted), user invitations, and project assignments.
    - **Analytics**: A comprehensive dashboard with KPIs, various charts (photos by user, over time, by project, task status), a mini-map, activity feed, and time period filtering.
    - **Unique Features**: Before/After Photo Comparison slider, Daily Log auto-generation, and shareable photo galleries.
    - **Showcases / Public Portfolio (July 2026)**: CompanyCam-style curated portfolios. Internal pages `/showcases` (index + analytics), `/showcases/:id/edit`, `/showcases/settings`. Public pages `/p/:slug` (portfolio, `/embed` variant) and `/p/:slug/:showcaseSlug`; `/p/:slug` resolver falls back to legacy project share tokens on 404. Server module `server/showcases.ts`; public photos served only via `/api/public/showcase-img/:mediaId` (sharp-resized, EXIF-stripped, gated on published + portfolio enabled; owner-auth fallback for drafts). Display coordinates are obfuscated server-side (~0.15–0.5 mi deterministic jitter seeded by showcase id) on save — precise coords are never persisted or exposed. OG/JSON-LD HTML injection for `/p/*` runs in production only (vercel.json rewrite `/p/(.*) → /api/index`); JSON-LD uses a `</script>`-breakout-safe serializer. Anonymous view analytics in `showcase_views` (client sessionStorage-throttled).
    - **Timesheet Management**: For managers/admins, located at `/manager/timesheets`. Aggregates hours and labor costs, offers table and chart views, and CSV export (Generic, Gusto, QuickBooks formats). Includes manual entry, edit, and delete functionalities with overlap detection and an audit trail for edits.
    - **Geofencing (REMOVED July 2026)**: Geofence-based auto clock-in/out was removed from mobile (v1.1.0), web UI, and server code. All `/api/geofence/*` endpoints, `/api/heartbeat`, `/api/projects/geofence-eligible`, the `process-pending-exits`/`process-pending-enters` crons, the auto-undo endpoint, the `autoTrackingEnabled` preferences endpoint, and geofence-only storage methods/helpers are gone. **Schema intentionally untouched**: `pending_geofence_exits`/`pending_geofence_enters` tables, the `auto_geofence` enum value, and `users.autoTrackingEnabled`/`users.expoPushToken` columns remain (no migrations). What SURVIVES: `GET /api/cron/max-shift-cleanup` (Vercel Cron every 30 min, auth `Authorization: Bearer ${CRON_SECRET}`) — the 12-hour orphan-shift safety net covering ALL entry sources; it uses `executeAutoClockOut` (`server/lib/timesheets.ts`), `formatLocalTime` (`server/lib/geo.ts`), push receipts via `server/lib/push.ts` (expo-server-sdk), and the `/api/users/push-token` register/clear endpoints. `CRON_SECRET` must stay set on Vercel; generate via `openssl rand -hex 32`. The manual clock-in route still accepts (and gates) `source: "auto_geofence"` for old mobile builds.

**Backend:**
- **Technology Stack**: Node.js with Express.js, using PostgreSQL for data persistence via Drizzle ORM.
- **Multi-Tenancy**: Account-based isolation ensures data separation for different organizations. All API endpoints enforce `accountId` verification.
- **Authentication**: Custom email/password authentication using Passport.js with `bcryptjs` for password hashing. Sessions are stored in PostgreSQL.
- **File Storage**: Photos are uploaded directly to AWS S3 using presigned URLs, bypassing the server for efficiency and scalability.
- **Vercel Readiness**: The backend is designed for serverless deployment on Vercel, with specific configurations for API routing and database connection pooling.
- **API Endpoints**: A comprehensive RESTful API supports all frontend functionalities, including user, project, media, task, checklist, report, invitation, analytics, and billing management.
- **Soft-Delete**: Implements soft-deletion for accounts and users, allowing for a grace period for restoration and complying with app store guidelines.

**CSRF Defense**:
Hybrid Origin-allowlist (web) + custom-header (mobile) implemented in `server/middleware/csrf.ts`, mounted in `setupAuth()` (`server/replit_integrations/auth/replitAuth.ts`) directly after `passport.session()`. Runs on every state-changing request (POST/PUT/PATCH/DELETE) before any `/api/*` route registered by `registerRoutes()`. Safe methods (GET/HEAD/OPTIONS) are skipped.
- **Web**: request must carry an `Origin` (or `Referer` fallback) whose host matches the allowlist — exact-match `app.field-view.com` / `localhost` / `127.0.0.1`, or suffix `*.vercel.app` / `*.replit.dev`. Same-origin browser POSTs from the production app pass automatically because the browser sets `Origin` to `https://app.field-view.com`.
- **Mobile**: request must include `X-FieldView-Client: mobile-1`. Browsers cannot send arbitrary `X-` headers cross-origin without CORS approval (which the server does not grant — there is no `cors()` middleware), so this header is unforgeable from a victim's browser. The mobile fetch wrapper (separate repo) adds it on every non-GET request.
- **Bypass paths** (no CSRF check at all): `/api/stripe/webhook` (Stripe-signature verified instead), `/api/login`, `/api/register`, `/api/forgot-password`, `/api/reset-password`, `/api/resend-verification`, `/api/logout` (chicken-and-egg if session is broken). Note: `/api/stripe/webhook` is mounted directly in `server/index.ts` BEFORE `setupAuth()`, so it never reaches this middleware in practice — the path bypass is defense-in-depth.
- **`CSRF_MODE` env var**: `"off"` skips the middleware entirely (incident killswitch), `"warn"` runs the check and logs `[csrf] would-block` on failure but allows the request through (rollout/observation mode), unset or `"enforce"` (default) returns `403 {error:"csrf",message:"CSRF check failed"}` on failure. Active mode is logged once at startup as `[csrf] mode=...`.
- **Prod kill-switch guardrail**: in production (`NODE_ENV=production` or `VERCEL` set), `CSRF_MODE=off` is REFUSED and silently downgraded to `enforce` unless `CSRF_OFF_ACK=1` is also set. Prevents accidental disablement via a stray env var. The startup log shows `[csrf] mode=enforce (requested=off)` plus a loud `WARNING` line when the downgrade fires.
- **CRITICAL**: if `cors()` middleware is ever added later, it MUST NOT include `X-FieldView-Client` in `Access-Control-Allow-Headers`, or the mobile defense becomes browser-forgeable and CSRF protection collapses to Origin-only.
- **Rollout dependency**: the mobile app must ship the `X-FieldView-Client` header BEFORE the server flips to `enforce` in production, otherwise existing mobile installs are bricked. Recommended sequence: ship mobile header → set prod `CSRF_MODE=warn` for a week of observation → flip to `enforce` (or unset).

## External Dependencies
- **PostgreSQL**: The primary database for all application and session data. Development environments use Neon (Replit-managed), while production uses AWS RDS.
- **Stripe**: Used for subscription billing, payment processing (Stripe Checkout), customer management (Stripe Billing Portal), and webhook handling for subscription status updates.
- **AWS S3**: Cloud storage solution for all uploaded photos and media assets.
- **Google Maps JavaScript API**: Provides map display functionality for project locations and address autocomplete via the Places API.
- **bcryptjs**: Used for secure password hashing.
- **Passport.js**: Authentication middleware for Node.js.
- **@aws-sdk/client-s3**: AWS SDK for interacting with S3 services.
- **Multer**: Node.js middleware for handling `multipart/form-data`, primarily for file uploads.
- **rate-limiter-flexible**: Manages API rate limiting, utilizing the `auth_rate_limits` table in PostgreSQL.