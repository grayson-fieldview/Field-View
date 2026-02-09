# Field View - Photo Documentation & Project Management

## Overview
Field View is a photo documentation and project management tool designed for field service teams (construction crews, inspectors, maintenance workers). It allows users to capture, organize, and share photos from job sites, track project progress, collaborate with team members, and manage tasks.

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
  - `pages/` - Page components (landing, projects, project-detail, photos, map, team, settings)
  - `components/` - Shared components (app-sidebar, theme-provider, theme-toggle, ui/)
  - `hooks/` - Custom hooks (use-auth, use-toast, use-mobile)
  - `lib/` - Utilities (queryClient, auth-utils, utils)
- `server/` - Express backend
  - `routes.ts` - API endpoints
  - `storage.ts` - Database operations (DatabaseStorage class)
  - `seed.ts` - Seed data for demo purposes
  - `db.ts` - Database connection
  - `replit_integrations/auth/` - Replit Auth integration
- `shared/` - Shared types and schemas
  - `schema.ts` - Drizzle ORM schema definitions (projects, media, comments, tasks)
  - `models/auth.ts` - Auth-related schemas (users, sessions)

## Data Models
- **Users** - Managed by Replit Auth (id, email, firstName, lastName, profileImageUrl)
- **Projects** - Job sites (name, description, status, address, lat/lng, color)
- **Media** - Photos/videos (projectId, url, caption, tags, GPS coords)
- **Comments** - On media items (mediaId, userId, content)
- **Tasks** - Project tasks (projectId, title, status, priority, assignedTo)

## Key API Endpoints
- `GET/POST /api/projects` - List/create projects
- `GET /api/projects/:id` - Get project with media and tasks
- `POST /api/projects/:id/media` - Upload photos (multipart/form-data)
- `POST /api/projects/:id/tasks` - Create task
- `PATCH /api/tasks/:id` - Update task status
- `GET /api/media` - All media across projects
- `GET/POST /api/media/:id/comments` - Comments on media
- `GET /api/users` - List team members
- Auth: `/api/login`, `/api/logout`, `/api/auth/user`

## Pages
1. **Landing** - Marketing page for unauthenticated users
2. **Projects Dashboard** - List, search, filter projects with stats
3. **Project Detail** - Photos tab + Tasks tab with upload and management
4. **Photos** - Global gallery with search and project filtering
5. **Map** - Leaflet map with project location markers
6. **Team** - Team member directory
7. **Settings** - Profile, appearance (dark mode), notifications

## User Preferences
- Dark mode toggle saved to localStorage
- Sidebar navigation with collapsible functionality

## Running
- `npm run dev` - Start development server (port 5000)
- `npm run db:push` - Push schema changes to database
