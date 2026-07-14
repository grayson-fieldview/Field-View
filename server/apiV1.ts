import { Router } from "express";
import { z } from "zod";
import { db } from "./db";
import { eq, and, gt, desc, isNotNull } from "drizzle-orm";
import { media, projects, reports } from "@shared/schema";
import { users } from "@shared/models/auth";
import { requireApiKey } from "./middleware/apiKeyAuth";
import { isS3Url, extractS3KeyFromUrl, getS3Url } from "./s3";

// ── /api/v1 — external (Zapier) API, authenticated via API key ──────────────
//
// Every route runs behind requireApiKey (Authorization: Bearer fv_...).
// Bearer requests bypass csrfGuard via its Authorization-header branch;
// requireApiKey never falls back to session cookies, so account scope comes
// exclusively from req.apiKeyAccount.accountId (owner-level, account-wide
// visibility per approved design).
//
// Conventions (Zapier):
//   - snake_case payload keys, mapped explicitly from the camelCase DB layer
//   - lists  → { data: [...] }, single objects → { data: {...} }
//   - errors → { error: { code, message } }  (401/429 come from the
//     middleware in its own flat shape)
//   - timestamps are strict ISO 8601 UTC with milliseconds (Date.toISOString)
//   - `since` filters created_at strictly greater-than (polling contract);
//     no cursors in v1 — since + limit covers Zapier polling.

const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || "https://app.field-view.com").replace(/\/$/, "");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** Parse ?limit= with default 50, hard cap 100. Returns null on garbage. */
function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, MAX_LIMIT);
}

// Strict ISO 8601 date-time: full date, "T", time (optional fractional
// seconds), and an explicit timezone (Z or ±HH:MM). Rejects the loose
// formats Date.parse would otherwise accept ("2026-07-14", "Jul 14 2026",
// etc.) so the Zapier polling contract stays deterministic. Zapier replays
// our own created_at values (toISOString → UTC with milliseconds), which
// always match.
const ISO_8601_STRICT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Parse ?since= as strict ISO 8601. Returns undefined if absent, null on garbage. */
function parseSince(raw: unknown): Date | null | undefined {
  if (raw === undefined) return undefined;
  const s = String(raw);
  if (!ISO_8601_STRICT.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Normalize a stored media URL to the permanent CloudFront form. */
function permanentUrl(url: string): string {
  if (isS3Url(url)) {
    const key = extractS3KeyFromUrl(url);
    if (key) return getS3Url(key);
  }
  return url;
}

function projectPayload(p: typeof projects.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    address: p.address,
    latitude: p.latitude,
    longitude: p.longitude,
    tags: p.tags ?? [],
    created_at: iso(p.createdAt),
    updated_at: iso(p.updatedAt),
  };
}

export const apiV1Router = Router();
apiV1Router.use(requireApiKey);

// ── 1. GET /api/v1/photos ────────────────────────────────────────────────────
apiV1Router.get("/photos", async (req, res) => {
  try {
    const accountId = req.apiKeyAccount!.accountId;

    const limit = parseLimit(req.query.limit);
    if (limit === null) {
      return res.status(400).json(errorBody("invalid_limit", "limit must be a positive integer"));
    }
    const since = parseSince(req.query.since);
    if (since === null) {
      return res.status(400).json(errorBody("invalid_since", "since must be an ISO 8601 timestamp"));
    }

    // Optional project scope — 404 when the project doesn't belong to this account.
    let projectId: number | undefined;
    if (req.query.project_id !== undefined) {
      projectId = Number(req.query.project_id);
      if (!Number.isInteger(projectId)) {
        return res.status(400).json(errorBody("invalid_project_id", "project_id must be an integer"));
      }
      const [proj] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.accountId, accountId)));
      if (!proj) {
        return res.status(404).json(errorBody("not_found", "Project not found"));
      }
    }

    const conditions = [eq(projects.accountId, accountId)];
    if (projectId !== undefined) conditions.push(eq(media.projectId, projectId));
    if (since) conditions.push(gt(media.createdAt, since));

    const rows = await db
      .select({
        id: media.id,
        projectId: media.projectId,
        url: media.url,
        caption: media.caption,
        tags: media.tags,
        latitude: media.latitude,
        longitude: media.longitude,
        createdAt: media.createdAt,
        uploaderId: users.id,
        uploaderFirstName: users.firstName,
        uploaderLastName: users.lastName,
      })
      .from(media)
      .innerJoin(projects, eq(media.projectId, projects.id))
      .leftJoin(users, eq(media.uploadedById, users.id))
      .where(and(...conditions))
      .orderBy(desc(media.createdAt))
      .limit(limit);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        project_id: r.projectId,
        url: permanentUrl(r.url),
        caption: r.caption,
        tags: r.tags ?? [],
        latitude: r.latitude,
        longitude: r.longitude,
        created_at: iso(r.createdAt),
        uploaded_by: r.uploaderId
          ? {
              id: r.uploaderId,
              name: [r.uploaderFirstName, r.uploaderLastName].filter(Boolean).join(" ") || null,
            }
          : null,
      })),
    });
  } catch (err) {
    console.error("[api/v1] GET /photos error:", err);
    res.status(500).json(errorBody("server_error", "Failed to list photos"));
  }
});

