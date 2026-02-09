import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import multer from "multer";
import path from "path";
import fs from "fs";
import { insertProjectSchema, insertCommentSchema, insertTaskSchema } from "@shared/schema";

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      cb(null, uniqueSuffix + ext);
    },
  }),
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

  app.get("/api/projects", isAuthenticated, async (_req, res) => {
    try {
      const projects = await storage.getProjectsWithDetails();
      res.json(projects);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch projects" });
    }
  });

  app.get("/api/projects/:id", isAuthenticated, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const mediaItems = await storage.getMediaByProject(id);
      const taskItems = await storage.getTasksByProject(id);

      res.json({ project, media: mediaItems, tasks: taskItems });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch project" });
    }
  });

  app.post("/api/projects", isAuthenticated, async (req: any, res) => {
    try {
      const parsed = insertProjectSchema.safeParse({
        ...req.body,
        createdById: req.user.claims.sub,
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

  app.patch("/api/projects/:id", isAuthenticated, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const allowed = ["name", "description", "status", "address", "latitude", "longitude", "color"];
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

  app.delete("/api/projects/:id", isAuthenticated, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await storage.deleteProject(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete project" });
    }
  });

  app.post("/api/projects/:id/media", isAuthenticated, upload.array("files", 20), async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ message: "No files uploaded" });
      }

      const caption = req.body.caption || null;
      const tags = req.body.tags ? req.body.tags.split(",").map((t: string) => t.trim()).filter(Boolean) : [];

      const created = await Promise.all(
        files.map((file) =>
          storage.createMedia({
            projectId,
            uploadedById: req.user.claims.sub,
            filename: file.filename,
            originalName: file.originalname,
            mimeType: file.mimetype,
            url: `/uploads/${file.filename}`,
            caption,
            tags,
            latitude: req.body.latitude ? parseFloat(req.body.latitude) : null,
            longitude: req.body.longitude ? parseFloat(req.body.longitude) : null,
          })
        )
      );

      res.status(201).json(created);
    } catch (error) {
      res.status(500).json({ message: "Failed to upload media" });
    }
  });

  app.get("/api/media", isAuthenticated, async (_req, res) => {
    try {
      const allMedia = await storage.getAllMedia();
      res.json(allMedia);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch media" });
    }
  });

  app.get("/api/media/:id/comments", isAuthenticated, async (req, res) => {
    try {
      const mediaId = parseInt(req.params.id);
      const mediaComments = await storage.getCommentsByMedia(mediaId);
      res.json(mediaComments);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch comments" });
    }
  });

  app.post("/api/media/:id/comments", isAuthenticated, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.id);
      const parsed = insertCommentSchema.safeParse({
        mediaId,
        userId: req.user.claims.sub,
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

  app.post("/api/projects/:id/tasks", isAuthenticated, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const parsed = insertTaskSchema.safeParse({
        projectId,
        title: req.body.title,
        description: req.body.description || null,
        priority: req.body.priority || "medium",
        assignedToId: req.body.assignedToId || null,
        createdById: req.user.claims.sub,
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

  app.patch("/api/tasks/:id", isAuthenticated, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
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

  app.get("/api/users", isAuthenticated, async (_req, res) => {
    try {
      const usersList = await storage.getUsers();
      res.json(usersList);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  return httpServer;
}
