import express, { type Express } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes, isAuthenticated, requireActiveSubscription } from "./replit_integrations/auth";
import { authStorage } from "./replit_integrations/auth/storage";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import multer from "multer";
import path from "path";
import fs from "fs";
import { insertProjectSchema, insertCommentSchema, insertTaskSchema, insertChecklistSchema, insertChecklistItemSchema, insertReportSchema, insertChecklistTemplateSchema, insertChecklistTemplateItemSchema, insertReportTemplateSchema, projects, media, comments, tasks, checklists, reports, projectAssignments } from "@shared/schema";
import { users, invitations } from "@shared/models/auth";
import { db } from "./db";
import { eq, sql, and, or, inArray } from "drizzle-orm";
import { uploadToS3, getPresignedUrl, isS3Url, extractS3KeyFromUrl } from "./s3";

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

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi|heic/;
    const ext = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mime = allowedTypes.test(file.mimetype.split("/")[1]) || file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/");
    cb(null, ext || mime);
  },
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);

  app.use("/uploads", (req, res, next) => {
    res.setHeader("Cache-Control", "public, max-age=31536000");
    next();
  }, express.static(uploadDir));

  app.get("/api/config/maps", requireActiveSubscription, (_req, res) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ message: "Google Maps API key not configured" });
    }
    res.json({ apiKey });
  });

  app.get("/api/projects", requireActiveSubscription, async (req: any, res) => {
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

  app.get("/api/projects/:id", requireActiveSubscription, async (req: any, res) => {
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

  app.post("/api/projects", requireActiveSubscription, async (req: any, res) => {
    try {
      const parsed = insertProjectSchema.safeParse({
        ...req.body,
        accountId: req.user.accountId,
        createdById: req.user.id,
      });
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const project = await storage.createProject(parsed.data);
      res.status(201).json(project);
    } catch (error) {
      res.status(500).json({ message: "Failed to create project" });
    }
  });

  app.patch("/api/projects/:id", requireActiveSubscription, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      const allowed = ["name", "description", "status", "address", "latitude", "longitude", "color", "coverPhotoId"];
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

  app.delete("/api/projects/:id", requireActiveSubscription, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      await storage.deleteProject(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete project" });
    }
  });

  app.post("/api/projects/:id/media", requireActiveSubscription, upload.array("files", 20), async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ message: "No files uploaded" });
      }

      const caption = req.body.caption || null;
      const tags = req.body.tags ? req.body.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [];

      const created = await Promise.all(
        files.map(async (file) => {
          const { url, key } = await uploadToS3(file.buffer, file.originalname, file.mimetype);
          return storage.createMedia({
            projectId,
            uploadedById: req.user.id,
            filename: key,
            originalName: file.originalname,
            mimeType: file.mimetype,
            url,
            caption,
            tags,
            latitude: req.body.latitude ? parseFloat(req.body.latitude) : null,
            longitude: req.body.longitude ? parseFloat(req.body.longitude) : null,
          });
        })
      );

      res.status(201).json(await presignMediaUrls(created));
    } catch (error: any) {
      console.error("Upload error:", error?.message || error);
      res.status(500).json({ message: "Failed to upload media" });
    }
  });

  app.get("/api/tasks", requireActiveSubscription, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const allTasks = await storage.getAllTasks(accountId);
      res.json(allTasks);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch tasks" });
    }
  });

  app.get("/api/media", requireActiveSubscription, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const allMedia = await presignMediaUrls(await storage.getAllMedia(accountId));
      res.json(allMedia);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch media" });
    }
  });

  app.get("/api/media/:id/comments", requireActiveSubscription, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.id as string);
      if (!(await verifyMediaAccess(mediaId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const mediaComments = await storage.getCommentsByMedia(mediaId);
      res.json(mediaComments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  });

  app.post("/api/media/:id/comments", requireActiveSubscription, async (req: any, res) => {
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

  app.post("/api/projects/:id/tasks", requireActiveSubscription, async (req: any, res) => {
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

  app.patch("/api/tasks/:id", requireActiveSubscription, async (req: any, res) => {
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
  app.get("/api/checklists", requireActiveSubscription, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const allChecklists = await storage.getAllChecklists(accountId);
      res.json(allChecklists);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch checklists" });
    }
  });

  app.post("/api/projects/:id/checklists", requireActiveSubscription, async (req: any, res) => {
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

  app.patch("/api/checklists/:id", requireActiveSubscription, async (req: any, res) => {
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

  app.delete("/api/checklists/:id", requireActiveSubscription, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      await storage.deleteChecklist(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete checklist" });
    }
  });

  app.get("/api/checklists/:id/items", requireActiveSubscription, async (req: any, res) => {
    try {
      const checklistId = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const items = await storage.getChecklistItems(checklistId);
      res.json(items);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch checklist items" });
    }
  });

  app.post("/api/checklists/:id/items", requireActiveSubscription, async (req: any, res) => {
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

  app.patch("/api/checklist-items/:id", requireActiveSubscription, async (req: any, res) => {
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

  app.delete("/api/checklist-items/:id", requireActiveSubscription, async (req: any, res) => {
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
  app.get("/api/reports", requireActiveSubscription, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const allReports = await storage.getAllReports(accountId);
      res.json(allReports);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch reports" });
    }
  });

  app.post("/api/projects/:id/reports", requireActiveSubscription, async (req: any, res) => {
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

  app.patch("/api/reports/:id", requireActiveSubscription, async (req: any, res) => {
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

  app.delete("/api/reports/:id", requireActiveSubscription, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyReportAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      await storage.deleteReport(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete report" });
    }
  });

  app.get("/api/users", requireActiveSubscription, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const usersList = await storage.getUsers(accountId);
      const safeUsers = usersList.map(({ password, ...rest }) => rest);
      res.json(safeUsers);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // Invitations
  app.get("/api/invitations", requireActiveSubscription, async (req: any, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role !== "admin" && currentUser.role !== "manager") {
        return res.status(403).json({ message: "Only admins and managers can view invitations" });
      }
      const accountId = currentUser.accountId;
      const result = await db.select({
        id: invitations.id,
        email: invitations.email,
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

  app.post("/api/invitations", requireActiveSubscription, async (req: any, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role !== "admin" && currentUser.role !== "manager") {
        return res.status(403).json({ message: "Only admins and managers can invite users" });
      }
      const { email, role } = req.body;
      if (!email) return res.status(400).json({ message: "Email is required" });
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

      res.status(201).json({ ...invitation, inviteLink });
    } catch (error) {
      console.error("Create invitation error:", error);
      res.status(500).json({ message: "Failed to create invitation" });
    }
  });

  app.delete("/api/invitations/:id", requireActiveSubscription, async (req: any, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role !== "admin" && currentUser.role !== "manager") {
        return res.status(403).json({ message: "Only admins and managers can cancel invitations" });
      }
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

  app.delete("/api/users/:userId", requireActiveSubscription, async (req: any, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role !== "admin" && currentUser.role !== "manager") {
        return res.status(403).json({ message: "Only admins and managers can remove users" });
      }
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
  app.get("/api/projects/:id/assignments", requireActiveSubscription, async (req: any, res) => {
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

  app.post("/api/projects/:id/assignments", requireActiveSubscription, async (req: any, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role !== "admin" && currentUser.role !== "manager") {
        return res.status(403).json({ message: "Only admins and managers can assign users to projects" });
      }
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

  app.delete("/api/projects/:id/assignments/:userId", requireActiveSubscription, async (req: any, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role !== "admin" && currentUser.role !== "manager") {
        return res.status(403).json({ message: "Only admins and managers can remove project assignments" });
      }
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

  app.post("/api/admin/setup-account", async (req, res) => {
    try {
      const { email, password, setupKey } = req.body;
      if (setupKey !== process.env.SESSION_SECRET) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if (!email) {
        return res.status(400).json({ message: "Email required" });
      }
      const updates: any = { subscriptionStatus: "active", role: "admin" };
      if (password) {
        const bcrypt = await import("bcryptjs");
        updates.password = await bcrypt.default.hash(password, 12);
      }
      const updated = await db.update(users)
        .set(updates)
        .where(eq(users.email, email))
        .returning();
      if (updated.length === 0) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safeUser } = updated[0];
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ message: "Setup failed" });
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
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ message: "Failed to update subscription" });
    }
  });

  app.patch("/api/users/:userId/role", requireActiveSubscription, async (req: any, res) => {
    try {
      const currentUser = req.user;
      if (currentUser.role !== "admin") {
        return res.status(403).json({ message: "Only admins can change roles" });
      }
      const { userId } = req.params;
      const targetUser = await authStorage.getUser(userId);
      if (!targetUser) return res.status(404).json({ message: "User not found" });
      if (targetUser.accountId !== currentUser.accountId) return res.status(403).json({ message: "Access denied" });
      const { role } = req.body;
      const validRoles = ["admin", "manager", "standard", "restricted"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }
      const updated = await db.update(users).set({ role }).where(eq(users.id, userId)).returning();
      if (updated.length === 0) return res.status(404).json({ message: "User not found" });
      const { password: _, ...safeUser } = updated[0];
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ message: "Failed to update role" });
    }
  });

  // Checklist Templates
  app.get("/api/checklist-templates", requireActiveSubscription, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const templates = await storage.getAllChecklistTemplates(accountId);
      res.json(templates);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch checklist templates" });
    }
  });

  app.get("/api/checklist-templates/:id/items", requireActiveSubscription, async (req: any, res) => {
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

  app.post("/api/checklist-templates", requireActiveSubscription, async (req: any, res) => {
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

  app.delete("/api/checklist-templates/:id", requireActiveSubscription, async (req: any, res) => {
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
  app.get("/api/report-templates", requireActiveSubscription, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const templates = await storage.getAllReportTemplates(accountId);
      res.json(templates);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch report templates" });
    }
  });

  app.post("/api/report-templates", requireActiveSubscription, async (req: any, res) => {
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

  app.delete("/api/report-templates/:id", requireActiveSubscription, async (req: any, res) => {
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

  app.post("/api/galleries", requireActiveSubscription, async (req: any, res) => {
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

  app.get("/api/activity", requireActiveSubscription, async (req: any, res) => {
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

  app.get("/api/projects/:id/daily-log", requireActiveSubscription, async (req: any, res) => {
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

  app.get("/api/analytics", requireActiveSubscription, async (req: any, res) => {
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
      const user = await authStorage.getUser(req.user.id);
      if (!user) return res.status(404).json({ message: "User not found" });

      res.json({
        subscriptionStatus: user.subscriptionStatus || "none",
        stripeSubscriptionId: user.stripeSubscriptionId,
        trialEndsAt: user.trialEndsAt,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch subscription" });
    }
  });

  app.post("/api/create-checkout-session", isAuthenticated, async (req: any, res) => {
    try {
      const { priceId } = req.body;
      if (!priceId) {
        return res.status(400).json({ message: "Price ID is required" });
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
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/?checkout=success`,
        cancel_url: `${baseUrl}/?checkout=canceled`,
        payment_method_collection: "always",
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
        return res.json(safeUser);
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
      const result = await db.execute(sql`
        SELECT 
          p.id as product_id,
          p.name as product_name,
          p.description,
          p.metadata,
          pr.id as price_id,
          pr.unit_amount,
          pr.currency,
          pr.recurring->>'interval' as recurring_interval,
          (pr.recurring->>'interval_count')::int as recurring_interval_count,
          pr.active as price_active
        FROM stripe.products p
        JOIN stripe.prices pr ON pr.product = p.id
        WHERE p.active = true AND pr.active = true
        ORDER BY pr.unit_amount ASC
      `);
      res.json(result.rows || []);
    } catch (error) {
      console.error("Error fetching prices:", error);
      res.status(500).json({ message: "Failed to fetch prices" });
    }
  });

  return httpServer;
}