// ── 2. GET /api/v1/projects ──────────────────────────────────────────────────
const PROJECT_STATUSES = ["active", "completed", "on_hold", "archived"] as const;
type ProjectStatus = (typeof PROJECT_STATUSES)[number];

apiV1Router.get("/projects", async (req, res) => {
  try {
    const accountId = req.apiKeyAccount!.accountId;

    const limit = parseLimit(req.query.limit);
    if (limit === null) {
      return res.status(400).json(errorBody("invalid_limit", "limit must be a positive integer"));
    }
    const since = parseSince(req.query.since);
    if (since === null) {
      return res.status(400).json(errorBody("invalid_since", "since must be an ISO 8601 timestamp"));
    }
    let status: ProjectStatus | undefined;
    if (req.query.status !== undefined) {
      const s = String(req.query.status);
      if (!(PROJECT_STATUSES as readonly string[]).includes(s)) {
        return res
          .status(400)
          .json(errorBody("invalid_status", `status must be one of: ${PROJECT_STATUSES.join(", ")}`));
      }
      status = s as ProjectStatus;
    }

    const conditions = [eq(projects.accountId, accountId)];
    if (since) conditions.push(gt(projects.createdAt, since));
    if (status) conditions.push(eq(projects.status, status));

    const rows = await db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt))
      .limit(limit);

    res.json({ data: rows.map(projectPayload) });
  } catch (err) {
    console.error("[api/v1] GET /projects error:", err);
    res.status(500).json(errorBody("server_error", "Failed to list projects"));
  }
});

// ── 3. POST /api/v1/projects ─────────────────────────────────────────────────
// Validates with the insertProjectSchema pattern restricted to the externally
// writable fields; accountId comes from the key, createdById = accounts.ownerId
// (approved decision — key-created projects are attributed to the owner).
// NOTE: insertProjectSchema.pick(...) trips the same drizzle-zod
// "boolean is not assignable to never" TS drift that already affects
// shared/schema.ts, so the externally-writable subset is declared explicitly
// (same field types as insertProjectSchema) instead of picked.
const createProjectSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(200),
    description: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

apiV1Router.post("/projects", async (req, res) => {
  try {
    const { accountId, ownerId } = req.apiKeyAccount!;

    const parsed = createProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".") || "_";
        if (!fields[key]) fields[key] = issue.message;
      }
      return res.status(422).json({
        error: { code: "validation_failed", message: "Invalid project payload", fields },
      });
    }

    const [created] = await db
      .insert(projects)
      .values({
        ...parsed.data,
        accountId,
        createdById: ownerId,
      })
      .returning();

    res.status(201).json({ data: projectPayload(created) });
  } catch (err) {
    console.error("[api/v1] POST /projects error:", err);
    res.status(500).json(errorBody("server_error", "Failed to create project"));
  }
});

// ── 4. GET /api/v1/reports ───────────────────────────────────────────────────
// Only reports with an active share token are returned — share_url IS the
// payload's reason to exist ("Report Shared" trigger). Share tokens are stored
// on reports.share_token (crypto.randomBytes(16).toString("base64url"), set by
// POST /api/reports/:id/share, nulled on revoke); the public viewer route is
// /report/:token, so share_url = `${PUBLIC_APP_URL}/report/${share_token}`.
apiV1Router.get("/reports", async (req, res) => {
  try {
    const accountId = req.apiKeyAccount!.accountId;

    const limit = parseLimit(req.query.limit);
    if (limit === null) {
      return res.status(400).json(errorBody("invalid_limit", "limit must be a positive integer"));
    }
    const since = parseSince(req.query.since);
    if (since === null) {
      return res.status(400).json(errorBody("invalid_since", "since must be an ISO 8601 timestamp"));
    }

    const conditions = [eq(reports.accountId, accountId), isNotNull(reports.shareToken)];
    if (since) conditions.push(gt(reports.createdAt, since));

    const rows = await db
      .select({
        id: reports.id,
        projectId: reports.projectId,
        title: reports.title,
        shareToken: reports.shareToken,
        createdAt: reports.createdAt,
      })
      .from(reports)
      .where(and(...conditions))
      .orderBy(desc(reports.createdAt))
      .limit(limit);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        project_id: r.projectId,
        title: r.title,
        share_url: `${PUBLIC_APP_URL}/report/${r.shareToken}`,
        created_at: iso(r.createdAt),
      })),
    });
  } catch (err) {
    console.error("[api/v1] GET /reports error:", err);
    res.status(500).json(errorBody("server_error", "Failed to list reports"));
  }
});
