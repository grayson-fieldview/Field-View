import express, { type Express } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes, isAuthenticated, requireReadAccess, requireWriteAccess } from "./replit_integrations/auth";
import { getAccountBilling, isAccountBillingEnabled, overlayAccountBillingOnUser, isSeatAddonItem } from "./lib/billing";
import { requireAdmin, requireAdminOrManager } from "./middleware/auth";
import { authStorage } from "./replit_integrations/auth/storage";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { insertProjectSchema, insertCommentSchema, insertTaskSchema, insertChecklistSchema, insertChecklistItemSchema, insertReportSchema, insertChecklistTemplateSchema, insertChecklistTemplateItemSchema, insertReportTemplateSchema, insertCalendarEventSchema, annotationStrokesSchema, projects, media, comments, tasks, checklists, reports, projectAssignments, timeEntries } from "@shared/schema";
import { users, invitations, accounts } from "@shared/models/auth";
import { db } from "./db";
import { eq, sql, and, or, inArray, count, isNull, desc } from "drizzle-orm";
import { sanitizeUserForViewer, sanitizeTimeEntryForViewer, isManagerRole } from "./lib/userVisibility";
import { z } from "zod";
import { getPresignedUrl, isS3Url, extractS3KeyFromUrl, getPresignedPutUrl, deleteFromS3 } from "./s3";
import { sendInvitationEmail, sendAccountDeletionEmail } from "./services/email";
import { toCsv } from "./lib/csv";
import bcrypt from "bcryptjs";
import { Sentry } from "./lib/sentry";

async function verifyProjectAccess(projectId: number, accountId: string): Promise<boolean> {
  const project = await storage.getProject(projectId);
  return !!project && project.accountId === accountId;
}

async function verifyMediaAccess(mediaId: number, accountId: string): Promise<boolean> {
  const item = await db.select({ accountId: projects.accountId })
    .from(media)
    .innerJoin(projects, eq(media.projectId, projects.id))
    .where(eq(media.id, mediaId))
    .limit(1);
  return item.length > 0 && item[0].accountId === accountId;
}

async function verifyChecklistAccess(checklistId: number, accountId: string): Promise<boolean> {
  const result = await db.select({ accountId: projects.accountId })
    .from(checklists)
    .innerJoin(projects, eq(checklists.projectId, projects.id))
    .where(eq(checklists.id, checklistId))
    .limit(1);
  return result.length > 0 && result[0].accountId === accountId;
}

async function verifyTaskAccess(taskId: number, accountId: string): Promise<boolean> {
  const result = await db.select({ accountId: projects.accountId })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, taskId))
    .limit(1);
  return result.length > 0 && result[0].accountId === accountId;
}

async function verifyReportAccess(reportId: number, accountId: string): Promise<boolean> {
  const result = await db.select({ accountId: projects.accountId })
    .from(reports)
    .innerJoin(projects, eq(reports.projectId, projects.id))
    .where(eq(reports.id, reportId))
    .limit(1);
  return result.length > 0 && result[0].accountId === accountId;
}

async function verifyTimeEntryAccess(timeEntryId: string, accountId: string): Promise<boolean> {
  const [row] = await db.select({ accountId: timeEntries.accountId })
    .from(timeEntries)
    .where(eq(timeEntries.id, timeEntryId))
    .limit(1);
  return !!row && row.accountId === accountId;
}

async function getRestrictedAssignedProjectIds(userId: string): Promise<Set<number>> {
  const rows = await db.select({ projectId: projectAssignments.projectId })
    .from(projectAssignments)
    .where(eq(projectAssignments.userId, userId));
  return new Set(rows.map(r => r.projectId));
}

async function presignMediaUrls<T extends { url: string }>(items: T[]): Promise<T[]> {
  return Promise.all(items.map(async (item) => {
    if (isS3Url(item.url)) {
      const key = extractS3KeyFromUrl(item.url);
      if (key) {
        return { ...item, url: await getPresignedUrl(key) };
      }
    }
    return item;
  }));
}

const ALLOWED_UPLOAD_EXT = /\.(jpe?g|png|gif|webp|mp4|mov|avi|heic)$/i;
function isAllowedUpload(originalName: string, mimeType: string): boolean {
  if (ALLOWED_UPLOAD_EXT.test(originalName)) return true;
  return mimeType.startsWith("image/") || mimeType.startsWith("video/");
}

