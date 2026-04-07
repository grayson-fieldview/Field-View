import {
  projects,
  media,
  comments,
  tasks,
  checklists,
  checklistItems,
  reports,
  sharedGalleries,
  checklistTemplates,
  checklistTemplateItems,
  reportTemplates,
  type Project,
  type InsertProject,
  type Media,
  type InsertMedia,
  type Comment,
  type InsertComment,
  type Task,
  type InsertTask,
  type Checklist,
  type InsertChecklist,
  type ChecklistItem,
  type InsertChecklistItem,
  type Report,
  type InsertReport,
  type SharedGallery,
  type InsertSharedGallery,
  type ChecklistTemplate,
  type InsertChecklistTemplate,
  type ChecklistTemplateItem,
  type InsertChecklistTemplateItem,
  type ReportTemplate,
  type InsertReportTemplate,
} from "@shared/schema";
import { users, type User } from "@shared/models/auth";
import { db } from "./db";
import { eq, desc, sql, asc, and } from "drizzle-orm";

export interface ProjectWithDetails extends Project {
  photoCount: number;
  recentPhotos: { id: number; url: string }[];
  recentUsers: { firstName: string | null; lastName: string | null; profileImageUrl: string | null }[];
}

export interface IStorage {
  getProjects(accountId: string): Promise<Project[]>;
  getProjectsWithDetails(accountId: string): Promise<ProjectWithDetails[]>;
  getProject(id: number): Promise<Project | undefined>;
  createProject(project: InsertProject): Promise<Project>;
  updateProject(id: number, data: Partial<InsertProject>): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;

