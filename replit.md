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
    - **Photo Features**: Annotations (5 tools, 8 colors), batch upload with preview, mobile camera capture support.
    - **Project Management**: Project creation/management with status, address, color, cover photo. Task management, Checklist management with templates, Report generation with templates.
    - **Collaboration**: User roles (Admin, Manager, Standard, Restricted), user invitations, project assignments.
    - **Analytics**: Dashboard with KPI strip, various charts (photos by user, over time, by project, task status), mini-map, activity feed, time period filtering.
    - **Unique Features**: Before/After Photo Comparison slider, Daily Log auto-generation, shareable photo galleries.

**Backend:**
- Developed with Node.js and Express.
- Uses PostgreSQL with Drizzle ORM for data persistence.
- **Multi-Tenancy**: Account-based isolation where each organization is an `account`. Users, projects, templates, and all child data are linked to an `accountId`. All API endpoints enforce `accountId` verification to prevent cross-account access.
- **Authentication**: Custom email/password authentication using Passport.js local strategy with bcryptjs for password hashing. Sessions are stored in PostgreSQL using `connect-pg-simple`. User profiles include subscription status and Stripe customer IDs.
- **File Storage**: Photos are uploaded to AWS S3 (`fieldview-storage` bucket in `us-east-2`) using Multer and `@aws-sdk/client-s3`.
- **API Endpoints**: Comprehensive RESTful API for all frontend functionalities including user management, project operations, media handling, task/checklist/report management, invitations, analytics, and billing.

## External Dependencies
- **PostgreSQL**: Primary database for all application data, including user sessions.
- **Stripe**: For subscription billing, managed via `stripe-replit-sync`. Integrates with Stripe Checkout for payment collection and Stripe Billing Portal for customer management. Webhooks handle subscription status updates.
- **AWS S3**: Cloud storage for all uploaded photos and media assets.
- **Google Maps JavaScript API**: Used for displaying project locations on a map and providing address autocomplete functionality via the Places API.
- **bcryptjs**: Library for hashing user passwords securely.
- **Passport.js**: Authentication middleware for Node.js, used for local email/password strategy.
- **@aws-sdk/client-s3**: AWS SDK for JavaScript to interact with S3.
- **Multer**: Middleware for handling `multipart/form-data`, primarily for file uploads.