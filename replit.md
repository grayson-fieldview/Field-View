# SiteSnap - Jobsite Photo Documentation & Project Management

## Overview
SiteSnap is a photo documentation and project management tool designed for field service teams (construction crews, inspectors, maintenance workers). It allows users to capture, organize, and share photos from job sites, track project progress, collaborate with team members, and manage tasks.

## Brand & Design
- **Name**: SiteSnap
- **Icon**: Aperture (lucide-react)
- **Color Scheme**: Warm amber/orange primary (#E97316), dark slate sidebar, warm off-white backgrounds
- **Fonts**: Inter (sans), DM Serif Display (serif headings)
- **Design Style**: Clean, warm, modern - distinct from competitor products

## Tech Stack
- **Frontend**: React 18 with TypeScript, Tailwind CSS, shadcn/ui components
- **Backend**: Node.js with Express, PostgreSQL with Drizzle ORM
- **Auth**: Replit Auth (OpenID Connect)
- **Map**: Leaflet with react-leaflet
- **File Upload**: Multer (stored in /uploads directory)
- **Routing**: wouter (frontend), Express (backend)
- **State Management**: TanStack React Query v5

## Architecture
- `client/src/` - Frontend React application
  - `pages/` - Page components (landing, projects, project-detail, photos, map, team, settings, checklists, reports, gallery)
  - `components/` - Shared components (app-sidebar, theme-provider, theme-toggle, photo-viewer, address-autocomplete, ui/)
  - `hooks/` - Custom hooks (use-auth, use-toast, use-mobile)
  - `lib/` - Utilities (queryClient, auth-utils, utils)
- `server/` - Express backend
  - `routes.ts` - API endpoints
  - `storage.ts` - Database operations (DatabaseStorage class)
  - `seed.ts` - Seed data for demo purposes
  - `db.ts` - Database connection
  - `replit_integrations/auth/` - Replit Auth integration
- `shared/` - Shared types and schemas
  - `schema.ts` - Drizzle ORM schema definitions (projects, media, comments, tasks, checklists, reports, galleries)
  - `models/auth.ts` - Auth-related schemas (users, sessions)

## Data Models
- **Users** - Managed by Replit Auth (id, email, firstName, lastName, profileImageUrl)
- **Projects** - Job sites (name, description, status, address, lat/lng, color)
- **Media** - Photos/videos (projectId, url, caption, tags, GPS coords)
- **Comments** - On media items (mediaId, userId, content)
- **Tasks** - Project tasks (projectId, title, status, priority, assignedTo)
- **Checklists** - Project checklists with items (projectId, title, status, items)
- **Reports** - Project reports (projectId, title, type, status, content)
- **Galleries** - Shareable photo collections (projectId, token, mediaIds, options)

## Key API Endpoints
- `GET/POST /api/projects` - List/create projects
- `GET /api/projects/:id` - Get project with media, tasks, checklists, reports
- `GET /api/config/maps` - Returns Google Maps API key for Places autocomplete
- `POST /api/projects/:id/media` - Upload photos (multipart/form-data)
- `POST /api/projects/:id/tasks` - Create task
- `PATCH /api/tasks/:id` - Update task status
- `GET /api/media` - All media across projects
- `GET/POST /api/media/:id/comments` - Comments on media
- `GET /api/users` - List team members
- `POST /api/galleries` - Create shareable gallery
- `GET /api/galleries/:token` - Get public gallery by token
- Auth: `/api/login`, `/api/logout`, `/api/auth/user`

## Key Features
- Photo annotations: 5 drawing tools (freehand, arrow, circle, rectangle, line), 8 colors, adjustable stroke width
- Checklist templates: Create reusable templates, apply to projects
- Report templates: Create reusable report templates
- Gallery sharing: Generate shareable photo gallery links with configurable metadata
- Address autocomplete: Google Places API integration (Enter key blocked to prevent accidental form submission)

## Google Maps Integration
- Address autocomplete uses Google Places API via `AddressAutocomplete` component
- Google Maps JS script is loaded dynamically from the `GOOGLE_MAPS_API_KEY` secret
- When an address is selected, latitude/longitude are auto-populated behind the scenes
- Project creation form shows only Name, Description, and Address fields

## Pages
1. **Landing** - Marketing page for unauthenticated users
2. **Projects Dashboard** - List, search, filter projects with stats
3. **Project Detail** - Photos tab + Tasks tab + Checklists + Reports with upload and management
4. **Photos** - Global gallery with search and project filtering
5. **Map** - Leaflet map with project location markers
6. **Team** - Team member directory
7. **Settings** - Profile, appearance (dark mode), notifications
8. **Checklists** - Global checklist management with templates
9. **Reports** - Global report management with templates
10. **Gallery** - Public shareable photo gallery (no auth required)

## User Preferences
- Dark mode toggle saved to localStorage
- Sidebar navigation with collapsible functionality

## Running
- `npm run dev` - Start development server (port 5000)
- `npm run db:push` - Push schema changes to database