const MAX_IMAGE_SIZE = 50 * 1024 * 1024;  // 50 MB — covers 4K iPhone photos with headroom
const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500 MB — covers ~30s of 4K video, ~2 min of 1080p

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);

  app.get("/api/config/maps", requireReadAccess, (_req, res) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ message: "Google Maps API key not configured" });
    }
    res.json({ apiKey });
  });

  app.get("/api/projects", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      let allProjects = await storage.getProjectsWithDetails(accountId);
      if (req.user.role === "restricted") {
        const assignedIds = await db.select({ projectId: projectAssignments.projectId })
          .from(projectAssignments).where(eq(projectAssignments.userId, req.user.id));
        const assignedSet = new Set(assignedIds.map(a => a.projectId));
        allProjects = allProjects.filter(p => p.createdById === req.user.id || assignedSet.has(p.id));
      }
      const presignedProjects = await Promise.all(allProjects.map(async (p) => ({
        ...p,
        recentPhotos: await presignMediaUrls(p.recentPhotos),
      })));
      res.json(presignedProjects);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch projects" });
    }
  });

  // Geocoded, active projects with activity in the last 14 days. Powers the
  // mobile geofence sync — only nearby live jobs are worth registering with iOS.
  // MUST be registered BEFORE /api/projects/:id or the :id route captures
  // "geofence-eligible" as a project ID.
  app.get("/api/projects/geofence-eligible", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const userId = req.user.id;
      const isRestricted = req.user.role === "restricted";

      // Restricted users see only assigned projects + their own — match the
      // semantics of GET /api/projects exactly. Use the shared helper, not
      // an inlined query, so the two endpoints stay observably identical.
      let restrictedClause = sql`TRUE`;
      if (isRestricted) {
        const assignedSet = await getRestrictedAssignedProjectIds(userId);
        const assignedIds = Array.from(assignedSet);
        if (assignedIds.length === 0) {
          restrictedClause = sql`projects.created_by_id = ${userId}`;
        } else {
          restrictedClause = sql`(projects.created_by_id = ${userId} OR projects.id IN (${sql.join(assignedIds.map(id => sql`${id}`), sql`, `)}))`;
        }
      }

      const result = await db.execute(sql`
        SELECT
          projects.id,
          projects.name,
          projects.latitude,
          projects.longitude,
          act.last_activity_at
        FROM projects
        LEFT JOIN LATERAL (
          SELECT MAX(time_entries.clock_in) AS last_clock_in
          FROM time_entries
          WHERE time_entries.project_id = projects.id
            AND time_entries.account_id = ${accountId}
        ) te ON TRUE
        LEFT JOIN LATERAL (
          -- INNER JOIN projects to re-assert account boundary; media has no
          -- direct accountId column, so this enforces tenant scoping at the
          -- subquery level even if the outer WHERE is refactored.
          SELECT MAX(media.created_at) AS last_photo_at
          FROM media
          INNER JOIN projects p ON p.id = media.project_id AND p.account_id = ${accountId}
          WHERE media.project_id = projects.id
            AND media.mime_type LIKE 'image/%'
        ) ph ON TRUE
        LEFT JOIN LATERAL (
          -- Single source of truth for the activity timestamp; referenced by
          -- both the SELECT and the 14-day WHERE filter to avoid drift.
          SELECT GREATEST(
            projects.updated_at::timestamptz,
            COALESCE(te.last_clock_in, 'epoch'::timestamptz),
            COALESCE(ph.last_photo_at::timestamptz, 'epoch'::timestamptz)
          ) AS last_activity_at
        ) act ON TRUE
        WHERE projects.account_id = ${accountId}
          AND projects.status = 'active'
          AND projects.latitude IS NOT NULL
          AND projects.longitude IS NOT NULL
          AND ${restrictedClause}
          AND act.last_activity_at >= NOW() - INTERVAL '14 days'
        ORDER BY act.last_activity_at DESC
        LIMIT 20
      `);

      const rows = (result.rows as any[]).map(r => {
        const lat = Number(r.latitude);
        const lng = Number(r.longitude);
        // Belt-and-suspenders: the WHERE clause filters NOT NULL coords, but
        // the pg driver can return numerics as strings under some configs and
        // Number(null) silently returns 0 — failing loud here beats serving
        // a phantom geofence at (0, 0) off the coast of West Africa.
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          console.warn("[geofence-eligible] dropping row with invalid coords:", r.id);
          return null;
        }
        return {
          id: Number(r.id),
          name: String(r.name),
          latitude: lat,
          longitude: lng,
          lastActivityAt: new Date(r.last_activity_at).toISOString(),
        };
      }).filter(Boolean);
      res.json(rows);
    } catch (error) {
      console.error("geofence-eligible error:", error);
      res.status(500).json({ message: "Failed to fetch geofence-eligible projects" });
    }
  });

  app.get("/api/projects/:id", requireReadAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      if (req.user.role === "restricted") {
        const [assignment] = await db.select().from(projectAssignments)
          .where(and(eq(projectAssignments.projectId, id), eq(projectAssignments.userId, req.user.id)));
        if (!assignment && project.createdById !== req.user.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const mediaItems = await presignMediaUrls(await storage.getMediaByProject(id));
      const taskItems = await storage.getTasksByProject(id);
      const checklistItems = await storage.getChecklistsByProject(id);
      const reportItems = await storage.getReportsByProject(id);

      res.json({ project, media: mediaItems, tasks: taskItems, checklists: checklistItems, reports: reportItems });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch project" });
    }
  });

  app.post("/api/projects", requireWriteAccess, async (req: any, res) => {
    try {
      console.log("[API] POST /api/projects body", req.body);
      const parsed = insertProjectSchema.safeParse({
        ...req.body,
        accountId: req.user.accountId,
        createdById: req.user.id,
      });
      if (!parsed.success) {
        console.log("[API] POST /api/projects validation failed", parsed.error.message);
        return res.status(400).json({ message: parsed.error.message });
      }
      console.log("[API] POST /api/projects parsed", { latitude: parsed.data.latitude, longitude: parsed.data.longitude });
      const project = await storage.createProject(parsed.data);
      res.status(201).json(project);
    } catch (error) {
      res.status(500).json({ message: "Failed to create project" });
    }
  });

  app.patch("/api/projects/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      if (req.user.role === "restricted") {
        const [assignment] = await db.select().from(projectAssignments)
          .where(and(eq(projectAssignments.projectId, id), eq(projectAssignments.userId, req.user.id)));
        if (!assignment && project.createdById !== req.user.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }
      const allowed = ["name", "description", "status", "address", "latitude", "longitude", "color", "coverPhotoId", "tags"];
      const filtered: Record<string, any> = {};
      for (const key of allowed) {
        if (key in req.body) filtered[key] = req.body[key];
      }
      const updated = await storage.updateProject(id, filtered);
      if (!updated) return res.status(404).json({ message: "Project not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update project" });
    }
  });

  app.delete("/api/projects/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      if (req.user.role === "restricted") {
        const [assignment] = await db.select().from(projectAssignments)
          .where(and(eq(projectAssignments.projectId, id), eq(projectAssignments.userId, req.user.id)));
        if (!assignment && project.createdById !== req.user.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }
      await storage.deleteProject(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete project" });
    }
  });

  app.post("/api/uploads/sign", requireWriteAccess, async (req: any, res) => {
    try {
      const files = req.body?.files;
      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ message: "Provide a non-empty 'files' array" });
      }
      if (files.length > 20) {
        return res.status(400).json({ message: "Cannot sign more than 20 files at once" });
      }
      const signed = await Promise.all(
        files.map(async (f: any) => {
          if (!f?.originalName || !f?.mimeType) {
            throw new Error("Each file must include originalName and mimeType");
          }
          if (!isAllowedUpload(f.originalName, f.mimeType)) {
            throw new Error(`File type not allowed: ${f.originalName}`);
          }
          const sizeLimit = f.mimeType.startsWith("video/") ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
          if (typeof f.fileSize !== "number" || !Number.isFinite(f.fileSize) || f.fileSize <= 0 || f.fileSize > sizeLimit) {
            throw new Error(`File size must be between 1 byte and ${Math.round(sizeLimit / (1024 * 1024))} MB: ${f.originalName}`);
          }
          return getPresignedPutUrl(f.originalName, f.mimeType, "photos", f.fileSize);
        })
      );
      res.json(signed);
    } catch (error: any) {
      console.error("Sign upload error:", error?.message || error);
      res.status(400).json({ message: error?.message || "Failed to sign upload" });
    }
  });

  app.post("/api/projects/:id/media", requireWriteAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      if (req.user.role === "restricted") {
        const [assignment] = await db.select().from(projectAssignments)
          .where(and(eq(projectAssignments.projectId, projectId), eq(projectAssignments.userId, req.user.id)));
        if (!assignment && project.createdById !== req.user.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const items = req.body?.files;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "Provide a non-empty 'files' array of uploaded objects" });
      }

      const caption = req.body.caption || null;
      const tags = Array.isArray(req.body.tags)
        ? req.body.tags.filter(Boolean)
        : (typeof req.body.tags === "string"
            ? req.body.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
            : []);

      const created = await Promise.all(
        items.map(async (it: any) => {
          if (!it?.key || !it?.publicUrl || !it?.originalName || !it?.mimeType) {
            throw new Error("Each file must include key, publicUrl, originalName, and mimeType");
          }
          return storage.createMedia({
            projectId,
            uploadedById: req.user.id,
            filename: it.key,
            originalName: it.originalName,
            mimeType: it.mimeType,
            url: it.publicUrl,
            caption,
            tags,
            latitude: it.latitude ?? (req.body.latitude ? parseFloat(req.body.latitude) : null),
            longitude: it.longitude ?? (req.body.longitude ? parseFloat(req.body.longitude) : null),
          });
        })
      );

      res.status(201).json(await presignMediaUrls(created));
    } catch (error: any) {
      console.error("Create media error:", error?.message || error);
      res.status(500).json({ message: error?.message || "Failed to save media" });
    }
  });

  app.get("/api/tasks", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      let allTasks = await storage.getAllTasks(accountId);
      if (req.user.role === "restricted") {
        const assignedIds = await db.select({ projectId: projectAssignments.projectId })
          .from(projectAssignments).where(eq(projectAssignments.userId, req.user.id));
        const assignedSet = new Set(assignedIds.map(a => a.projectId));
        const ownedIds = await db.select({ id: projects.id })
          .from(projects).where(and(eq(projects.accountId, accountId), eq(projects.createdById, req.user.id)));
        const ownedSet = new Set(ownedIds.map(p => p.id));
        allTasks = allTasks.filter(t => assignedSet.has(t.projectId) || ownedSet.has(t.projectId));
      }
      res.json(allTasks);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch tasks" });
    }
  });

  app.get("/api/calendar-connections", requireReadAccess, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const connections = await storage.getCalendarConnections(userId);
      res.json(connections);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch calendar connections" });
    }
  });

  app.post("/api/calendar-connections", requireWriteAccess, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const { provider, externalEmail, syncTasks, syncChecklists } = req.body;
      if (!provider || !["google", "outlook", "apple", "ical"].includes(provider)) {
        return res.status(400).json({ message: "Invalid provider. Must be one of: google, outlook, apple, ical" });
      }
      const existing = await storage.getCalendarConnections(userId);
      if (existing.some(c => c.provider === provider)) {
        return res.status(409).json({ message: "This calendar provider is already connected" });
      }
      const connection = await storage.createCalendarConnection({
        userId,
        accountId,
        provider,
        externalEmail: externalEmail || null,
        syncTasks: syncTasks !== false,
        syncChecklists: !!syncChecklists,
        status: "pending",
      });
      res.status(201).json(connection);
    } catch (error) {
      res.status(500).json({ message: "Failed to create calendar connection" });
    }
  });

  app.patch("/api/calendar-connections/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const userId = req.user.id;
      const conn = await storage.getCalendarConnection(id);
      if (!conn || conn.userId !== userId) return res.status(404).json({ message: "Connection not found" });
      const { externalEmail, syncTasks, syncChecklists, status } = req.body;
      const updateData: any = {};
      if (externalEmail !== undefined) updateData.externalEmail = externalEmail;
      if (syncTasks !== undefined) updateData.syncTasks = !!syncTasks;
      if (syncChecklists !== undefined) updateData.syncChecklists = !!syncChecklists;
      if (status !== undefined) updateData.status = status;
      const updated = await storage.updateCalendarConnection(id, updateData);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update calendar connection" });
    }
  });

  app.delete("/api/calendar-connections/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const userId = req.user.id;
      const conn = await storage.getCalendarConnection(id);
      if (!conn || conn.userId !== userId) return res.status(404).json({ message: "Connection not found" });
      await storage.deleteCalendarConnection(id);
      res.json({ message: "Disconnected" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete calendar connection" });
    }
  });

  async function pushEventToConnections(userId: string, event: any) {
    const connections = await storage.getCalendarConnections(userId);
    if (connections.length === 0) {
      return { status: "disabled" as const, message: "No connected calendar to push to." };
    }
    const active = connections.filter(c => c.status === "active");
    if (active.length === 0) {
      const names = connections.map(c => c.provider).join(", ");
      return {
        status: "pending" as const,
        message: `Saved. Will sync to ${names} once that connection is fully authorized.`,
      };
    }
    return {
      status: "pending" as const,
      message: `Queued for sync to ${active.map(c => c.provider).join(", ")}.`,
    };
  }

  app.get("/api/calendar-events", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const events = await storage.getCalendarEvents(accountId);
      res.json(events);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch events" });
    }
  });

  app.post("/api/calendar-events", requireWriteAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      const userId = req.user.id;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const parsed = insertCalendarEventSchema.parse({
        ...req.body,
        accountId,
        createdById: userId,
      });
      if (parsed.endsAt < parsed.startsAt) {
        return res.status(400).json({ message: "End time must be after start time." });
      }
      const created = await storage.createCalendarEvent(parsed);
      let syncStatus: string = "disabled";
      let syncMessage: string | null = null;
      if (parsed.pushToConnected) {
        const result = await pushEventToConnections(userId, created);
        syncStatus = result.status;
        syncMessage = result.message;
        await storage.updateCalendarEvent(created.id, { syncStatus, syncMessage });
      }
      res.status(201).json({ ...created, syncStatus, syncMessage });
    } catch (error: any) {
      if (error?.errors) return res.status(400).json({ message: "Invalid event data", errors: error.errors });
      res.status(500).json({ message: "Failed to create event" });
    }
  });

  app.patch("/api/calendar-events/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const accountId = req.user.accountId;
      const existing = await storage.getCalendarEvent(id);
      if (!existing || existing.accountId !== accountId) return res.status(404).json({ message: "Event not found" });
      const data: any = { ...req.body };
      if (data.startsAt) data.startsAt = new Date(data.startsAt);
      if (data.endsAt) data.endsAt = new Date(data.endsAt);
      if (data.repeatUntil) data.repeatUntil = new Date(data.repeatUntil);
      delete data.accountId;
      delete data.createdById;
      const updated = await storage.updateCalendarEvent(id, data);
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update event" });
    }
  });

  app.delete("/api/calendar-events/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const accountId = req.user.accountId;
      const existing = await storage.getCalendarEvent(id);
      if (!existing || existing.accountId !== accountId) return res.status(404).json({ message: "Event not found" });
      await storage.deleteCalendarEvent(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete event" });
    }
  });

  app.get("/api/calendar/events", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const allTasks = await storage.getAllTasks(accountId);
      const allChecklists = await storage.getAllChecklists(accountId);
      const projectsList = await storage.getProjects(accountId);
      const calEvents = await storage.getCalendarEvents(accountId);
      const colorByProject: Record<number, string> = {};
      projectsList.forEach(p => { colorByProject[p.id] = p.color || "#F09000"; });
      const events = [
        ...calEvents.map(e => ({
          id: `event-${e.id}`,
          rawId: e.id,
          type: "event" as const,
          title: e.title,
          date: e.startsAt,
          endsAt: e.endsAt,
          allDay: e.allDay,
          location: e.location,
          description: e.description,
          attendees: e.attendees,
          repeat: e.repeat,
          status: e.syncStatus,
          syncMessage: e.syncMessage,
          priority: null,
          projectId: e.projectId,
          projectName: e.projectId ? (projectsList.find(p => p.id === e.projectId)?.name || "") : "",
          color: e.projectId ? (colorByProject[e.projectId] || "#F09000") : "#F09000",
          assignedTo: null,
        })),
        ...allTasks.filter(t => t.dueDate).map(t => ({
          id: `task-${t.id}`,
          type: "task" as const,
          title: t.title,
          date: t.dueDate,
          status: t.status,
          priority: t.priority,
          projectId: t.projectId,
          projectName: t.project?.name || "",
          color: colorByProject[t.projectId] || "#F09000",
          assignedTo: t.assignedTo ? `${t.assignedTo.firstName || ""} ${t.assignedTo.lastName || ""}`.trim() : null,
        })),
        ...allChecklists.filter(c => c.dueDate).map(c => ({
          id: `checklist-${c.id}`,
          type: "checklist" as const,
          title: c.title,
          date: c.dueDate,
          status: c.status,
          priority: null,
          projectId: c.projectId,
          projectName: c.project?.name || "",
          color: colorByProject[c.projectId] || "#267D32",
          assignedTo: c.assignedTo ? `${c.assignedTo.firstName || ""} ${c.assignedTo.lastName || ""}`.trim() : null,
        })),
      ];
      res.json(events);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch calendar events" });
    }
  });

  app.delete("/api/media/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.id as string);
      if (Number.isNaN(mediaId)) return res.status(400).json({ message: "Invalid media id" });
      if (!(await verifyMediaAccess(mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const item = await storage.getMedia(mediaId);
      if (!item) return res.status(404).json({ message: "Media not found" });
      const project = await storage.getProject(item.projectId);
      if (project && project.coverPhotoId === mediaId) {
        await storage.updateProject(item.projectId, { coverPhotoId: null } as any);
      }
      await storage.deleteMedia(mediaId);
      const key = extractS3KeyFromUrl(item.url);
      if (key) {
        try { await deleteFromS3(key); } catch (e) { console.warn("S3 delete failed", e); }
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete media", error);
      res.status(500).json({ message: "Failed to delete media" });
    }
  });

  app.patch("/api/media/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.id as string);
      if (!(await verifyMediaAccess(mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const { caption, tags } = req.body;
      const updateData: { caption?: string; tags?: string[] } = {};
      if (caption !== undefined) updateData.caption = caption;
      if (tags !== undefined) updateData.tags = Array.isArray(tags) ? tags : [];
      const updated = await storage.updateMedia(mediaId, updateData);
      if (!updated) return res.status(404).json({ message: "Media not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update media" });
    }
  });

  app.get("/api/tags", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const type = req.query.type as string | undefined;
      if (type && !["photo", "project"].includes(type)) {
        return res.status(400).json({ message: "Invalid type. Must be 'photo' or 'project'" });
      }
      const tags = await storage.getAccountTags(accountId, type);
      res.json(tags);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch tags" });
    }
  });

  app.post("/api/tags", requireWriteAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const { name, type } = req.body;
      if (!name || !type || !["photo", "project"].includes(type)) {
        return res.status(400).json({ message: "Name and type (photo/project) are required" });
      }
      const tag = await storage.createAccountTag({ accountId, name: name.trim(), type });
      res.status(201).json(tag);
    } catch (error) {
      res.status(500).json({ message: "Failed to create tag" });
    }
  });

  app.delete("/api/tags/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const tags = await storage.getAccountTags(accountId);
      const tag = tags.find(t => t.id === id);
      if (!tag) return res.status(404).json({ message: "Tag not found" });
      await storage.deleteAccountTag(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete tag" });
    }
  });

  app.get("/api/media", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const allMedia = await presignMediaUrls(await storage.getAllMedia(accountId));
      res.json(allMedia);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch media" });
    }
  });

  app.get("/api/media/:id/comments", requireReadAccess, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.id as string);
      if (!(await verifyMediaAccess(mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const mediaComments = await storage.getCommentsByMedia(mediaId);
      res.json(mediaComments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  });

  app.post("/api/media/:id/comments", requireWriteAccess, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.id as string);
      if (!(await verifyMediaAccess(mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const parsed = insertCommentSchema.safeParse({
        mediaId,
        userId: req.user.id,
        content: req.body.content,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const comment = await storage.createComment(parsed.data);
      res.status(201).json(comment);
    } catch (error) {
      res.status(500).json({ message: "Failed to create comment" });
    }
  });

  app.get("/api/projects/:projectId/annotations", requireReadAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.projectId as string);
      if (Number.isNaN(projectId)) return res.status(400).json({ message: "Invalid project id" });
      if (!(await verifyProjectAccess(projectId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const annotations = await storage.getAnnotationsByProject(projectId);
      res.json(annotations);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch annotations" });
    }
  });

  app.get("/api/media/:mediaId/annotations", requireReadAccess, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.mediaId as string);
      if (Number.isNaN(mediaId)) return res.status(400).json({ message: "Invalid media id" });
      if (!(await verifyMediaAccess(mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const annotations = await storage.getAnnotationsByMedia(mediaId);
      res.json(annotations);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch annotations" });
    }
  });

  app.post("/api/media/:mediaId/annotations", requireWriteAccess, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.mediaId as string);
      if (Number.isNaN(mediaId)) return res.status(400).json({ message: "Invalid media id" });
      if (!(await verifyMediaAccess(mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const parsedStrokes = annotationStrokesSchema.safeParse(req.body?.strokes);
      if (!parsedStrokes.success) {
        return res.status(400).json({ message: parsedStrokes.error.message });
      }
      const created = await storage.createAnnotation({
        mediaId,
        userId: req.user.id,
        strokes: parsedStrokes.data,
      });
      res.status(201).json(created);
    } catch (error) {
      res.status(500).json({ message: "Failed to create annotation" });
    }
  });

  app.put("/api/annotations/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = req.params.id as string;
      const existing = await storage.getAnnotation(id);
      if (!existing) return res.status(404).json({ message: "Annotation not found" });
      if (existing.userId !== req.user.id) return res.status(403).json({ message: "Only the owner can edit this annotation" });
      if (!(await verifyMediaAccess(existing.mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const parsedStrokes = annotationStrokesSchema.safeParse(req.body?.strokes);
      if (!parsedStrokes.success) {
        return res.status(400).json({ message: parsedStrokes.error.message });
      }
      const updated = await storage.updateAnnotation(id, { strokes: parsedStrokes.data });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update annotation" });
    }
  });

  app.delete("/api/annotations/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = req.params.id as string;
      const existing = await storage.getAnnotation(id);
      if (!existing) return res.status(404).json({ message: "Annotation not found" });
      if (existing.userId !== req.user.id) return res.status(403).json({ message: "Only the owner can delete this annotation" });
      if (!(await verifyMediaAccess(existing.mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      await storage.deleteAnnotation(id);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete annotation" });
    }
  });

  app.post("/api/projects/:id/tasks", requireWriteAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      const parsed = insertTaskSchema.safeParse({
        projectId,
        title: req.body.title,
        description: req.body.description || null,
        priority: req.body.priority || "medium",
        assignedToId: req.body.assignedToId || null,
        createdById: req.user.id,
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const task = await storage.createTask(parsed.data);
      res.status(201).json(task);
    } catch (error) {
      res.status(500).json({ message: "Failed to create task" });
    }
  });

  app.patch("/api/tasks/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyTaskAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const allowed = ["title", "description", "status", "priority", "assignedToId", "dueDate"];
      const filtered: Record<string, any> = {};
      for (const key of allowed) {
        if (key in req.body) filtered[key] = req.body[key];
      }
      const updated = await storage.updateTask(id, filtered);
      if (!updated) return res.status(404).json({ message: "Task not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update task" });
    }
  });

  // Checklists
  app.get("/api/checklists", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const allChecklists = await storage.getAllChecklists(accountId);
      res.json(allChecklists);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch checklists" });
    }
  });

  app.post("/api/projects/:id/checklists", requireWriteAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      if (!(await verifyProjectAccess(projectId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const parsed = insertChecklistSchema.safeParse({
        projectId,
        title: req.body.title,
        description: req.body.description || null,
        assignedToId: req.body.assignedToId || null,
        createdById: req.user.id,
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : null,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const checklist = await storage.createChecklist(parsed.data);

      if (req.body.items && Array.isArray(req.body.items)) {
        for (let i = 0; i < req.body.items.length; i++) {
          await storage.createChecklistItem({
            checklistId: checklist.id,
            label: req.body.items[i],
            sortOrder: i,
          });
        }
      }

      res.status(201).json(checklist);
    } catch (error) {
      res.status(500).json({ message: "Failed to create checklist" });
    }
  });

  app.patch("/api/checklists/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const allowed = ["title", "description", "status", "assignedToId", "dueDate"];
      const filtered: Record<string, any> = {};
      for (const key of allowed) {
        if (key in req.body) filtered[key] = req.body[key];
      }
      const updated = await storage.updateChecklist(id, filtered);
      if (!updated) return res.status(404).json({ message: "Checklist not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update checklist" });
    }
  });

  app.delete("/api/checklists/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      await storage.deleteChecklist(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete checklist" });
    }
  });

  app.get("/api/checklists/:id/items", requireReadAccess, async (req: any, res) => {
    try {
      const checklistId = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const items = await storage.getChecklistItems(checklistId);
      res.json(items);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch checklist items" });
    }
  });

  app.post("/api/checklists/:id/items", requireWriteAccess, async (req: any, res) => {
    try {
      const checklistId = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const parsed = insertChecklistItemSchema.safeParse({
        checklistId,
        label: req.body.label,
        sortOrder: req.body.sortOrder || 0,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const item = await storage.createChecklistItem(parsed.data);
      res.status(201).json(item);
    } catch (error) {
      res.status(500).json({ message: "Failed to create checklist item" });
    }
  });

  app.patch("/api/checklist-items/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const item = await db.select({ checklistId: sql<number>`checklist_items.checklist_id` }).from(sql`checklist_items`).where(sql`checklist_items.id = ${id}`).limit(1);
      if (item.length === 0) return res.status(404).json({ message: "Item not found" });
      if (!(await verifyChecklistAccess(item[0].checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const allowed = ["label", "checked", "sortOrder"];
      const filtered: Record<string, any> = {};
      for (const key of allowed) {
        if (key in req.body) filtered[key] = req.body[key];
      }
      const updated = await storage.updateChecklistItem(id, filtered);
      if (!updated) return res.status(404).json({ message: "Item not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update checklist item" });
    }
  });

  app.delete("/api/checklist-items/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const item = await db.select({ checklistId: sql<number>`checklist_items.checklist_id` }).from(sql`checklist_items`).where(sql`checklist_items.id = ${id}`).limit(1);
      if (item.length === 0) return res.status(404).json({ message: "Item not found" });
      if (!(await verifyChecklistAccess(item[0].checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      await storage.deleteChecklistItem(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete checklist item" });
    }
  });

  // Reports
  app.get("/api/reports", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const allReports = await storage.getAllReports(accountId);
      res.json(allReports);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch reports" });
    }
  });

  app.post("/api/projects/:id/reports", requireWriteAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      if (!(await verifyProjectAccess(projectId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const parsed = insertReportSchema.safeParse({
        projectId,
        title: req.body.title,
        type: req.body.type || "inspection",
        content: req.body.content || null,
        findings: req.body.findings || null,
        recommendations: req.body.recommendations || null,
        createdById: req.user.id,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const report = await storage.createReport(parsed.data);
      res.status(201).json(report);
    } catch (error) {
      res.status(500).json({ message: "Failed to create report" });
    }
  });

  app.patch("/api/reports/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyReportAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const allowed = ["title", "type", "status", "content", "findings", "recommendations"];
      const filtered: Record<string, any> = {};
      for (const key of allowed) {
        if (key in req.body) filtered[key] = req.body[key];
      }
      const updated = await storage.updateReport(id, filtered);
      if (!updated) return res.status(404).json({ message: "Report not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update report" });
    }
  });

  app.delete("/api/reports/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyReportAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      await storage.deleteReport(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete report" });
    }
  });

  app.get("/api/users", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const usersList = await storage.getUsers(accountId);
      const safeUsers = usersList.map(({ password, ...rest }) => sanitizeUserForViewer(rest, req.user));
      res.json(safeUsers);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Account seat usage
  app.get("/api/account/seats", requireAdmin, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      const accountRows = await db
        .select({
          seatCount: accounts.seatCount,
          billingCycle: accounts.billingCycle,
          subscriptionStatus: accounts.subscriptionStatus,
          ownerId: accounts.ownerId,
          ownerFirstName: users.firstName,
          ownerLastName: users.lastName,
        })
        .from(accounts)
        .leftJoin(users, eq(users.id, accounts.ownerId))
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (accountRows.length === 0) {
        return res.status(404).json({ message: "Account not found" });
      }
      const row = accountRows[0];
      const total = row.seatCount ?? 3;
      const usedRows = await db
        .select({ value: count() })
        .from(users)
        .where(eq(users.accountId, accountId));
      const used = Number(usedRows[0]?.value ?? 0);
      const available = Math.max(0, total - used);
      const overCapacity = used > total;

      const ownerName = [row.ownerFirstName, row.ownerLastName]
        .filter(Boolean)
        .join(" ") || null;
      const isTrial =
        row.subscriptionStatus === "trialing" || row.subscriptionStatus === "trial";
      const trialMaxSeats = isTrial ? 10 : null;

      return res.json({
        used,
        total,
        available,
        overCapacity,
        billingCycle: row.billingCycle ?? null,
        subscriptionStatus: row.subscriptionStatus ?? null,
        ownerName,
        ownerId: row.ownerId ?? null,
        trialMaxSeats,
      });
    } catch (error) {
      console.error("Error fetching seat usage:", error);
      res.status(500).json({ message: "Failed to fetch seat usage" });
    }
  });

  app.post("/api/account/seats", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      const { desiredCount, expectedCurrent } = req.body || {};

      if (!Number.isInteger(desiredCount) || desiredCount < 3) {
        return res.status(400).json({ message: "desiredCount must be an integer >= 3" });
      }
      if (!Number.isInteger(expectedCurrent)) {
        return res.status(400).json({ message: "expectedCurrent must be an integer" });
      }
      if (desiredCount === expectedCurrent) {
        return res.status(400).json({ message: "No change requested" });
      }

      const accountRows = await db
        .select({
          seatCount: accounts.seatCount,
          stripeCustomerId: accounts.stripeCustomerId,
          stripeSubscriptionId: accounts.stripeSubscriptionId,
          subscriptionStatus: accounts.subscriptionStatus,
        })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (accountRows.length === 0) {
        return res.status(404).json({ message: "Account not found" });
      }
      const acc = accountRows[0];
      const currentSeats = acc.seatCount ?? 3;

      if (currentSeats !== expectedCurrent) {
        return res.status(409).json({ message: "Seat count changed; please refresh." });
      }
      if (!acc.stripeCustomerId || !acc.stripeSubscriptionId) {
        return res.status(400).json({ message: "Set up billing before changing seat count." });
      }

      const userCountRows = await db
        .select({ value: count() })
        .from(users)
        .where(eq(users.accountId, accountId));
      const activeUserCount = Number(userCountRows[0]?.value ?? 0);
      if (desiredCount < activeUserCount) {
        return res.status(400).json({
          message: `Cannot reduce to ${desiredCount} seats — account has ${activeUserCount} active users.`,
        });
      }

      if (
        (acc.subscriptionStatus === "trialing" ||
          acc.subscriptionStatus === "trial") &&
        desiredCount > 10
      ) {
        return res.status(400).json({
          message: "Trial accounts are limited to 10 seats. Upgrade to add more.",
        });
      }

      const stripe = await getUncachableStripeClient();
      const sub = await stripe.subscriptions.retrieve(acc.stripeSubscriptionId, {
        expand: ["items.data.price.product"],
      });

      const seatLineItem = sub.items.data.find((item) => isSeatAddonItem(item));
      const desiredAddonQty = desiredCount - 3;
      let itemsUpdate: any[] = [];

      if (seatLineItem) {
        if (desiredAddonQty > 0) {
          itemsUpdate = [{ id: seatLineItem.id, quantity: desiredAddonQty }];
        } else {
          itemsUpdate = [{ id: seatLineItem.id, deleted: true }];
        }
      } else if (desiredAddonQty > 0) {
        const baseItem = sub.items.data.find((item) => !isSeatAddonItem(item));
        const interval = (baseItem?.price as any)?.recurring?.interval;
        if (!interval) {
          return res.status(500).json({ message: "Could not determine billing interval from subscription" });
        }
        const allPrices = await stripe.prices.list({
          active: true,
          expand: ["data.product"],
          limit: 100,
        });
        const seatPrice = allPrices.data.find((p) => {
          const product = p.product as any;
          const name = (product?.name || "").toLowerCase();
          return (
            (name.includes("additional") || name.includes("seat")) &&
            p.recurring?.interval === interval
          );
        });
        if (!seatPrice) {
          return res.status(500).json({
            message: `Additional Seat price not found for ${interval} billing`,
          });
        }
        itemsUpdate = [{ price: seatPrice.id, quantity: desiredAddonQty }];
      }

      let stripeUpdated = false;
      let prorationAmount: number | null = null;

      if (itemsUpdate.length > 0) {
        await stripe.subscriptions.update(acc.stripeSubscriptionId, {
          items: itemsUpdate,
          proration_behavior: "create_prorations",
        });
        stripeUpdated = true;
      }

      const updateResult = await db
        .update(accounts)
        .set({ seatCount: desiredCount })
        .where(and(eq(accounts.id, accountId), eq(accounts.seatCount, expectedCurrent)))
        .returning({ id: accounts.id });

      if (updateResult.length === 0) {
        return res.status(409).json({
          message: "Seat count changed during update; Stripe was updated but DB was not. Please refresh.",
        });
      }

      console.log(
        "[seat-change]",
        JSON.stringify({
          accountId,
          triggeredByUserId: req.user.id,
          triggeredByRole: req.user.role,
          oldSeatCount: expectedCurrent,
          newSeatCount: desiredCount,
          stripeUpdated,
          prorationAmount,
        }),
      );

      return res.json({ newSeatCount: desiredCount, stripeUpdated, prorationAmount });
    } catch (error: any) {
      console.error("Seat update error:", error);
      res.status(500).json({ message: error.message || "Failed to update seat count" });
    }
  });

  // Transfer account ownership
  app.post("/api/account/transfer-ownership", requireAdmin, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      const requesterId = req.user.id;
      const { newOwnerId } = req.body || {};

      if (typeof newOwnerId !== "string" || newOwnerId.trim().length === 0) {
        return res.status(400).json({ message: "newOwnerId is required." });
      }
      if (newOwnerId === requesterId) {
        return res.status(400).json({ message: "Cannot transfer ownership to yourself." });
      }

      const accountRows = await db
        .select({ ownerId: accounts.ownerId })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (accountRows.length === 0) {
        return res.status(404).json({ message: "Account not found." });
      }
      if (requesterId !== accountRows[0].ownerId) {
        return res.status(403).json({ message: "Only the account owner can transfer ownership." });
      }

      const targetRows = await db
        .select({
          id: users.id,
          role: users.role,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(users)
        .where(and(eq(users.id, newOwnerId), eq(users.accountId, accountId)))
        .limit(1);
      if (targetRows.length === 0) {
        return res.status(404).json({ message: "User not found in this account." });
      }
      const target = targetRows[0];
      const newOwnerWasAdmin = target.role === "admin";

      await db.transaction(async (tx) => {
        await tx
          .update(accounts)
          .set({ ownerId: newOwnerId })
          .where(eq(accounts.id, accountId));

        if (!newOwnerWasAdmin) {
          await tx
            .update(users)
            .set({ role: "admin" })
            .where(eq(users.id, newOwnerId));
        }
      });

      console.log(
        "[ownership-transfer]",
        JSON.stringify({
          accountId,
          fromUserId: requesterId,
          toUserId: newOwnerId,
          newOwnerWasAdmin,
          timestamp: new Date().toISOString(),
        }),
      );

      const newOwnerName =
        [target.firstName, target.lastName].filter(Boolean).join(" ") || null;
      return res.json({ success: true, newOwnerId, newOwnerName });
    } catch (error: any) {
      console.error("Ownership transfer error:", error);
      res
        .status(500)
        .json({ message: error?.message || "Failed to transfer ownership" });
    }
  });

  // Soft-delete the entire account (owner only). 30-day grace per Apple App Store 5.1.1(v).
  // Sign-in within grace restores the account; after grace, data is permanently destroyed by a
  // separate (future) hard-delete job. This endpoint cancels the Stripe sub and emails all members.
  // NOTE: gated only by isAuthenticated (NOT requireWriteAccess) so users can still delete their
  // account when billing is in a locked/read-only state. Apple App Store 5.1.1(v) requires the
  // delete path to remain reachable independent of subscription status.
  app.delete("/api/account", isAuthenticated, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const accountId = currentUser.accountId;

      const [account] = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (!account) {
        return res.status(404).json({ message: "Account not found" });
      }
      if (account.ownerId !== currentUser.id) {
        return res.status(403).json({ message: "Only account owners can delete the account." });
      }

      const { confirmText, password } = req.body || {};
      if (confirmText !== "DELETE") {
        return res.status(400).json({ message: "Type DELETE exactly to confirm." });
      }

      // Password is REQUIRED. OAuth-only owners (no password set) get an actionable error pointing
      // to the password-reset flow, since there is no Settings → Security tab in this app.
      if (!currentUser.password) {
        return res.status(400).json({
          message:
            "To delete the account, please first set a password using the 'Forgot password' flow at /forgot-password, then sign in with your new password and try again.",
        });
      }
      if (typeof password !== "string" || password.length === 0) {
        return res.status(400).json({ message: "Password required" });
      }
      const isValid = await bcrypt.compare(password, currentUser.password);
      if (!isValid) {
        return res.status(401).json({ message: "Incorrect password" });
      }

      const deletedAt = new Date();
      const restoreDeadline = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

      // Capture all active members BEFORE delete, for emailing
      const allUsers = await db
        .select({ id: users.id, email: users.email, firstName: users.firstName })
        .from(users)
        .where(and(eq(users.accountId, accountId), isNull(users.deletedAt)));

      // Soft-delete account + all its users in one transaction
      await db.transaction(async (tx) => {
        await tx
          .update(accounts)
          .set({ deletedAt, subscriptionStatus: "canceled" })
          .where(eq(accounts.id, accountId));
        await tx
          .update(users)
          .set({ deletedAt })
          .where(and(eq(users.accountId, accountId), isNull(users.deletedAt)));
      });

      // Cancel Stripe subscription (best-effort, outside the transaction)
      let stripeCanceled = false;
      if (account.stripeSubscriptionId) {
        try {
          const stripe = await getUncachableStripeClient();
          await stripe.subscriptions.cancel(account.stripeSubscriptionId);
          stripeCanceled = true;
        } catch (err) {
          console.error("[account-deletion] stripe cancel failed:", err);
        }
      }

      console.log(
        "[account-deletion] account",
        accountId,
        "soft-deleted by owner",
        currentUser.id,
        "—",
        allUsers.length,
        "users affected, stripe canceled:",
        stripeCanceled,
      );
      Sentry.captureMessage("Account soft-deleted", {
        level: "info",
        tags: { event: "account-deletion-account" },
        extra: { accountId, ownerId: currentUser.id, usersAffected: allUsers.length, stripeCanceled },
      });

      const permanentDate = restoreDeadline.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const ownerName =
        [currentUser.firstName, currentUser.lastName].filter(Boolean).join(" ") ||
        currentUser.email ||
        "the account owner";

      // Best-effort parallel notification to all members
      await Promise.allSettled(
        allUsers.map((u) => {
          if (!u.email) return Promise.resolve();
          return sendAccountDeletionEmail(u.email, {
            firstName: u.firstName,
            accountName: account.name,
            ownerName,
            permanentDeletionDate: permanentDate,
          });
        }),
      );

      // End the current session
      req.logout((err: any) => {
        if (err) console.error("[account-deletion] logout error:", err);
        req.session?.destroy(() => {
          res.json({
            success: true,
            deletedAt: deletedAt.toISOString(),
            restoreDeadline: restoreDeadline.toISOString(),
            message: `Account scheduled for deletion. Sign in before ${permanentDate} to restore.`,
          });
        });
      });
    } catch (error: any) {
      console.error("[account-deletion] account-delete error:", error);
      res.status(500).json({ message: error?.message || "Failed to delete account" });
    }
  });

  // Invitations
  app.get("/api/invitations", requireReadAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const accountId = currentUser.accountId;
      const result = await db.select({
        id: invitations.id,
        email: invitations.email,
        firstName: invitations.firstName,
        lastName: invitations.lastName,
        role: invitations.role,
        token: invitations.token,
        status: invitations.status,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
        invitedByFirst: users.firstName,
        invitedByLast: users.lastName,
      })
        .from(invitations)
        .leftJoin(users, eq(invitations.invitedById, users.id))
        .where(and(eq(invitations.accountId, accountId), eq(invitations.status, "pending")));
      res.json(result);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch invitations" });
    }
  });

  app.post("/api/invitations", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const { email, role, firstName, lastName } = req.body || {};
      if (!email) return res.status(400).json({ message: "Email is required" });
      const trimmedFirst = typeof firstName === "string" ? firstName.trim() : "";
      const trimmedLast = typeof lastName === "string" ? lastName.trim() : "";
      if (!trimmedFirst || !trimmedLast) {
        return res.status(400).json({ message: "First and last name are required." });
      }
      const validRoles = ["admin", "manager", "standard", "restricted"];
      if (!validRoles.includes(role || "standard")) {
        return res.status(400).json({ message: "Invalid role" });
      }
      if (currentUser.role === "manager" && (role === "admin" || role === "manager")) {
        return res.status(403).json({ message: "Managers can only invite standard or restricted users" });
      }
      const existingUser = await authStorage.getUserByEmail(email);
      if (existingUser) {
        return res.status(409).json({ message: "A user with this email already exists" });
      }
      const [existingInvite] = await db.select().from(invitations).where(
        and(eq(invitations.email, email.toLowerCase()), eq(invitations.accountId, currentUser.accountId), eq(invitations.status, "pending"))
      );
      if (existingInvite) {
        return res.status(409).json({ message: "An invitation has already been sent to this email" });
      }
      const token = crypto.randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const [invitation] = await db.insert(invitations).values({
        accountId: currentUser.accountId,
        email: email.toLowerCase(),
        firstName: trimmedFirst,
        lastName: trimmedLast,
        role: role || "standard",
        token,
        invitedById: currentUser.id,
        expiresAt,
      }).returning();

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const inviteLink = `${baseUrl}/register?token=${token}`;
      if (process.env.NODE_ENV !== "production") {
        console.log(`[Invitation] Link for ${email}: ${inviteLink}`);
      }

      // Best-effort invitation email — failures are logged but do not fail the request,
      // since the inviteLink is returned in the response and the Admin can share it manually.
      let accountName = "Field View";
      try {
        const acctRows = await db
          .select({ name: accounts.name })
          .from(accounts)
          .where(eq(accounts.id, currentUser.accountId))
          .limit(1);
        if (acctRows.length > 0 && acctRows[0].name) {
          accountName = acctRows[0].name;
        }
      } catch (err) {
        console.error("[invitation-email] Failed to load account name:", err);
      }

      const inviterName =
        [currentUser.firstName, currentUser.lastName].filter(Boolean).join(" ") || null;

      try {
        const emailResult = await sendInvitationEmail({
          to: invitation.email,
          inviterName,
          inviterEmail: currentUser.email,
          accountName,
          role: invitation.role,
          inviteUrl: inviteLink,
          expiresAt,
          recipientFirstName: invitation.firstName,
        });
        if (!emailResult.success) {
          console.error(
            "[invitation-email] Send returned failure:",
            emailResult.error,
          );
        }
      } catch (err) {
        console.error("[invitation-email] Send threw:", err);
      }

      res.status(201).json({ ...invitation, inviteLink });
    } catch (error) {
      console.error("Create invitation error:", error);
      res.status(500).json({ message: "Failed to create invitation" });
    }
  });

  app.delete("/api/invitations/:id", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const { id } = req.params;
      const [invitation] = await db.select().from(invitations).where(eq(invitations.id, id));
      if (!invitation || invitation.accountId !== currentUser.accountId) {
        return res.status(404).json({ message: "Invitation not found" });
      }
      await db.delete(invitations).where(eq(invitations.id, id));
      res.json({ message: "Invitation cancelled" });
    } catch (error) {
      res.status(500).json({ message: "Failed to cancel invitation" });
    }
  });

  // Self-removal from an account (any role except owner). 30-day soft-delete grace —
  // signing back in within grace restores the user. Owners must use DELETE /api/account
  // or transfer ownership first. Best-effort Stripe seat decrement.
  // NOTE: gated only by isAuthenticated (NOT requireWriteAccess) — see DELETE /api/account.
  app.delete("/api/users/me", isAuthenticated, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const accountId = currentUser.accountId;

      if (req.body?.confirm !== true) {
        return res.status(400).json({ message: "Missing confirm flag" });
      }

      const [account] = await db
        .select({
          ownerId: accounts.ownerId,
          stripeSubscriptionId: accounts.stripeSubscriptionId,
          seatCount: accounts.seatCount,
        })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);
      if (!account) {
        return res.status(404).json({ message: "Account not found" });
      }
      if (account.ownerId === currentUser.id) {
        return res.status(400).json({
          message: "Account owners must delete the entire account or transfer ownership first.",
        });
      }

      const deletedAt = new Date();
      await db.update(users).set({ deletedAt }).where(eq(users.id, currentUser.id));

      // Best-effort Stripe seat decrement. Uses Stripe's current quantity as source of truth
      // (NOT accounts.seatCount) to defend against lost-update races when multiple users
      // self-leave concurrently. DB seatCount is then synced to Stripe.
      let seatDecremented = false;
      if (account.stripeSubscriptionId) {
        try {
          const stripe = await getUncachableStripeClient();
          const sub = await stripe.subscriptions.retrieve(account.stripeSubscriptionId, {
            expand: ["items.data.price.product"],
          });
          const seatLineItem = sub.items.data.find((item) => isSeatAddonItem(item));
          const currentQty = seatLineItem?.quantity ?? 0;
          if (seatLineItem && currentQty > 0) {
            const newAddonQty = currentQty - 1;
            const itemsUpdate =
              newAddonQty > 0
                ? [{ id: seatLineItem.id, quantity: newAddonQty }]
                : [{ id: seatLineItem.id, deleted: true }];
            await stripe.subscriptions.update(account.stripeSubscriptionId, {
              items: itemsUpdate,
              proration_behavior: "create_prorations",
            });
            // Sync DB to authoritative Stripe quantity (3 included seats + addon)
            await db
              .update(accounts)
              .set({ seatCount: newAddonQty + 3 })
              .where(eq(accounts.id, accountId));
            seatDecremented = true;
          }
        } catch (err) {
          console.error("[account-deletion] stripe seat decrement failed:", err);
        }
      }

      const restoreDeadline = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      console.log(
        "[account-deletion] user",
        currentUser.id,
        "self-deleted from account",
        accountId,
        "seat decremented:",
        seatDecremented,
      );
      Sentry.captureMessage("User self-delete", {
        level: "info",
        tags: { event: "account-deletion-self" },
        extra: { userId: currentUser.id, accountId, seatDecremented },
      });

      req.logout((err: any) => {
        if (err) console.error("[account-deletion] logout error:", err);
        req.session?.destroy(() => {
          res.json({
            success: true,
            deletedAt: deletedAt.toISOString(),
            restoreDeadline: restoreDeadline.toISOString(),
          });
        });
      });
    } catch (error: any) {
      console.error("[account-deletion] self-delete error:", error);
      res.status(500).json({ message: error?.message || "Failed to delete user" });
    }
  });

  app.delete("/api/users/:userId", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const { userId } = req.params;
      if (userId === currentUser.id) {
        return res.status(400).json({ message: "You cannot remove yourself" });
      }
      const targetUser = await authStorage.getUser(userId);
      if (!targetUser) return res.status(404).json({ message: "User not found" });
      if (targetUser.accountId !== currentUser.accountId) return res.status(403).json({ message: "Access denied" });
      if (targetUser.role === "admin" && currentUser.role !== "admin") {
        return res.status(403).json({ message: "Only admins can remove other admins" });
      }
      await db.update(users).set({ accountId: null, role: "standard" }).where(eq(users.id, userId));
      res.json({ message: "User removed from account" });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove user" });
    }
  });

  // Project assignments (for restricted users)
  app.get("/api/projects/:id/assignments", requireReadAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id);
      if (!(await verifyProjectAccess(projectId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const assignments = await db.select({
        id: projectAssignments.id,
        userId: projectAssignments.userId,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        profileImageUrl: users.profileImageUrl,
      })
        .from(projectAssignments)
        .innerJoin(users, eq(projectAssignments.userId, users.id))
        .where(eq(projectAssignments.projectId, projectId));
      res.json(assignments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch assignments" });
    }
  });

  app.post("/api/projects/:id/assignments", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const projectId = parseInt(req.params.id);
      if (!(await verifyProjectAccess(projectId, currentUser.accountId))) return res.status(403).json({ message: "Access denied" });
      const { userId } = req.body;
      if (!userId) return res.status(400).json({ message: "userId is required" });
      const targetUser = await authStorage.getUser(userId);
      if (!targetUser || targetUser.accountId !== currentUser.accountId) return res.status(404).json({ message: "User not found" });
      const [existing] = await db.select().from(projectAssignments).where(
        and(eq(projectAssignments.projectId, projectId), eq(projectAssignments.userId, userId))
      );
      if (existing) return res.status(409).json({ message: "User already assigned to this project" });
      const [assignment] = await db.insert(projectAssignments).values({
        projectId,
        userId,
        assignedById: currentUser.id,
      }).returning();
      res.status(201).json(assignment);
    } catch (error) {
      res.status(500).json({ message: "Failed to assign user" });
    }
  });

  app.delete("/api/projects/:id/assignments/:userId", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const projectId = parseInt(req.params.id);
      if (!(await verifyProjectAccess(projectId, currentUser.accountId))) return res.status(403).json({ message: "Access denied" });
      await db.delete(projectAssignments).where(
        and(eq(projectAssignments.projectId, projectId), eq(projectAssignments.userId, req.params.userId))
      );
      res.json({ message: "Assignment removed" });
    } catch (error) {
      res.status(500).json({ message: "Failed to remove assignment" });
    }
  });

  app.patch("/api/users/:userId/subscription", isAuthenticated, async (req: any, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role !== "admin") {
        return res.status(403).json({ message: "Only admins can update subscriptions" });
      }
      const { userId } = req.params;
      const targetUser = await authStorage.getUser(userId);
      if (!targetUser) return res.status(404).json({ message: "User not found" });
      if (targetUser.accountId !== currentUser.accountId) return res.status(403).json({ message: "Access denied" });
      const { subscriptionStatus } = req.body;
      const validStatuses = ["none", "trial", "trialing", "active", "past_due", "canceled"];
      if (!validStatuses.includes(subscriptionStatus)) {
        return res.status(400).json({ message: "Invalid subscription status" });
      }
      const updated = await db.update(users).set({ subscriptionStatus }).where(eq(users.id, userId)).returning();
      if (updated.length === 0) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safeUser } = updated[0];
      res.json(sanitizeUserForViewer(safeUser, req.user));
    } catch (error) {
      res.status(500).json({ message: "Failed to update subscription" });
    }
  });

  app.patch("/api/users/:userId/role", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const { userId } = req.params;
      const targetUser = await authStorage.getUser(userId);
      if (!targetUser) return res.status(404).json({ message: "User not found" });
      if (targetUser.accountId !== currentUser.accountId) return res.status(403).json({ message: "Access denied" });
      const { role } = req.body;
      const validRoles = ["admin", "manager", "standard", "restricted"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }
      if (currentUser.role === "manager" && (role === "admin" || role === "manager")) {
        return res.status(403).json({ message: "Managers can only assign standard or restricted roles" });
      }
      const updated = await db.update(users).set({ role }).where(eq(users.id, userId)).returning();
      if (updated.length === 0) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safeUser } = updated[0];
      res.json(sanitizeUserForViewer(safeUser, req.user));
    } catch (error) {
      res.status(500).json({ message: "Failed to update role" });
    }
  });

  // Manager-only PATCH for hourly rate + timesheet enablement.
  const userPatchSchema = z.object({
    hourlyRateCents: z.number().int().nonnegative().nullable().optional(),
    timesheetEnabled: z.boolean().optional(),
  }).strict();

  app.patch("/api/users/:userId", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const { userId } = req.params;
      const targetUser = await authStorage.getUser(userId);
      if (!targetUser) return res.status(404).json({ message: "User not found" });
      if (targetUser.accountId !== currentUser.accountId) return res.status(403).json({ message: "Access denied" });

      const parsed = userPatchSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid request body" });
      }
      const updates: { hourlyRateCents?: number | null; timesheetEnabled?: boolean } = {};
      if ("hourlyRateCents" in parsed.data) updates.hourlyRateCents = parsed.data.hourlyRateCents ?? null;
      if ("timesheetEnabled" in parsed.data) updates.timesheetEnabled = parsed.data.timesheetEnabled!;
      if (Object.keys(updates).length === 0) {
        const { password: _, ...safe } = targetUser;
        return res.json(sanitizeUserForViewer(safe, currentUser));
      }
      const [updated] = await db.update(users).set(updates).where(eq(users.id, userId)).returning();
      if (!updated) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safeUser } = updated;
      res.json(sanitizeUserForViewer(safeUser, currentUser));
    } catch (error: any) {
      console.error("Error patching user:", error);
      res.status(500).json({ message: "Failed to update user" });
    }
  });

  // ============================================================
  // Timesheets
  // ============================================================

  // POST /api/timesheets/clock-in
  app.post("/api/timesheets/clock-in", requireWriteAccess, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const accountId = currentUser.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });

      const fresh = await authStorage.getUser(currentUser.id);
      if (!fresh) return res.status(404).json({ message: "User not found" });
      if (!fresh.timesheetEnabled) {
        return res.status(403).json({ message: "Timesheet tracking not enabled for this user" });
      }

      const body = z.object({
        projectId: z.coerce.number().int().positive(),
        notes: z.string().max(2000).optional().nullable(),
      }).safeParse(req.body ?? {});
      if (!body.success) {
        return res.status(400).json({ message: body.error.issues[0]?.message || "Invalid body" });
      }

      const project = await storage.getProject(body.data.projectId);
      if (!project || project.accountId !== accountId) return res.status(403).json({ message: "Access denied" });
      if (currentUser.role === "restricted") {
        const assigned = await getRestrictedAssignedProjectIds(currentUser.id);
        if (!assigned.has(project.id) && project.createdById !== currentUser.id) {
          return res.status(403).json({ message: "Access denied" });
        }
      }

      const existingActive = await storage.getActiveTimeEntryForUser(currentUser.id);
      if (existingActive) {
        return res.status(409).json({ message: "An active time entry already exists", entry: sanitizeTimeEntryForViewer(existingActive, currentUser) });
      }

      try {
        const entry = await storage.createTimeEntry({
          accountId,
          userId: currentUser.id,
          projectId: project.id,
          clockIn: new Date(),
          clockOut: null,
          source: "manual",
          notes: body.data.notes ?? null,
          rateCentsSnapshot: null,
        } as any);
        return res.status(201).json(sanitizeTimeEntryForViewer(entry, currentUser));
      } catch (err: any) {
        // Race: partial unique index caught a concurrent clock-in
        if (err?.code === "23505") {
          return res.status(409).json({ message: "An active time entry already exists" });
        }
        throw err;
      }
    } catch (error: any) {
      console.error("clock-in error:", error);
      res.status(500).json({ message: "Failed to clock in" });
    }
  });

  // POST /api/timesheets/clock-out
  app.post("/api/timesheets/clock-out", requireWriteAccess, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const accountId = currentUser.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });

      const body = z.object({
        notes: z.string().max(2000).optional().nullable(),
      }).safeParse(req.body ?? {});
      if (!body.success) {
        return res.status(400).json({ message: body.error.issues[0]?.message || "Invalid body" });
      }

      const active = await storage.getActiveTimeEntryForUser(currentUser.id);
      if (!active) return res.status(404).json({ message: "No active time entry" });

      const fresh = await authStorage.getUser(currentUser.id);
      const rateSnapshot = (fresh?.hourlyRateCents ?? null) as number | null;

      const newNotes = (() => {
        if (body.data.notes == null) return active.notes;
        if (!active.notes) return body.data.notes;
        return `${active.notes}\n${body.data.notes}`;
      })();

      const updated = await storage.updateTimeEntry(active.id, {
        clockOut: new Date(),
        notes: newNotes,
        rateCentsSnapshot: rateSnapshot,
        updatedAt: new Date(),
      } as any);
      if (!updated) return res.status(404).json({ message: "Entry not found" });
      res.json(sanitizeTimeEntryForViewer(updated, currentUser));
    } catch (error: any) {
      console.error("clock-out error:", error);
      res.status(500).json({ message: "Failed to clock out" });
    }
  });

  // GET /api/timesheets/active
  app.get("/api/timesheets/active", requireReadAccess, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const active = await storage.getActiveTimeEntryForUser(currentUser.id);
      if (!active) return res.json(null);
      res.json(sanitizeTimeEntryForViewer(active, currentUser));
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch active entry" });
    }
  });

  // GET /api/timesheets?startDate=&endDate=&userId=&projectId=
  app.get("/api/timesheets", requireReadAccess, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const accountId = currentUser.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });

      const q = z.object({
        startDate: z.string().min(1),
        endDate: z.string().min(1),
        userId: z.string().optional(),
        projectId: z.coerce.number().int().positive().optional(),
      }).safeParse(req.query);
      if (!q.success) {
        return res.status(400).json({ message: "startDate and endDate query params are required" });
      }
      const startDate = new Date(q.data.startDate);
      const endDate = new Date(q.data.endDate);
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        return res.status(400).json({ message: "Invalid startDate or endDate" });
      }
      if (endDate < startDate) {
        return res.status(400).json({ message: "endDate must be >= startDate" });
      }

      const isManager = isManagerRole(currentUser.role);
      // Defense-in-depth: regular users (incl. restricted) forced to self.
      const effectiveUserId = isManager ? q.data.userId : currentUser.id;

      let entries = await storage.listTimeEntries({
        accountId,
        startDate,
        endDate,
        userId: effectiveUserId,
        projectId: q.data.projectId,
      });

      // Restricted users: additionally filter to their assigned projects (defense-in-depth)
      if (currentUser.role === "restricted") {
        const assigned = await getRestrictedAssignedProjectIds(currentUser.id);
        // Also include projects they created
        const ownProjectRows = await db.select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.accountId, accountId), eq(projects.createdById, currentUser.id)));
        for (const r of ownProjectRows) assigned.add(r.id);
        entries = entries.filter(e => assigned.has(e.projectId));
      }

      const sanitized = entries.map(e => sanitizeTimeEntryForViewer(e, currentUser));
      res.json(sanitized);
    } catch (error) {
      console.error("list timesheets error:", error);
      res.status(500).json({ message: "Failed to fetch timesheets" });
    }
  });

  // GET /api/timesheets/export.csv?startDate=&endDate=&projectId=&format=&tz=
  // Manager/admin-only CSV export. Active (still-clocked-in) entries are excluded.
  app.get(
    "/api/timesheets/export.csv",
    requireReadAccess,
    requireAdminOrManager,
    async (req: any, res) => {
      try {
        const currentUser = req.user;
        const accountId = currentUser.accountId;
        if (!accountId) return res.status(403).json({ message: "No account associated" });

        const q = z
          .object({
            startDate: z.string().min(1),
            endDate: z.string().min(1),
            projectId: z.coerce.number().int().positive().optional(),
            format: z.enum(["generic", "gusto", "quickbooks"]).default("generic"),
            tz: z.string().min(1).default("UTC"),
          })
          .safeParse(req.query);
        if (!q.success) {
          return res.status(400).json({ message: "Invalid export parameters" });
        }
        const startDate = new Date(q.data.startDate);
        const endDate = new Date(q.data.endDate);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
          return res.status(400).json({ message: "Invalid startDate or endDate" });
        }
        if (endDate < startDate) {
          return res.status(400).json({ message: "endDate must be >= startDate" });
        }

        // Validate tz by attempting to construct an Intl.DateTimeFormat with it.
        let tz = q.data.tz;
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
        } catch {
          tz = "UTC";
        }

        const entries = await storage.listTimeEntries({
          accountId,
          startDate,
          endDate,
          projectId: q.data.projectId,
        });

        // Exclude active (still-clocked-in) entries silently.
        const completed = entries.filter((e) => e.clockOut != null);

        // Lookups for user + project names. We re-query within this account only.
        const accountUsers = await db
          .select()
          .from(users)
          .where(eq(users.accountId, accountId));
        const usersById = new Map(accountUsers.map((u) => [u.id, u]));

        const accountProjects = await db
          .select()
          .from(projects)
          .where(eq(projects.accountId, accountId));
        const projectsById = new Map(accountProjects.map((p) => [p.id, p]));

        const isoDateInTz = (d: Date) =>
          new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(d);
        const usDateInTz = (d: Date) =>
          new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(d);
        const isoDateTimeInTz = (d: Date) => {
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }).formatToParts(d);
          const m: Record<string, string> = {};
          for (const p of parts) m[p.type] = p.value;
          // en-CA gives 24h but hour can be "24" instead of "00" in some Node versions
          const hour = m.hour === "24" ? "00" : m.hour;
          return `${m.year}-${m.month}-${m.day} ${hour}:${m.minute}:${m.second}`;
        };

        const fmtHours = (ms: number) => (ms / 3600000).toFixed(2);
        const cents = (c: number | null | undefined) =>
          c == null ? "" : (c / 100).toFixed(2);
        const userName = (u: any) => {
          if (!u) return "";
          return `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || u.id;
        };

        let header: string[];
        let rows: unknown[][];
        const format = q.data.format;

        if (format === "gusto") {
          header = [
            "Employee First Name",
            "Employee Last Name",
            "Employee Email",
            "Work Date",
            "Hours",
            "Notes",
          ];
          rows = completed.map((e) => {
            const u = usersById.get(e.userId);
            const ms = new Date(e.clockOut as Date).getTime() - new Date(e.clockIn).getTime();
            return [
              u?.firstName || "",
              u?.lastName || "",
              u?.email || "",
              usDateInTz(new Date(e.clockIn)),
              fmtHours(ms),
              e.notes || "",
            ];
          });
        } else if (format === "quickbooks") {
          header = [
            "Employee",
            "Date",
            "Customer",
            "Hours",
            "Billable",
            "Notes",
          ];
          rows = completed.map((e) => {
            const u = usersById.get(e.userId);
            const p = projectsById.get(e.projectId);
            const ms = new Date(e.clockOut as Date).getTime() - new Date(e.clockIn).getTime();
            return [
              userName(u),
              usDateInTz(new Date(e.clockIn)),
              p?.name || `Project #${e.projectId}`,
              fmtHours(ms),
              "No",
              e.notes || "",
            ];
          });
        } else {
          // generic
          header = [
            "User Name",
            "User Email",
            "Project",
            "Work Date",
            "Clock In",
            "Clock Out",
            "Hours",
            "Rate (USD)",
            "Cost (USD)",
            "Source",
            "Notes",
          ];
          rows = completed.map((e) => {
            const u = usersById.get(e.userId);
            const p = projectsById.get(e.projectId);
            const inDate = new Date(e.clockIn);
            const outDate = new Date(e.clockOut as Date);
            const ms = outDate.getTime() - inDate.getTime();
            const hours = ms / 3600000;
            const rateCents = e.rateCentsSnapshot;
            const costCents =
              rateCents == null ? null : Math.round(hours * rateCents);
            return [
              userName(u),
              u?.email || "",
              p?.name || `Project #${e.projectId}`,
              isoDateInTz(inDate),
              isoDateTimeInTz(inDate),
              isoDateTimeInTz(outDate),
              fmtHours(ms),
              cents(rateCents),
              cents(costCents),
              e.source,
              e.notes || "",
            ];
          });
        }

        const csv = toCsv([header, ...rows]);

        const tzForFilename = tz.replace(/\//g, "-");
        const startStr = isoDateInTz(startDate);
        const endStr = isoDateInTz(endDate);
        const filename = `timesheets_${startStr}_to_${endStr}_${format}_${tzForFilename}.csv`;

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );
        res.setHeader("Cache-Control", "no-store");
        res.send(csv);
      } catch (error) {
        console.error("export timesheets csv error:", error);
        res.status(500).json({ message: "Failed to export timesheets" });
      }
    },
  );

  // POST /api/timesheets (manager-only manual create)
  app.post("/api/timesheets", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const accountId = currentUser.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });

      const body = z.object({
        userId: z.string().min(1),
        projectId: z.number().int().positive(),
        clockIn: z.coerce.date(),
        clockOut: z.coerce.date(),
        notes: z.string().max(2000).optional().nullable(),
      }).safeParse(req.body ?? {});
      if (!body.success) {
        return res.status(400).json({ message: body.error.issues[0]?.message || "Invalid body" });
      }
      if (body.data.clockOut <= body.data.clockIn) {
        return res.status(400).json({ message: "clockOut must be greater than clockIn" });
      }

      const targetUser = await authStorage.getUser(body.data.userId);
      if (!targetUser || targetUser.accountId !== accountId) {
        return res.status(403).json({ message: "Access denied" });
      }
      const project = await storage.getProject(body.data.projectId);
      if (!project || project.accountId !== accountId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Overlap check (boundary-touch allowed). Race window is intentional —
      // managers are low-concurrency. We log so we can monitor for actual races.
      const conflict = await storage.hasOverlappingEntry({
        accountId,
        userId: body.data.userId,
        start: body.data.clockIn,
        end: body.data.clockOut,
      });
      if (conflict) {
        console.warn("[timesheets] overlap detected", {
          accountId,
          userId: body.data.userId,
          attemptedStart: body.data.clockIn.toISOString(),
          attemptedEnd: body.data.clockOut.toISOString(),
          conflictingEntryId: conflict.id,
        });
        return res.status(409).json({
          error: "overlap",
          message: "This entry overlaps with an existing entry for this user.",
          conflictingEntryId: conflict.id,
        });
      }

      const created = await storage.createTimeEntry({
        accountId,
        userId: body.data.userId,
        projectId: body.data.projectId,
        clockIn: body.data.clockIn,
        clockOut: body.data.clockOut,
        source: "manual",
        notes: body.data.notes ?? null,
        rateCentsSnapshot: targetUser.hourlyRateCents ?? null,
      } as any);
      res.status(201).json(sanitizeTimeEntryForViewer(created, currentUser));
    } catch (error: any) {
      console.error("manager create timesheet error:", error);
      res.status(500).json({ message: "Failed to create time entry" });
    }
  });

  // PATCH /api/timesheets/:id (manager-only)
  app.patch("/api/timesheets/:id", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const accountId = currentUser.accountId;
      const id = req.params.id;

      const existing = await storage.getTimeEntry(id);
      if (!existing) return res.status(404).json({ message: "Entry not found" });
      if (existing.accountId !== accountId) return res.status(403).json({ message: "Access denied" });

      const body = z.object({
        clockIn: z.coerce.date().optional(),
        clockOut: z.coerce.date().nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
        projectId: z.number().int().positive().optional(),
        rateCentsSnapshot: z.number().int().nonnegative().nullable().optional(),
      }).safeParse(req.body ?? {});
      if (!body.success) {
        return res.status(400).json({ message: body.error.issues[0]?.message || "Invalid body" });
      }

      const nextClockIn = body.data.clockIn ?? existing.clockIn;
      const nextClockOut = "clockOut" in body.data ? body.data.clockOut : existing.clockOut;
      if (nextClockIn && nextClockOut && nextClockOut <= nextClockIn) {
        return res.status(400).json({ message: "clockOut must be greater than clockIn" });
      }

      if (body.data.projectId !== undefined) {
        const project = await storage.getProject(body.data.projectId);
        if (!project || project.accountId !== accountId) return res.status(403).json({ message: "Access denied" });
      }

      // Overlap check on edit (only when timing actually changes — same predicate as POST,
      // but excluding the entry being edited). Skip for active entries (clockOut still null
      // after the edit) since the partial unique index already protects that case.
      if (
        nextClockOut &&
        (body.data.clockIn !== undefined || "clockOut" in body.data)
      ) {
        const conflict = await storage.hasOverlappingEntry({
          accountId,
          userId: existing.userId,
          start: nextClockIn,
          end: nextClockOut,
          excludeEntryId: id,
        });
        if (conflict) {
          console.warn("[timesheets] overlap detected", {
            accountId,
            userId: existing.userId,
            attemptedStart: nextClockIn.toISOString(),
            attemptedEnd: nextClockOut.toISOString(),
            conflictingEntryId: conflict.id,
          });
          return res.status(409).json({
            error: "overlap",
            message: "This entry overlaps with an existing entry for this user.",
            conflictingEntryId: conflict.id,
          });
        }
      }

      const updates: any = { updatedAt: new Date() };
      if (body.data.clockIn !== undefined) updates.clockIn = body.data.clockIn;
      if ("clockOut" in body.data) updates.clockOut = body.data.clockOut;
      if ("notes" in body.data) updates.notes = body.data.notes;
      if (body.data.projectId !== undefined) updates.projectId = body.data.projectId;
      if ("rateCentsSnapshot" in body.data) updates.rateCentsSnapshot = body.data.rateCentsSnapshot;

      // Audit: snapshot original times on first edit
      if (existing.editedAt === null) {
        updates.originalClockIn = existing.clockIn;
        updates.originalClockOut = existing.clockOut;
      }
      updates.editedByUserId = currentUser.id;
      updates.editedAt = new Date();
      if (existing.source !== "edited") updates.source = "edited";

      const updated = await storage.updateTimeEntry(id, updates);
      if (!updated) return res.status(404).json({ message: "Entry not found" });
      res.json(sanitizeTimeEntryForViewer(updated, currentUser));
    } catch (error: any) {
      console.error("patch timesheet error:", error);
      res.status(500).json({ message: "Failed to update time entry" });
    }
  });

  // DELETE /api/timesheets/:id (manager-only, hard delete)
  app.delete("/api/timesheets/:id", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const id = req.params.id;
      if (!(await verifyTimeEntryAccess(id, currentUser.accountId))) {
        return res.status(404).json({ message: "Entry not found" });
      }
      await storage.deleteTimeEntry(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete time entry" });
    }
  });

  // Checklist Templates
  app.get("/api/checklist-templates", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const templates = await storage.getAllChecklistTemplates(accountId);
      res.json(templates);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch checklist templates" });
    }
  });

  app.get("/api/checklist-templates/:id/items", requireReadAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const template = await storage.getChecklistTemplate(id);
      if (!template || template.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      const items = await storage.getChecklistTemplateItems(id);
      res.json(items);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch template items" });
    }
  });

  app.post("/api/checklist-templates", requireWriteAccess, async (req: any, res) => {
    try {
      const parsed = insertChecklistTemplateSchema.safeParse({
        title: req.body.title,
        description: req.body.description || null,
        accountId: req.user.accountId,
        createdById: req.user.id,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const template = await storage.createChecklistTemplate(parsed.data);
      if (req.body.items && Array.isArray(req.body.items)) {
        for (let i = 0; i < req.body.items.length; i++) {
          if (req.body.items[i].trim()) {
            await storage.createChecklistTemplateItem({
              templateId: template.id,
              label: req.body.items[i],
              sortOrder: i,
            });
          }
        }
      }
      const items = await storage.getChecklistTemplateItems(template.id);
      res.status(201).json({ ...template, items, itemCount: items.length });
    } catch (error) {
      res.status(500).json({ message: "Failed to create checklist template" });
    }
  });

  app.delete("/api/checklist-templates/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const template = await storage.getChecklistTemplate(id);
      if (!template || template.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      await storage.deleteChecklistTemplate(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete checklist template" });
    }
  });

  // Report Templates
  app.get("/api/report-templates", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const templates = await storage.getAllReportTemplates(accountId);
      res.json(templates);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch report templates" });
    }
  });

  app.post("/api/report-templates", requireWriteAccess, async (req: any, res) => {
    try {
      const parsed = insertReportTemplateSchema.safeParse({
        title: req.body.title,
        type: req.body.type || "inspection",
        content: req.body.content || null,
        findings: req.body.findings || null,
        recommendations: req.body.recommendations || null,
        accountId: req.user.accountId,
        createdById: req.user.id,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const template = await storage.createReportTemplate(parsed.data);
      res.status(201).json(template);
    } catch (error) {
      res.status(500).json({ message: "Failed to create report template" });
    }
  });

  app.delete("/api/report-templates/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const template = await storage.getReportTemplate(id);
      if (!template || template.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      await storage.deleteReportTemplate(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete report template" });
    }
  });

  app.post("/api/galleries", requireWriteAccess, async (req: any, res) => {
    try {
      const { projectId, mediaIds, includeMetadata, includeDescriptions } = req.body;
      if (!projectId || !Array.isArray(mediaIds) || mediaIds.length === 0) {
        return res.status(400).json({ message: "projectId and mediaIds are required" });
      }
      if (!(await verifyProjectAccess(projectId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const token = crypto.randomBytes(12).toString("base64url");
      const gallery = await storage.createSharedGallery({
        token,
        projectId,
        mediaIds,
        includeMetadata: includeMetadata || false,
        includeDescriptions: includeDescriptions || false,
        createdById: req.user!.id,
      });
      res.status(201).json(gallery);
    } catch (error) {
      res.status(500).json({ message: "Failed to create gallery" });
    }
  });

  app.get("/api/galleries/:token", async (req, res) => {
    try {
      const gallery = await storage.getSharedGalleryByToken(req.params.token);
      if (!gallery) {
        return res.status(404).json({ message: "Gallery not found" });
      }
      const project = await storage.getProject(gallery.projectId);
      const allMedia = await presignMediaUrls(await storage.getMediaByProject(gallery.projectId));
      const galleryMedia = allMedia.filter(m => gallery.mediaIds.includes(m.id));
      res.json({
        token: gallery.token,
        projectName: project?.name || "Project",
        projectAddress: project?.address || "",
        includeMetadata: gallery.includeMetadata,
        includeDescriptions: gallery.includeDescriptions,
        createdAt: gallery.createdAt,
        photos: galleryMedia.map(m => ({
          id: m.id,
          url: m.url,
          caption: gallery.includeDescriptions ? m.caption : null,
          createdAt: gallery.includeMetadata ? m.createdAt : null,
          uploadedBy: gallery.includeMetadata && m.uploadedBy ? {
            firstName: m.uploadedBy.firstName,
            lastName: m.uploadedBy.lastName,
          } : null,
          latitude: gallery.includeMetadata ? m.latitude : null,
          longitude: gallery.includeMetadata ? m.longitude : null,
        })),
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch gallery" });
    }
  });

  app.get("/api/activity", requireReadAccess, async (req: any, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });

      const recentMedia = await db
        .select({
          id: media.id,
          url: media.url,
          caption: media.caption,
          originalName: media.originalName,
          projectId: media.projectId,
          createdAt: media.createdAt,
          uploaderFirst: users.firstName,
          uploaderLast: users.lastName,
          uploaderImage: users.profileImageUrl,
          projectName: projects.name,
        })
        .from(media)
        .innerJoin(projects, eq(media.projectId, projects.id))
        .leftJoin(users, eq(media.uploadedById, users.id))
        .where(eq(projects.accountId, accountId))
        .orderBy(sql`${media.createdAt} DESC`)
        .limit(limit);

      const recentTasks = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          projectId: tasks.projectId,
          dueDate: tasks.dueDate,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
          creatorFirst: users.firstName,
          creatorLast: users.lastName,
          creatorImage: users.profileImageUrl,
          projectName: projects.name,
        })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .leftJoin(users, eq(tasks.createdById, users.id))
        .where(eq(projects.accountId, accountId))
        .orderBy(sql`${tasks.updatedAt} DESC`)
        .limit(limit);

      const recentComments = await db
        .select({
          id: comments.id,
          content: comments.content,
          mediaId: comments.mediaId,
          createdAt: comments.createdAt,
          userFirst: users.firstName,
          userLast: users.lastName,
          userImage: users.profileImageUrl,
        })
        .from(comments)
        .innerJoin(media, eq(comments.mediaId, media.id))
        .innerJoin(projects, eq(media.projectId, projects.id))
        .leftJoin(users, eq(comments.userId, users.id))
        .where(eq(projects.accountId, accountId))
        .orderBy(sql`${comments.createdAt} DESC`)
        .limit(limit);

      type ActivityItem = {
        type: "photo" | "task" | "comment";
        id: number;
        timestamp: string;
        userName: string;
        userImage: string | null;
        projectName: string | null;
        projectId: number | null;
        detail: string;
        extra?: Record<string, unknown>;
      };

      const activities: ActivityItem[] = [];

      for (const m of recentMedia) {
        let photoUrl = m.url;
        if (isS3Url(photoUrl)) {
          const key = extractS3KeyFromUrl(photoUrl);
          if (key) photoUrl = await getPresignedUrl(key);
        }
        activities.push({
          type: "photo",
          id: m.id,
          timestamp: new Date(m.createdAt).toISOString(),
          userName: [m.uploaderFirst, m.uploaderLast].filter(Boolean).join(" ") || "Unknown",
          userImage: m.uploaderImage,
          projectName: m.projectName,
          projectId: m.projectId,
          detail: m.caption || m.originalName,
          extra: { url: photoUrl },
        });
      }

      for (const t of recentTasks) {
        activities.push({
          type: "task",
          id: t.id,
          timestamp: new Date(t.updatedAt).toISOString(),
          userName: [t.creatorFirst, t.creatorLast].filter(Boolean).join(" ") || "Unknown",
          userImage: t.creatorImage,
          projectName: t.projectName,
          projectId: t.projectId,
          detail: t.title,
          extra: { status: t.status, priority: t.priority, dueDate: t.dueDate ? new Date(t.dueDate).toISOString() : null },
        });
      }

      for (const c of recentComments) {
        activities.push({
          type: "comment",
          id: c.id,
          timestamp: new Date(c.createdAt).toISOString(),
          userName: [c.userFirst, c.userLast].filter(Boolean).join(" ") || "Unknown",
          userImage: c.userImage,
          projectName: null,
          projectId: null,
          detail: c.content,
          extra: { mediaId: c.mediaId },
        });
      }

      activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const activeProjectCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(projects)
        .where(and(eq(projects.status, "active"), eq(projects.accountId, accountId)));
      const openTaskCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(and(sql`${tasks.status} != 'done'`, eq(projects.accountId, accountId)));
      const overdueTaskCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(and(sql`${tasks.status} != 'done' AND ${tasks.dueDate} IS NOT NULL AND ${tasks.dueDate} < NOW()`, eq(projects.accountId, accountId)));
      const totalMediaCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(media)
        .innerJoin(projects, eq(media.projectId, projects.id))
        .where(eq(projects.accountId, accountId));

      res.json({
        activities: activities.slice(0, limit),
        stats: {
          activeProjects: Number(activeProjectCount[0]?.count || 0),
          totalPhotos: Number(totalMediaCount[0]?.count || 0),
          openTasks: Number(openTaskCount[0]?.count || 0),
          overdueTasks: Number(overdueTaskCount[0]?.count || 0),
        },
      });
    } catch (error) {
      console.error("Activity feed error:", error);
      res.status(500).json({ message: "Failed to fetch activity" });
    }
  });

  app.get("/api/projects/:id/daily-log", requireReadAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const dateStr = (req.query.date as string) || new Date().toISOString().split("T")[0];
      const dayStart = new Date(dateStr + "T00:00:00.000Z");
      const dayEnd = new Date(dateStr + "T23:59:59.999Z");

      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });

      const dayMedia = await db
        .select({
          id: media.id,
          url: media.url,
          caption: media.caption,
          originalName: media.originalName,
          createdAt: media.createdAt,
          uploaderFirst: users.firstName,
          uploaderLast: users.lastName,
        })
        .from(media)
        .leftJoin(users, eq(media.uploadedById, users.id))
        .where(sql`${media.projectId} = ${projectId} AND ${media.createdAt} >= ${dayStart} AND ${media.createdAt} <= ${dayEnd}`)
        .orderBy(sql`${media.createdAt} ASC`);

      const dayTasks = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          status: tasks.status,
          priority: tasks.priority,
          updatedAt: tasks.updatedAt,
          assigneeFirst: users.firstName,
          assigneeLast: users.lastName,
        })
        .from(tasks)
        .leftJoin(users, eq(tasks.assignedToId, users.id))
        .where(sql`${tasks.projectId} = ${projectId} AND (${tasks.createdAt} >= ${dayStart} AND ${tasks.createdAt} <= ${dayEnd} OR ${tasks.updatedAt} >= ${dayStart} AND ${tasks.updatedAt} <= ${dayEnd})`);

      const dayComments = await db
        .select({
          id: comments.id,
          content: comments.content,
          createdAt: comments.createdAt,
          userFirst: users.firstName,
          userLast: users.lastName,
        })
        .from(comments)
        .leftJoin(users, eq(comments.userId, users.id))
        .leftJoin(media, eq(comments.mediaId, media.id))
        .where(sql`${media.projectId} = ${projectId} AND ${comments.createdAt} >= ${dayStart} AND ${comments.createdAt} <= ${dayEnd}`)
        .orderBy(sql`${comments.createdAt} ASC`);

      const uniqueUsers = new Set<string>();
      dayMedia.forEach((m) => { if (m.uploaderFirst) uniqueUsers.add([m.uploaderFirst, m.uploaderLast].filter(Boolean).join(" ")); });
      dayTasks.forEach((t) => { if (t.assigneeFirst) uniqueUsers.add([t.assigneeFirst, t.assigneeLast].filter(Boolean).join(" ")); });
      dayComments.forEach((c) => { if (c.userFirst) uniqueUsers.add([c.userFirst, c.userLast].filter(Boolean).join(" ")); });

      const completedTasks = dayTasks.filter((t) => t.status === "done");
      const inProgressTasks = dayTasks.filter((t) => t.status === "in_progress");
      const newTasks = dayTasks.filter((t) => t.status === "todo");

      res.json({
        date: dateStr,
        project: { id: project.id, name: project.name, address: project.address },
        summary: {
          photosUploaded: dayMedia.length,
          tasksCompleted: completedTasks.length,
          tasksInProgress: inProgressTasks.length,
          tasksCreated: newTasks.length,
          commentsAdded: dayComments.length,
          activeTeamMembers: uniqueUsers.size,
          teamMembers: Array.from(uniqueUsers),
        },
        photos: await Promise.all(dayMedia.map(async (m) => {
          let photoUrl = m.url;
          if (isS3Url(photoUrl)) {
            const key = extractS3KeyFromUrl(photoUrl);
            if (key) photoUrl = await getPresignedUrl(key);
          }
          return {
            id: m.id,
            url: photoUrl,
            caption: m.caption,
            originalName: m.originalName,
            uploadedBy: [m.uploaderFirst, m.uploaderLast].filter(Boolean).join(" "),
            time: new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
          };
        })),
        tasks: dayTasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          assignedTo: [t.assigneeFirst, t.assigneeLast].filter(Boolean).join(" ") || null,
        })),
        comments: dayComments.map((c) => ({
          id: c.id,
          content: c.content,
          by: [c.userFirst, c.userLast].filter(Boolean).join(" "),
          time: new Date(c.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }),
        })),
      });
    } catch (error) {
      console.error("Daily log error:", error);
      res.status(500).json({ message: "Failed to fetch daily log" });
    }
  });

  app.get("/api/analytics", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const { from, to } = req.query;
      const fromDate = from ? new Date(from as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const toDate = to ? new Date(to as string) : new Date();

      const allMedia = await db
        .select({
          id: media.id,
          createdAt: media.createdAt,
          uploadedById: media.uploadedById,
          projectId: media.projectId,
          latitude: media.latitude,
          longitude: media.longitude,
          uploaderFirst: users.firstName,
          uploaderLast: users.lastName,
        })
        .from(media)
        .innerJoin(projects, eq(media.projectId, projects.id))
        .leftJoin(users, eq(media.uploadedById, users.id))
        .where(eq(projects.accountId, accountId));

      const filteredMedia = allMedia.filter((m) => {
        const d = new Date(m.createdAt);
        return d >= fromDate && d <= toDate;
      });

      const photosByUser: Record<string, { name: string; count: number }> = {};
      for (const m of filteredMedia) {
        const key = m.uploadedById || "unknown";
        if (!photosByUser[key]) {
          photosByUser[key] = {
            name: m.uploaderFirst && m.uploaderLast
              ? `${m.uploaderFirst} ${m.uploaderLast}`
              : m.uploaderFirst || "Unknown",
            count: 0,
          };
        }
        photosByUser[key].count++;
      }

      const photosByDay: Record<string, number> = {};
      for (const m of filteredMedia) {
        const day = new Date(m.createdAt).toISOString().split("T")[0];
        photosByDay[day] = (photosByDay[day] || 0) + 1;
      }
      const sortedDays = Object.keys(photosByDay).sort();
      const photosOverTime = sortedDays.map((d) => ({ date: d, count: photosByDay[d] }));

      const photoLocations = filteredMedia
        .filter((m) => m.latitude && m.longitude)
        .map((m) => ({
          id: m.id,
          latitude: m.latitude,
          longitude: m.longitude,
          projectId: m.projectId,
        }));

      const photosByProject: Record<number, { name: string; count: number }> = {};
      const allProjects = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.accountId, accountId));
      const projectMap = Object.fromEntries(allProjects.map((p) => [p.id, p.name]));
      for (const m of filteredMedia) {
        if (!photosByProject[m.projectId]) {
          photosByProject[m.projectId] = { name: projectMap[m.projectId] || `Project ${m.projectId}`, count: 0 };
        }
        photosByProject[m.projectId].count++;
      }

      const allTasks = await db
        .select({ id: tasks.id, status: tasks.status, projectId: tasks.projectId, createdAt: tasks.createdAt })
        .from(tasks)
        .innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(eq(projects.accountId, accountId));
      const filteredTasks = allTasks.filter((t) => {
        const d = new Date(t.createdAt);
        return d >= fromDate && d <= toDate;
      });
      const tasksByStatus: Record<string, number> = {};
      for (const t of filteredTasks) {
        tasksByStatus[t.status] = (tasksByStatus[t.status] || 0) + 1;
      }

      const allChecklistRows = await db
        .select({ id: checklists.id, projectId: checklists.projectId, createdAt: checklists.createdAt })
        .from(checklists)
        .innerJoin(projects, eq(checklists.projectId, projects.id))
        .where(eq(projects.accountId, accountId));
      const filteredChecklists = allChecklistRows.filter((c) => {
        const d = new Date(c.createdAt);
        return d >= fromDate && d <= toDate;
      });

      const allReportRows = await db
        .select({ id: reports.id, projectId: reports.projectId, createdAt: reports.createdAt })
        .from(reports)
        .innerJoin(projects, eq(reports.projectId, projects.id))
        .where(eq(projects.accountId, accountId));
      const filteredReports = allReportRows.filter((r) => {
        const d = new Date(r.createdAt);
        return d >= fromDate && d <= toDate;
      });

      const allCommentRows = await db
        .select({ id: comments.id, createdAt: comments.createdAt })
        .from(comments)
        .innerJoin(media, eq(comments.mediaId, media.id))
        .innerJoin(projects, eq(media.projectId, projects.id))
        .where(eq(projects.accountId, accountId));
      const filteredComments = allCommentRows.filter((c) => {
        const d = new Date(c.createdAt);
        return d >= fromDate && d <= toDate;
      });

      res.json({
        totalPhotos: filteredMedia.length,
        totalProjects: allProjects.length,
        totalTasks: filteredTasks.length,
        totalChecklists: filteredChecklists.length,
        totalReports: filteredReports.length,
        totalComments: filteredComments.length,
        activeUsers: Object.keys(photosByUser).length,
        photosByUser: Object.values(photosByUser).sort((a, b) => b.count - a.count),
        photosOverTime,
        photoLocations,
        photosByProject: Object.values(photosByProject).sort((a, b) => b.count - a.count),
        tasksByStatus,
      });
    } catch (error) {
      console.error("Analytics error:", error);
      res.status(500).json({ message: "Failed to fetch analytics" });
    }
  });

  app.get("/api/stripe/publishable-key", isAuthenticated, async (_req, res) => {
    try {
      const key = await getStripePublishableKey();
      res.json({ publishableKey: key });
    } catch (error) {
      console.error("Error fetching publishable key:", error);
      res.status(500).json({ message: "Failed to fetch Stripe config" });
    }
  });

  app.get("/api/subscription", isAuthenticated, async (req: any, res) => {
    try {
      const billing = await getAccountBilling(req);
      console.log("[billing-source]", JSON.stringify({
        userId: req.user.id,
        accountId: req.user.accountId,
        source: billing.source,
        flagEnabled: isAccountBillingEnabled(),
      }));

      res.json({
        subscriptionStatus: billing.subscriptionStatus || "none",
        stripeSubscriptionId: billing.stripeSubscriptionId,
        trialEndsAt: billing.trialEndsAt,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch subscription" });
    }
  });

  app.post("/api/create-checkout-session", isAuthenticated, async (req: any, res) => {
    try {
      const { lineItems, priceId } = req.body;

      let stripeLineItems: { price: string; quantity: number }[];

      if (lineItems && Array.isArray(lineItems) && lineItems.length > 0) {
        stripeLineItems = lineItems.map((item: any) => ({
          price: item.priceId,
          quantity: item.quantity || 1,
        }));
      } else if (priceId) {
        stripeLineItems = [{ price: priceId, quantity: 1 }];
      } else {
        return res.status(400).json({ message: "Price ID or line items required" });
      }

      const stripe = await getUncachableStripeClient();
      const user = await authStorage.getUser(req.user.id);
      if (!user) return res.status(404).json({ message: "User not found" });

      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email || undefined,
          name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
          metadata: { userId: user.id },
        });
        customerId = customer.id;
        await authStorage.updateUser(user.id, { stripeCustomerId: customerId });
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const hasSubscription = user.subscriptionStatus === "active" || user.stripeSubscriptionId;
      const sessionConfig: any = {
        customer: customerId,
        mode: "subscription",
        line_items: stripeLineItems,
        success_url: `${baseUrl}/?checkout=success`,
        cancel_url: `${baseUrl}/?checkout=canceled`,
        payment_method_collection: "always",
        allow_promotion_codes: true,
      };
      if (!hasSubscription) {
        sessionConfig.subscription_data = {
          trial_period_days: 14,
        };
      }
      const session = await stripe.checkout.sessions.create(sessionConfig);

      res.json({ url: session.url });
    } catch (error: any) {
      console.error("Checkout session error:", error);
      res.status(500).json({ message: error.message || "Failed to create checkout session" });
    }
  });

  app.post("/api/confirm-checkout", isAuthenticated, async (req: any, res) => {
    try {
      const user = await authStorage.getUser(req.user.id);
      if (!user?.stripeCustomerId) {
        return res.status(400).json({ message: "No billing account found" });
      }

      const stripe = await getUncachableStripeClient();
      const subscriptions = await stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        limit: 1,
        status: "all",
      });

      if (subscriptions.data.length > 0) {
        const sub = subscriptions.data[0];
        let appStatus = "none";
        if (sub.status === "active") appStatus = "active";
        else if (sub.status === "trialing") appStatus = "trialing";
        else if (sub.status === "past_due") appStatus = "past_due";
        else if (sub.status === "canceled" || sub.status === "unpaid") appStatus = "canceled";

        await authStorage.updateUser(user.id, {
          stripeSubscriptionId: sub.id,
          subscriptionStatus: appStatus,
        });

        const updatedUser = await authStorage.getUser(user.id);
        const { password: _, ...safeUser } = updatedUser!;
        const safeUserWithBilling = await overlayAccountBillingOnUser(safeUser, req);
        return res.json(sanitizeUserForViewer(safeUserWithBilling, req.user));
      }

      return res.json({ message: "No subscription found" });
    } catch (error: any) {
      console.error("Confirm checkout error:", error);
      res.status(500).json({ message: "Failed to confirm checkout" });
    }
  });

  app.post("/api/create-portal-session", isAuthenticated, async (req: any, res) => {
    try {
      const user = await authStorage.getUser(req.user.id);
      if (!user?.stripeCustomerId) {
        return res.status(400).json({ message: "No billing account found" });
      }

      const stripe = await getUncachableStripeClient();
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${baseUrl}/settings`,
      });

      res.json({ url: session.url });
    } catch (error: any) {
      console.error("Portal session error:", error);
      res.status(500).json({ message: "Failed to create billing portal session" });
    }
  });

  app.get("/api/stripe/prices", isAuthenticated, async (_req, res) => {
    try {
      const stripe = await getUncachableStripeClient();
      const products = await stripe.products.list({ active: true, limit: 100 });
      const prices = await stripe.prices.list({ active: true, limit: 100, expand: ["data.product"] });

      const rows = prices.data
        .filter((price) => {
          const product = typeof price.product === "string"
            ? products.data.find((p) => p.id === price.product)
            : price.product;
          return product && (product as any).active;
        })
        .map((price) => {
          const product = typeof price.product === "string"
            ? products.data.find((p) => p.id === price.product)
            : price.product as any;
          return {
            product_id: product?.id || "",
            product_name: product?.name || "",
            description: product?.description || "",
            metadata: product?.metadata || {},
            price_id: price.id,
            unit_amount: price.unit_amount,
            currency: price.currency,
            recurring_interval: price.recurring?.interval || null,
            recurring_interval_count: price.recurring?.interval_count || null,
            price_active: price.active,
          };
        })
        .sort((a, b) => (a.unit_amount || 0) - (b.unit_amount || 0));

      res.json(rows);
    } catch (error: any) {
      console.error("Error fetching prices:", error.message);
      res.status(500).json({ message: "Failed to fetch prices" });
    }
  });

  return httpServer;
}
