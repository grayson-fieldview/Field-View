import {
  projects,
  media,
  comments,
  tasks,
  type Project,
  type InsertProject,
  type Media,
  type InsertMedia,
  type Comment,
  type InsertComment,
  type Task,
  type InsertTask,
} from "@shared/schema";
import { users, type User } from "@shared/models/auth";
import { db } from "./db";
import { eq, desc, sql } from "drizzle-orm";

export interface IStorage {
  getProjects(): Promise<Project[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(project: InsertProject): Promise<Project>;
  updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;

  getMediaByProject(projectId: number): Promise<(Media & { uploadedBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  getAllMedia(): Promise<(Media & { project?: { name: string; color: string | null }; uploadedBy?: { firstName: string | null; lastName: string | null } })[]>;
  getMedia(id: number): Promise<Media | undefined>;
  createMedia(item: InsertMedia): Promise<Media>;
  deleteMedia(id: number): Promise<void>;

  getCommentsByMedia(mediaId: number): Promise<(Comment & { user?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  createComment(comment: InsertComment): Promise<Comment>;

  getTasksByProject(projectId: number): Promise<(Task & { assignedTo?: { firstName: string | null; lastName: string | null } })[]>;
  createTask(task: InsertTask): Promise<Task>;
  updateTask(id: number, data: Partial<InsertTask>): Promise<Task | undefined>;

  getUsers(): Promise<User[]>;
}

export class DatabaseStorage implements IStorage {
  async getProjects(): Promise<Project[]> {
    return db.select().from(projects).orderBy(desc(projects.createdAt));
  }

  async getProject(id: number): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    return project;
  }

  async createProject(project: InsertProject): Promise<Project> {
    const [created] = await db.insert(projects).values(project).returning();
    return created;
  }

  async updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined> {
    const [updated] = await db
      .update(projects)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    return updated;
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  async getMediaByProject(projectId: number) {
    const rows = await db
      .select({
        media: media,
        uploadedBy: {
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(media)
      .leftJoin(users, eq(media.uploadedById, users.id))
      .where(eq(media.projectId, projectId))
      .orderBy(desc(media.createdAt));

    return rows.map((r) => ({
      ...r.media,
      uploadedBy: r.uploadedBy?.firstName ? r.uploadedBy : undefined,
    }));
  }

  async getAllMedia() {
    const rows = await db
      .select({
        media: media,
        project: {
          name: projects.name,
          color: projects.color,
        },
        uploadedBy: {
          firstName: users.firstName,
          lastName: users.lastName,
        },
      })
      .from(media)
      .leftJoin(projects, eq(media.projectId, projects.id))
      .leftJoin(users, eq(media.uploadedById, users.id))
      .orderBy(desc(media.createdAt));

    return rows.map((r) => ({
      ...r.media,
      project: r.project?.name ? r.project : undefined,
      uploadedBy: r.uploadedBy?.firstName ? r.uploadedBy : undefined,
    }));
  }

  async getMedia(id: number): Promise<Media | undefined> {
    const [item] = await db.select().from(media).where(eq(media.id, id));
    return item;
  }

  async createMedia(item: InsertMedia): Promise<Media> {
    const [created] = await db.insert(media).values(item).returning();
    return created;
  }

  async deleteMedia(id: number): Promise<void> {
    await db.delete(media).where(eq(media.id, id));
  }

  async getCommentsByMedia(mediaId: number) {
    const rows = await db
      .select({
        comment: comments,
        user: {
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(comments)
      .leftJoin(users, eq(comments.userId, users.id))
      .where(eq(comments.mediaId, mediaId))
      .orderBy(desc(comments.createdAt));

    return rows.map((r) => ({
      ...r.comment,
      user: r.user?.firstName ? r.user : undefined,
    }));
  }

  async createComment(comment: InsertComment): Promise<Comment> {
    const [created] = await db.insert(comments).values(comment).returning();
    return created;
  }

  async getTasksByProject(projectId: number) {
    const rows = await db
      .select({
        task: tasks,
        assignedTo: {
          firstName: users.firstName,
          lastName: users.lastName,
        },
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignedToId, users.id))
      .where(eq(tasks.projectId, projectId))
      .orderBy(desc(tasks.createdAt));

    return rows.map((r) => ({
      ...r.task,
      assignedTo: r.assignedTo?.firstName ? r.assignedTo : undefined,
    }));
  }

  async createTask(task: InsertTask): Promise<Task> {
    const [created] = await db.insert(tasks).values(task).returning();
    return created;
  }

  async updateTask(id: number, data: Partial<InsertTask>): Promise<Task | undefined> {
    const [updated] = await db
      .update(tasks)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    return updated;
  }

  async getUsers(): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.createdAt));
  }
}

export const storage = new DatabaseStorage();
