# Field View - Jobsite Photo Documentation & Project Management

## Overview
Field View is a photo documentation and project management tool designed for field service teams (construction crews, inspectors, maintenance workers). It allows users to capture, organize, and share photos from job sites, track project progress, collaborate with team members, and manage tasks.

## Brand & Design
- **Name**: Field View
- **Logo**: Favicon icon (attached_assets/Favicon-01_1772067008525.png) + "Field View" text used in sidebar, landing nav, and footer; Full logo (attached_assets/Transparent-01_1772067005406.png) available for light backgrounds; Favicon also serves as browser tab icon (client/public/favicon.png)
- **Positioning**: "Field Intelligence Platform" - differentiating from pure photo documentation competitors
- **Color Scheme**: Orange primary (#F09000), green accents (#267D32), charcoal sidebar (#1E1E1E), warm cream backgrounds (#F0EDEA)
- **Design Inspiration**: Procore-style clean, professional construction management aesthetic
- **Fonts**: Inter (sans), DM Serif Display (serif headings)
- **Design Style**: Clean, professional, enterprise-grade construction industry look

## Tech Stack
- **Frontend**: React 18 with TypeScript, Tailwind CSS, shadcn/ui components
- **Backend**: Node.js with Express, PostgreSQL with Drizzle ORM
- **Auth**: Custom email/password authentication (Passport.js local strategy, bcryptjs, session-based with connect-pg-simple)
- **Payments**: Stripe integration via stripe-replit-sync (subscription billing)
- **Map**: Leaflet with react-leaflet
- **File Upload**: Multer + AWS S3 (@aws-sdk/client-s3, bucket: fieldview-storage, region: us-east-2)
- **Routing**: wouter (frontend), Express (backend)
- **State Management**: TanStack React Query v5

## Architecture
- `client/src/` - Frontend React application
  - `pages/` - Page components (landing, login, register, forgot-password, subscribe, dashboard, projects, project-detail, tasks, photos, map, team, settings, checklists, reports, analytics, gallery)
  - `components/` - Shared components (app-sidebar, theme-provider, theme-toggle, photo-viewer, address-autocomplete, ui/)
  - `hooks/` - Custom hooks (use-auth, use-toast, use-mobile)
  - `lib/` - Utilities (queryClient, auth-utils, utils)
- `server/` - Express backend
  - `routes.ts` - API endpoints
  - `storage.ts` - Database operations (DatabaseStorage class)
  - `seed.ts` - Seed data for demo purposes
  - `db.ts` - Database connection
  - `stripeClient.ts` - Stripe client (credentials from Replit connector API)
  - `webhookHandlers.ts` - Stripe webhook processing via stripe-replit-sync
  - `seed-stripe-products.ts` - Script to create Stripe products/prices
  - `replit_integrations/auth/` - Custom auth (Passport local strategy, session-based)
- `shared/` - Shared types and schemas
  - `schema.ts` - Drizzle ORM schema definitions (projects, media, comments, tasks, checklists, reports, galleries)
  - `models/auth.ts` - Auth-related schemas (users with password/subscription fields, sessions, passwordResetTokens)

## Multi-Tenancy (Account Isolation)
- **Accounts table**: `accounts` (id UUID, name, createdAt) — each organization is an account
- **Users**: `accountId` field links each user to their account
- **Projects**: `accountId` field links each project to its account
- **Templates**: `checklistTemplates` and `reportTemplates` have `accountId`
- **Child data** (media, tasks, checklists, reports, comments): Isolated via project joins — no direct accountId, filtered through `projects.accountId`
- **Registration**: Every new user auto-creates an account and is set as `role: "admin"` of that account
- **Storage layer**: All collection-fetching methods accept `accountId` and filter accordingly
- **Routes**: All API endpoints extract `req.user.accountId` and verify ownership; helper functions (`verifyProjectAccess`, `verifyMediaAccess`, `verifyChecklistAccess`, `verifyTaskAccess`, `verifyReportAccess`) prevent cross-account access on all mutation/by-ID routes
- **Access control**: Users can only see/modify data belonging to their account; admin role changes and subscription updates are account-scoped

## Authentication
- Custom email/password auth using Passport.js local strategy
- Passwords hashed with bcryptjs (12 rounds)
- Sessions stored in PostgreSQL via connect-pg-simple
- User schema includes: id (UUID), email, password (hashed), firstName, lastName, profileImageUrl, accountId, stripeCustomerId, stripeSubscriptionId, subscriptionStatus, trialEndsAt
- New users register with subscriptionStatus: "none" — must enter credit card via Stripe Checkout to start 14-day free trial
- Stripe manages the trial period (subscriptionStatus: "trialing" after checkout)
- Password reset: POST /api/forgot-password generates token (logged to console in dev), POST /api/reset-password validates token and updates password
- Password reset tokens stored in password_reset_tokens table (token, userId, expiresAt, usedAt)
- Auth routes: POST /api/register, POST /api/login, POST /api/logout, GET /api/auth/user, POST /api/forgot-password, POST /api/reset-password

## Stripe Integration
- Connected via Replit Stripe integration (connection:conn_stripe_01KJBS6YDZQ52E57MVSQTHTKE5)
- stripe-replit-sync manages stripe schema tables automatically (DO NOT insert directly)
- Webhook route at /api/stripe/webhook registered BEFORE express.json() middleware
- Products created via Stripe API (seed-stripe-products.ts), synced automatically
- Pricing: Monthly $79/mo base (3 users) + $29/extra user; Annual $49/mo base + $24/extra user
- Stripe product: "Field View Pro" with monthly and annual prices
- Checkout flow: POST /api/create-checkout-session with priceId → Stripe Checkout (payment_method_collection: "always", trial_period_days: 14 for new users) → webhook updates user
- POST /api/confirm-checkout - Syncs subscription status from Stripe after checkout redirect
- Billing portal: POST /api/create-portal-session → Stripe Billing Portal
- Webhook handler in index.ts processes checkout.session.completed, customer.subscription.updated, customer.subscription.deleted events to update user subscriptionStatus
- Subscription statuses: "none" (no subscription), "trialing" (Stripe trial with card), "active", "past_due", "canceled"

## Data Models
- **Users** - Custom auth (id UUID, email, password hashed, firstName, lastName, profileImageUrl, role [admin/manager/standard/restricted], stripeCustomerId, stripeSubscriptionId, subscriptionStatus, trialEndsAt)
- **Projects** - Job sites (name, description, status, address, lat/lng, color, coverPhotoId)
- **Media** - Photos/videos (projectId, url, caption, tags, GPS coords)
- **Comments** - On media items (mediaId, userId, content)
- **Tasks** - Project tasks (projectId, title, status, priority, assignedTo)
- **Checklists** - Project checklists with items (projectId, title, status, items)
- **Reports** - Project reports (projectId, title, type, status, content)
- **Galleries** - Shareable photo collections (projectId, token, mediaIds, options)

## Key API Endpoints
- `POST /api/register` - Register new user (email, password, firstName, lastName)
- `POST /api/login` - Login (email, password)
- `POST /api/logout` - Logout
- `GET /api/auth/user` - Get current authenticated user (excludes password)
- `POST /api/forgot-password` - Request password reset
- `GET/POST /api/projects` - List/create projects
- `GET /api/projects/:id` - Get project with media, tasks, checklists, reports
- `GET /api/config/maps` - Returns Google Maps API key for Places autocomplete
- `POST /api/projects/:id/media` - Upload photos (multipart/form-data)
- `POST /api/projects/:id/tasks` - Create task
- `PATCH /api/tasks/:id` - Update task status
- `GET /api/media` - All media across projects
- `GET/POST /api/media/:id/comments` - Comments on media
- `GET /api/users` - List team members
- `PATCH /api/users/:userId/role` - Update user role (admin only)
- `POST /api/galleries` - Create shareable gallery
- `GET /api/galleries/:token` - Get public gallery by token
- `GET /api/analytics?from=&to=` - Aggregated analytics
- `GET /api/activity?limit=` - Activity feed
- `GET /api/projects/:id/daily-log?date=` - Daily log for a project
- `POST /api/create-checkout-session` - Create Stripe checkout session
- `POST /api/create-portal-session` - Create Stripe billing portal session
- `GET /api/subscription` - Get current subscription status
- `GET /api/stripe/prices` - Get available prices from stripe schema
- `GET /api/stripe/publishable-key` - Get Stripe publishable key

## AWS S3 Photo Storage
- Photos uploaded to AWS S3 bucket `fieldview-storage` in `us-east-2`
- S3 service in `server/s3.ts` (uploadToS3, deleteFromS3, extractS3KeyFromUrl)
- Photo URLs: `https://fieldview-storage.s3.us-east-2.amazonaws.com/photos/...`
- Multer uses memory storage (buffers) → uploaded to S3 via @aws-sdk/client-s3
- Old locally-stored photos (`/uploads/...`) still served via express.static for backward compatibility
- Required env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET, AWS_REGION

## Key Features
- Photo annotations: 5 drawing tools (freehand, arrow, circle, rectangle, line), 8 colors (#F09000 orange standardized), adjustable stroke width
- Batch photo upload: Stage multiple photos with preview thumbnails before uploading; camera capture support on mobile
- Project cover photo: Shows in project detail header (uses coverPhotoId or first media as fallback)
- User roles: Admin, Manager, Standard, Restricted — admin can change roles from Team page
- Checklist templates: Create reusable templates, apply to projects
- Report templates: Create reusable report templates
- Gallery sharing: Generate shareable photo gallery links with configurable metadata
- Address autocomplete: Google Places API integration (Enter key blocked, dialog interaction/pointer/focus events handled for modal compatibility)
- Analytics dashboard: 7 stat cards, bar chart (photos by user), line chart (photos over time), map (photo locations), bar chart (photos by project), pie chart (task status), time period filtering
- Command Center Dashboard: KPI strip, overdue task alert banner, activity feed, mini-map, recent photos, quick actions, project list with search/filter
- Before/After Photo Comparison: Drag slider to compare two project photos side-by-side
- Daily Log: Auto-generated daily activity summary per project
- Subscription gate: Users without active subscription or valid trial are shown subscribe page

## Google Maps Integration
- Address autocomplete uses Google Places API via `AddressAutocomplete` component
- Google Maps JS script is loaded dynamically from the `GOOGLE_MAPS_API_KEY` secret
- When an address is selected, latitude/longitude are auto-populated behind the scenes
- Project creation form shows only Name, Description, and Address fields

## Pages
1. **Landing** - Procore-inspired marketing page with warm cream hero, charcoal CTA section, pricing calculator, FAQ section
2. **Login** - Email/password login form with forgot password link
3. **Register** - Registration form with trial features list
4. **Forgot Password** - Email input for password reset
5. **Subscribe** - Subscription page with plan details, team size calculator, Stripe checkout
6. **Dashboard (Home)** - Command center with KPI strip, activity feed, recent photos, quick actions, project list
7. **Project Detail** - Hero banner header (cover photo or gradient), inline info card with status/stats, pill-style tabs for Photos (with before/after compare) + Tasks + Checklists + Reports + Daily Log
8. **Photos** - Global gallery with search and project filtering
9. **Map** - Leaflet map with project location markers
10. **Team** - Team member directory with role badges and admin role management
11. **Settings** - Profile, appearance (dark mode), billing/subscription management, notifications
12. **Checklists** - Global checklist management with templates
13. **Reports** - Global report management with templates
14. **Gallery** - Public shareable photo gallery (no auth required)
15. **Analytics** - Dashboard with stat cards, charts, map, time period filtering

## User Preferences
- Dark mode toggle saved to localStorage
- Sidebar navigation with collapsible functionality

## Running
- `npm run dev` - Start development server (port 5000)
- `npm run db:push` - Push schema changes to database
- `npx tsx server/seed-stripe-products.ts` - Create Stripe products/prices