  getMediaByProject(projectId: number): Promise<(Media & { uploadedBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  getAllMedia(accountId: string): Promise<(Media & { project?: { name: string; color: string | null }; uploadedBy?: { firstName: string | null; lastName: string | null } })[]>;
  getMedia(id: number): Promise<Media | undefined>;
  createMedia(item: InsertMedia): Promise<Media>;
  deleteMedia(id: number): Promise<void>;

  getCommentsByMedia(mediaId: number): Promise<(Comment & { user?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  createComment(comment: InsertComment): Promise<Comment>;

  getTasksByProject(projectId: number): Promise<(Task & { assignedTo?: { firstName: string | null; lastName: string | null } })[]>;
  getAllTasks(accountId: string): Promise<(Task & { project?: { name: string }; assignedTo?: { firstName: string | null; lastName: string | null } })[]>;
  createTask(task: InsertTask): Promise<Task>;
  updateTask(id: number, data: Partial<InsertTask>): Promise<Task | undefined>;

  getChecklistsByProject(projectId: number): Promise<(Checklist & { assignedTo?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null }; itemCount: number; checkedCount: number })[]>;
  getAllChecklists(accountId: string): Promise<(Checklist & { project?: { name: string }; assignedTo?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null }; itemCount: number; checkedCount: number })[]>;
  getChecklist(id: number): Promise<Checklist | undefined>;
  createChecklist(checklist: InsertChecklist): Promise<Checklist>;
  updateChecklist(id: number, data: Partial<InsertChecklist>): Promise<Checklist | undefined>;
  deleteChecklist(id: number): Promise<void>;

  getChecklistItems(checklistId: number): Promise<ChecklistItem[]>;
  createChecklistItem(item: InsertChecklistItem): Promise<ChecklistItem>;
  updateChecklistItem(id: number, data: Partial<InsertChecklistItem>): Promise<ChecklistItem | undefined>;
  deleteChecklistItem(id: number): Promise<void>;

  getReportsByProject(projectId: number): Promise<(Report & { createdBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  getAllReports(accountId: string): Promise<(Report & { project?: { name: string }; createdBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  getReport(id: number): Promise<Report | undefined>;
  createReport(report: InsertReport): Promise<Report>;
  updateReport(id: number, data: Partial<InsertReport>): Promise<Report | undefined>;
  deleteReport(id: number): Promise<void>;

  getUsers(accountId: string): Promise<User[]>;

  createSharedGallery(gallery: InsertSharedGallery): Promise<SharedGallery>;
  getSharedGalleryByToken(token: string): Promise<SharedGallery | undefined>;

  getAllChecklistTemplates(accountId: string): Promise<(ChecklistTemplate & { itemCount: number })[]>;
  getChecklistTemplate(id: number): Promise<ChecklistTemplate | undefined>;
  createChecklistTemplate(template: InsertChecklistTemplate): Promise<ChecklistTemplate>;
  deleteChecklistTemplate(id: number): Promise<void>;
  getChecklistTemplateItems(templateId: number): Promise<ChecklistTemplateItem[]>;
  createChecklistTemplateItem(item: InsertChecklistTemplateItem): Promise<ChecklistTemplateItem>;

  getAllReportTemplates(accountId: string): Promise<ReportTemplate[]>;
  getReportTemplate(id: number): Promise<ReportTemplate | undefined>;
  createReportTemplate(template: InsertReportTemplate): Promise<ReportTemplate>;
  deleteReportTemplate(id: number): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getProjects(accountId: string): Promise<Project[]> {
    return db.select().from(projects).where(eq(projects.accountId, accountId)).orderBy(desc(projects.createdAt));
  }

  async getProjectsWithDetails(accountId: string): Promise<ProjectWithDetails[]> {
    const allProjects = await db.select().from(projects).where(eq(projects.accountId, accountId)).orderBy(desc(projects.updatedAt));
    
    const result: ProjectWithDetails[] = [];
    for (const project of allProjects) {
      const projectMedia = await db
        .select({
          id: media.id,
          url: media.url,
          uploadedById: media.uploadedById,
        })
        .from(media)
        .where(eq(media.projectId, project.id))
        .orderBy(desc(media.createdAt));

      const photoCount = projectMedia.length;
      const recentPhotos = projectMedia.slice(0, 4).map(m => ({ id: m.id, url: m.url }));

      const uploaderIds = new Set(projectMedia.map(m => m.uploadedById).filter(Boolean));
      const uniqueUploaderIds = Array.from(uploaderIds) as string[];
      const recentUsers: { firstName: string | null; lastName: string | null; profileImageUrl: string | null }[] = [];
      for (const uid of uniqueUploaderIds.slice(0, 3)) {
        const [u] = await db.select({
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        }).from(users).where(eq(users.id, uid));
        if (u) recentUsers.push(u);
      }

      result.push({
        ...project,
        photoCount,
        recentPhotos,
        recentUsers,
      });
    }
    return result;
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

  async getAllMedia(accountId: string) {
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
      .innerJoin(projects, eq(media.projectId, projects.id))
      .leftJoin(users, eq(media.uploadedById, users.id))
      .where(eq(projects.accountId, accountId))
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

  async getAllTasks(accountId: string) {
    const rows = await db
      .select({
        task: tasks,
        project: { name: projects.name },
        assignedTo: {
          firstName: users.firstName,
          lastName: users.lastName,
        },
      })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .leftJoin(users, eq(tasks.assignedToId, users.id))
      .where(eq(projects.accountId, accountId))
      .orderBy(desc(tasks.createdAt));

    return rows.map((r) => ({
      ...r.task,
      project: r.project?.name ? r.project : undefined,
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

  async getChecklistsByProject(projectId: number) {
    const rows = await db
      .select({
        checklist: checklists,
        assignedTo: {
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(checklists)
      .leftJoin(users, eq(checklists.assignedToId, users.id))
      .where(eq(checklists.projectId, projectId))
      .orderBy(desc(checklists.createdAt));

    const result = [];
    for (const r of rows) {
      const items = await db.select().from(checklistItems).where(eq(checklistItems.checklistId, r.checklist.id));
      result.push({
        ...r.checklist,
        assignedTo: r.assignedTo?.firstName ? r.assignedTo : undefined,
        itemCount: items.length,
        checkedCount: items.filter(i => i.checked).length,
      });
    }
    return result;
  }

  async getAllChecklists(accountId: string) {
    const rows = await db
      .select({
        checklist: checklists,
        project: { name: projects.name },
        assignedTo: {
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(checklists)
      .innerJoin(projects, eq(checklists.projectId, projects.id))
      .leftJoin(users, eq(checklists.assignedToId, users.id))
      .where(eq(projects.accountId, accountId))
      .orderBy(desc(checklists.createdAt));

    const result = [];
    for (const r of rows) {
      const items = await db.select().from(checklistItems).where(eq(checklistItems.checklistId, r.checklist.id));
      result.push({
        ...r.checklist,
        project: r.project?.name ? r.project : undefined,
        assignedTo: r.assignedTo?.firstName ? r.assignedTo : undefined,
        itemCount: items.length,
        checkedCount: items.filter(i => i.checked).length,
      });
    }
    return result;
  }

  async getChecklist(id: number): Promise<Checklist | undefined> {
    const [item] = await db.select().from(checklists).where(eq(checklists.id, id));
    return item;
  }

  async createChecklist(checklist: InsertChecklist): Promise<Checklist> {
    const [created] = await db.insert(checklists).values(checklist).returning();
    return created;
  }

  async updateChecklist(id: number, data: Partial<InsertChecklist>): Promise<Checklist | undefined> {
    const [updated] = await db
      .update(checklists)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(checklists.id, id))
      .returning();
    return updated;
  }

  async deleteChecklist(id: number): Promise<void> {
    await db.delete(checklists).where(eq(checklists.id, id));
  }

  async getChecklistItems(checklistId: number): Promise<ChecklistItem[]> {
    return db.select().from(checklistItems)
      .where(eq(checklistItems.checklistId, checklistId))
      .orderBy(asc(checklistItems.sortOrder));
  }

  async createChecklistItem(item: InsertChecklistItem): Promise<ChecklistItem> {
    const [created] = await db.insert(checklistItems).values(item).returning();
    return created;
  }

  async updateChecklistItem(id: number, data: Partial<InsertChecklistItem>): Promise<ChecklistItem | undefined> {
    const [updated] = await db
      .update(checklistItems)
      .set(data)
      .where(eq(checklistItems.id, id))
      .returning();
    return updated;
  }

  async deleteChecklistItem(id: number): Promise<void> {
    await db.delete(checklistItems).where(eq(checklistItems.id, id));
  }

  async getReportsByProject(projectId: number) {
    const rows = await db
      .select({
        report: reports,
        createdBy: {
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(reports)
      .leftJoin(users, eq(reports.createdById, users.id))
      .where(eq(reports.projectId, projectId))
      .orderBy(desc(reports.createdAt));

    return rows.map(r => ({
      ...r.report,
      createdBy: r.createdBy?.firstName ? r.createdBy : undefined,
    }));
  }

  async getAllReports(accountId: string) {
    const rows = await db
      .select({
        report: reports,
        project: { name: projects.name },
        createdBy: {
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(reports)
      .innerJoin(projects, eq(reports.projectId, projects.id))
      .leftJoin(users, eq(reports.createdById, users.id))
      .where(eq(projects.accountId, accountId))
      .orderBy(desc(reports.createdAt));

    return rows.map(r => ({
      ...r.report,
      project: r.project?.name ? r.project : undefined,
      createdBy: r.createdBy?.firstName ? r.createdBy : undefined,
    }));
  }

  async getReport(id: number): Promise<Report | undefined> {
    const [item] = await db.select().from(reports).where(eq(reports.id, id));
    return item;
  }

  async createReport(report: InsertReport): Promise<Report> {
    const [created] = await db.insert(reports).values(report).returning();
    return created;
  }

  async updateReport(id: number, data: Partial<InsertReport>): Promise<Report | undefined> {
    const [updated] = await db
      .update(reports)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(reports.id, id))
      .returning();
    return updated;
  }

  async deleteReport(id: number): Promise<void> {
    await db.delete(reports).where(eq(reports.id, id));
  }

  async getUsers(accountId: string): Promise<User[]> {
    return db.select().from(users).where(eq(users.accountId, accountId)).orderBy(desc(users.createdAt));
  }

  async createSharedGallery(gallery: InsertSharedGallery): Promise<SharedGallery> {
    const [created] = await db.insert(sharedGalleries).values(gallery as any).returning();
    return created;
  }

  async getSharedGalleryByToken(token: string): Promise<SharedGallery | undefined> {
    const [gallery] = await db.select().from(sharedGalleries).where(eq(sharedGalleries.token, token));
    return gallery;
  }

  async getAllChecklistTemplates(accountId: string): Promise<(ChecklistTemplate & { itemCount: number })[]> {
    const templates = await db.select().from(checklistTemplates).where(eq(checklistTemplates.accountId, accountId)).orderBy(desc(checklistTemplates.createdAt));
    const result = [];
    for (const t of templates) {
      const items = await db.select().from(checklistTemplateItems).where(eq(checklistTemplateItems.templateId, t.id));
      result.push({ ...t, itemCount: items.length });
    }
    return result;
  }

  async getChecklistTemplate(id: number): Promise<ChecklistTemplate | undefined> {
    const [item] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, id));
    return item;
  }

  async createChecklistTemplate(template: InsertChecklistTemplate): Promise<ChecklistTemplate> {
    const [created] = await db.insert(checklistTemplates).values(template).returning();
    return created;
  }

  async deleteChecklistTemplate(id: number): Promise<void> {
    await db.delete(checklistTemplates).where(eq(checklistTemplates.id, id));
  }

  async getChecklistTemplateItems(templateId: number): Promise<ChecklistTemplateItem[]> {
    return db.select().from(checklistTemplateItems)
      .where(eq(checklistTemplateItems.templateId, templateId))
      .orderBy(asc(checklistTemplateItems.sortOrder));
  }

  async createChecklistTemplateItem(item: InsertChecklistTemplateItem): Promise<ChecklistTemplateItem> {
    const [created] = await db.insert(checklistTemplateItems).values(item).returning();
    return created;
  }

  async getAllReportTemplates(accountId: string): Promise<ReportTemplate[]> {
    return db.select().from(reportTemplates).where(eq(reportTemplates.accountId, accountId)).orderBy(desc(reportTemplates.createdAt));
  }

  async getReportTemplate(id: number): Promise<ReportTemplate | undefined> {
    const [item] = await db.select().from(reportTemplates).where(eq(reportTemplates.id, id));
    return item;
  }

  async createReportTemplate(template: InsertReportTemplate): Promise<ReportTemplate> {
    const [created] = await db.insert(reportTemplates).values(template).returning();
    return created;
  }

  async deleteReportTemplate(id: number): Promise<void> {
    await db.delete(reportTemplates).where(eq(reportTemplates.id, id));
  }
}

export const storage = new DatabaseStorage();
