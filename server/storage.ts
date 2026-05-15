import {
  projects,
  media,
  mediaAnnotations,
  comments,
  tasks,
  checklists,
  checklistItems,
  checklistSections,
  checklistItemOptions,
  checklistItemPhotos,
  reports,
  reportSections,
  reportSectionPhotos,
  sharedGalleries,
  checklistTemplates,
  checklistTemplateItems,
  checklistTemplateSections,
  checklistTemplateItemOptions,
  accountTags,
  calendarConnections,
  calendarEvents,
  type Project,
  type InsertProject,
  type Media,
  type InsertMedia,
  type Comment,
  type InsertComment,
  type MediaAnnotation,
  type InsertMediaAnnotation,
  type Task,
  type InsertTask,
  type Checklist,
  type InsertChecklist,
  type ChecklistItem,
  type InsertChecklistItem,
  type ChecklistSection,
  type InsertChecklistSection,
  type ChecklistItemOption,
  type InsertChecklistItemOption,
  type ChecklistItemPhoto,
  type InsertChecklistItemPhoto,
  type Report,
  type InsertReport,
  type ReportSection,
  type InsertReportSection,
  type ReportSectionPhoto,
  type InsertReportSectionPhoto,
  type SharedGallery,
  type InsertSharedGallery,
  type ChecklistTemplate,
  type InsertChecklistTemplate,
  type ChecklistTemplateItem,
  type InsertChecklistTemplateItem,
  type ChecklistTemplateSection,
  type InsertChecklistTemplateSection,
  type ChecklistTemplateItemOption,
  type InsertChecklistTemplateItemOption,
  reportTemplates,
  type ReportTemplate,
  type InsertReportTemplate,
  type TemplateConfig,
  type AccountTag,
  type InsertAccountTag,
  type CalendarConnection,
  type InsertCalendarConnection,
  type CalendarEvent,
  type InsertCalendarEvent,
  timeEntries,
  type TimeEntry,
  type InsertTimeEntry,
  pendingGeofenceExits,
  type PendingGeofenceExit,
  type InsertPendingGeofenceExit,
  pendingGeofenceEnters,
  type PendingGeofenceEnter,
  type InsertPendingGeofenceEnter,
} from "@shared/schema";
import { users, accounts, type User } from "@shared/models/auth";
import { db } from "./db";
import { eq, desc, sql, asc, and, inArray, lte, like } from "drizzle-orm";

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

// drizzle-zod's createInsertSchema(...).omit() collapses inferred insert types
// to `{}` (see shared/schema.ts comments). This concrete view is used by the
// checklist-item methods for field-type-aware writes.
type ChecklistFieldType = "yes_no" | "rating" | "text" | "multiple_choice";
type ChecklistItemPatch = {
  fieldType?: ChecklistFieldType;
  valueBool?: boolean | null;
  valueRating?: number | null;
  valueText?: string | null;
  selectedOptionId?: number | null;
  photosRequired?: boolean;
  checked?: boolean;
};

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
  updateMedia(id: number, data: { caption?: string; tags?: string[] }): Promise<Media | undefined>;
  deleteMedia(id: number): Promise<void>;

  getAccountTags(accountId: string, type?: string): Promise<AccountTag[]>;
  createAccountTag(tag: InsertAccountTag): Promise<AccountTag>;
  deleteAccountTag(id: number): Promise<void>;

  getCommentsByMedia(mediaId: number): Promise<(Comment & { user?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  createComment(comment: InsertComment): Promise<Comment>;

  getAnnotationsByMedia(mediaId: number): Promise<(MediaAnnotation & { user?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  getAnnotationsByProject(projectId: number): Promise<MediaAnnotation[]>;
  getAnnotation(id: string): Promise<MediaAnnotation | undefined>;
  createAnnotation(annotation: InsertMediaAnnotation): Promise<MediaAnnotation>;
  updateAnnotation(id: string, data: { strokes: unknown }): Promise<MediaAnnotation | undefined>;
  deleteAnnotation(id: string): Promise<void>;

  getTasksByProject(projectId: number): Promise<(Task & { assignedTo?: { firstName: string | null; lastName: string | null } })[]>;
  getAllTasks(accountId: string): Promise<(Task & { project?: { name: string }; assignedTo?: { firstName: string | null; lastName: string | null } })[]>;
  createTask(task: InsertTask): Promise<Task>;
  updateTask(id: number, data: Partial<InsertTask>): Promise<Task | undefined>;
  deleteTask(id: number, accountId: string): Promise<boolean>;

  getChecklistsByProject(projectId: number): Promise<(Checklist & { assignedTo?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null }; itemCount: number; checkedCount: number; sectionCount: number })[]>;
  getAllChecklists(accountId: string): Promise<(Checklist & { project?: { name: string }; assignedTo?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null }; itemCount: number; checkedCount: number; sectionCount: number })[]>;
  getChecklist(id: number): Promise<Checklist | undefined>;
  createChecklist(checklist: InsertChecklist): Promise<Checklist>;
  updateChecklist(id: number, data: Partial<InsertChecklist>): Promise<Checklist | undefined>;
  deleteChecklist(id: number): Promise<void>;

  getChecklistItems(checklistId: number): Promise<ChecklistItem[]>;
  createChecklistItem(item: InsertChecklistItem): Promise<ChecklistItem>;
  updateChecklistItem(id: number, data: Partial<InsertChecklistItem>): Promise<ChecklistItem | undefined>;
  deleteChecklistItem(id: number): Promise<void>;

  getChecklistSections(checklistId: number): Promise<ChecklistSection[]>;
  createChecklistSection(section: InsertChecklistSection): Promise<ChecklistSection>;
  updateChecklistSection(id: number, data: Partial<InsertChecklistSection>): Promise<ChecklistSection | undefined>;
  deleteChecklistSection(id: number): Promise<void>;
  reorderChecklistSections(checklistId: number, orderedIds: number[]): Promise<void>;

  // ── Stage 2: per-item options (multiple_choice) ────────────────────────────
  getChecklistItemOptions(itemId: number): Promise<ChecklistItemOption[]>;
  getChecklistItemOption(id: number): Promise<ChecklistItemOption | undefined>;
  createChecklistItemOption(option: InsertChecklistItemOption): Promise<ChecklistItemOption>;
  updateChecklistItemOption(id: number, data: { label?: string; sortOrder?: number }): Promise<ChecklistItemOption | undefined>;
  deleteChecklistItemOption(id: number): Promise<void>;
  reorderChecklistItemOptions(itemId: number, orderedIds: number[]): Promise<void>;

  // ── Stage 2: per-item photos ───────────────────────────────────────────────
  getChecklistItemPhotos(itemId: number): Promise<(ChecklistItemPhoto & { media: Media })[]>;
  getChecklistItemPhoto(id: number): Promise<ChecklistItemPhoto | undefined>;
  attachChecklistItemPhotos(itemId: number, mediaIds: number[]): Promise<ChecklistItemPhoto[]>;
  detachChecklistItemPhoto(id: number): Promise<void>;
  reorderChecklistItemPhotos(itemId: number, orderedIds: number[]): Promise<void>;

  // ── Reports (structured shape, session 37) ──────────────────────────────
  getReportsByProject(projectId: number): Promise<(Report & { createdBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  getAllReports(accountId: string): Promise<(Report & { project?: { name: string }; createdBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>;
  getReport(id: number): Promise<Report | undefined>;
  getReportTree(id: number): Promise<(Report & { sections: (ReportSection & { photos: (ReportSectionPhoto & { media: Media })[] })[] }) | undefined>;
  getReportForPdf(id: number): Promise<{
    report: Report;
    project: { id: number; name: string; address: string | null; coverPhotoId: number | null };
    account: { id: string; name: string; companyLogoUrl: string | null; companyLegalName: string | null; companyAddress: string | null };
    creator: { firstName: string | null; lastName: string | null } | null;
    sections: (ReportSection & { photos: (ReportSectionPhoto & { media: Media })[] })[];
    coverPhoto: Media | null;
    totalPhotos: number;
  } | undefined>;
  createReport(report: InsertReport, tx?: DbOrTx): Promise<Report>;
  updateReport(id: number, data: Partial<InsertReport>): Promise<Report | undefined>;
  deleteReport(id: number): Promise<void>;

  getReportSection(id: number): Promise<ReportSection | undefined>;
  createReportSection(section: { reportId: number; title: string; summary?: string | null; sortOrder?: number }, tx?: DbOrTx): Promise<ReportSection>;
  updateReportSection(id: number, data: Partial<InsertReportSection>): Promise<ReportSection | undefined>;
  deleteReportSection(id: number): Promise<void>;

  getReportSectionPhoto(id: number): Promise<ReportSectionPhoto | undefined>;
  addReportSectionPhotos(sectionId: number, mediaIds: number[]): Promise<ReportSectionPhoto[]>;
  updateReportSectionPhoto(id: number, data: Partial<InsertReportSectionPhoto>): Promise<ReportSectionPhoto | undefined>;
  deleteReportSectionPhoto(id: number): Promise<void>;

  getUsers(accountId: string): Promise<User[]>;

  getAccountBranding(accountId: string): Promise<{ companyLogoUrl: string | null; companyLegalName: string | null; companyAddress: string | null } | undefined>;
  updateAccountBranding(accountId: string, patch: { companyLogoUrl?: string | null; companyLegalName?: string | null; companyAddress?: string | null }): Promise<{ companyLogoUrl: string | null; companyLegalName: string | null; companyAddress: string | null }>;

  createSharedGallery(gallery: InsertSharedGallery): Promise<SharedGallery>;
  getSharedGalleryByToken(token: string): Promise<SharedGallery | undefined>;

  setReportShareToken(id: number, token: string | null): Promise<Report | undefined>;
  getReportByShareToken(token: string): Promise<Report | undefined>;

  setProjectShareToken(projectId: number, accountId: string, token: string | null): Promise<boolean>;
  getProjectByShareToken(token: string): Promise<Project | undefined>;
  getProjectPublicSummary(token: string): Promise<{
    project: { id: number; name: string; address: string | null; status: string; color: string | null; photoCount: number; taskCount: number; completionPercent: number };
    account: { name: string; companyLogoUrl: string | null };
    coverPhoto: { url: string } | null;
    photos: Array<{ id: number; url: string; takenAt: Date }>;
  } | undefined>;

  getAllChecklistTemplates(accountId: string): Promise<(ChecklistTemplate & { itemCount: number })[]>;
  getChecklistTemplate(id: number): Promise<ChecklistTemplate | undefined>;
  createChecklistTemplate(template: InsertChecklistTemplate): Promise<ChecklistTemplate>;
  updateChecklistTemplate(id: number, patch: { title?: string; description?: string | null }): Promise<ChecklistTemplate | undefined>;
  deleteChecklistTemplate(id: number): Promise<void>;
  getChecklistTemplateItems(templateId: number): Promise<ChecklistTemplateItem[]>;
  getChecklistTemplateItem(id: number): Promise<ChecklistTemplateItem | undefined>;
  createChecklistTemplateItem(item: InsertChecklistTemplateItem): Promise<ChecklistTemplateItem>;
  updateChecklistTemplateItem(id: number, patch: { label?: string; fieldType?: ChecklistFieldType; sectionId?: number | null; notes?: string | null; photosRequired?: boolean; sortOrder?: number }): Promise<ChecklistTemplateItem | undefined>;
  deleteChecklistTemplateItem(id: number): Promise<void>;
  reorderChecklistTemplateItems(templateId: number, orderedIds: number[]): Promise<void>;
  getChecklistTemplateSections(templateId: number): Promise<ChecklistTemplateSection[]>;
  getChecklistTemplateSection(id: number): Promise<ChecklistTemplateSection | undefined>;
  createChecklistTemplateSection(section: InsertChecklistTemplateSection): Promise<ChecklistTemplateSection>;
  updateChecklistTemplateSection(id: number, patch: { title?: string; sortOrder?: number }): Promise<ChecklistTemplateSection | undefined>;
  deleteChecklistTemplateSection(id: number): Promise<void>;
  reorderChecklistTemplateSections(templateId: number, orderedIds: number[]): Promise<void>;
  getChecklistTemplateItemOptions(itemId: number): Promise<ChecklistTemplateItemOption[]>;
  getChecklistTemplateItemOption(id: number): Promise<ChecklistTemplateItemOption | undefined>;
  createChecklistTemplateItemOption(option: InsertChecklistTemplateItemOption): Promise<ChecklistTemplateItemOption>;
  updateChecklistTemplateItemOption(id: number, patch: { label?: string; sortOrder?: number }): Promise<ChecklistTemplateItemOption | undefined>;
  deleteChecklistTemplateItemOption(id: number): Promise<void>;
  reorderChecklistTemplateItemOptions(itemId: number, orderedIds: number[]): Promise<void>;
  instantiateChecklistFromTemplate(templateId: number, projectId: number, name: string, createdByUserId: string, accountId: string): Promise<number>;

  getReportTemplates(accountId: string): Promise<(ReportTemplate & { sectionCount: number })[]>;
  getReportTemplate(id: number): Promise<ReportTemplate | undefined>;
  createReportTemplate(template: InsertReportTemplate): Promise<ReportTemplate>;
  updateReportTemplate(id: number, patch: Partial<InsertReportTemplate>): Promise<ReportTemplate | undefined>;
  deleteReportTemplate(id: number): Promise<void>;


  getCalendarConnections(userId: string): Promise<CalendarConnection[]>;
  getCalendarConnection(id: number): Promise<CalendarConnection | undefined>;
  createCalendarConnection(connection: InsertCalendarConnection): Promise<CalendarConnection>;
  updateCalendarConnection(id: number, data: Partial<InsertCalendarConnection>): Promise<CalendarConnection | undefined>;
  deleteCalendarConnection(id: number): Promise<void>;

  getCalendarEvents(accountId: string): Promise<CalendarEvent[]>;
  getCalendarEvent(id: number): Promise<CalendarEvent | undefined>;
  createCalendarEvent(event: InsertCalendarEvent): Promise<CalendarEvent>;
  updateCalendarEvent(id: number, data: Partial<InsertCalendarEvent> & { syncStatus?: string; syncMessage?: string | null }): Promise<CalendarEvent | undefined>;
  deleteCalendarEvent(id: number): Promise<void>;

  getTimeEntry(id: string): Promise<TimeEntry | undefined>;
  getActiveTimeEntryForUser(userId: string): Promise<TimeEntry | undefined>;
  createTimeEntry(entry: InsertTimeEntry): Promise<TimeEntry>;
  updateTimeEntry(id: string, data: Partial<InsertTimeEntry> & { updatedAt?: Date }): Promise<TimeEntry | undefined>;
  deleteTimeEntry(id: string): Promise<void>;
  // Pending geofence exits (S32a auto clock-out debounce)
  createPendingExit(data: InsertPendingGeofenceExit): Promise<PendingGeofenceExit>;
  getPendingExitById(id: string): Promise<PendingGeofenceExit | undefined>;
  getPendingExitByTimeEntryPending(timeEntryId: string): Promise<PendingGeofenceExit | undefined>;
  getPendingExitByTimeEntryAny(timeEntryId: string): Promise<PendingGeofenceExit | undefined>;
  getPendingExitsDue(limit: number): Promise<PendingGeofenceExit[]>;
  cancelPendingExit(id: string): Promise<PendingGeofenceExit | undefined>;
  markPendingExitFired(id: string, notes?: string): Promise<PendingGeofenceExit | undefined>;
  markPendingExitFailed(id: string, notes: string): Promise<PendingGeofenceExit | undefined>;
  deletePendingExit(id: string): Promise<void>;
  // Pending geofence enters (S33 auto clock-in dwell verification)
  createPendingEnter(data: InsertPendingGeofenceEnter): Promise<PendingGeofenceEnter>;
  getPendingEnterById(id: string): Promise<PendingGeofenceEnter | undefined>;
  getPendingEnterByUserProjectPending(userId: string, projectId: number): Promise<PendingGeofenceEnter | undefined>;
  getPendingEntersDue(limit: number): Promise<PendingGeofenceEnter[]>;
  cancelPendingEnter(id: string): Promise<PendingGeofenceEnter | undefined>;
  markPendingEnterFired(id: string, opts?: { notes?: string; createdTimeEntryId?: string }): Promise<PendingGeofenceEnter | undefined>;
  markPendingEnterFailed(id: string, notes: string): Promise<PendingGeofenceEnter | undefined>;
  // Returns the first overlapping entry for the same user within the account, or undefined.
  // Boundary touch (existing.clockOut == newStart, or existing.clockIn == newEnd) is allowed.
  // An active entry (clock_out IS NULL) is treated as extending to +infinity.
  hasOverlappingEntry(opts: {
    accountId: string;
    userId: string;
    start: Date;
    end: Date;
    excludeEntryId?: string;
  }): Promise<TimeEntry | undefined>;
  listTimeEntries(opts: {
    accountId: string;
    startDate: Date;
    endDate: Date;
    userId?: string;
    userIds?: string[];
    projectId?: number;
  }): Promise<TimeEntry[]>;
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

  async updateMedia(id: number, data: { caption?: string; tags?: string[] }): Promise<Media | undefined> {
    const updateData: any = {};
    if (data.caption !== undefined) updateData.caption = data.caption;
    if (data.tags !== undefined) updateData.tags = data.tags;
    const [updated] = await db.update(media).set(updateData).where(eq(media.id, id)).returning();
    return updated;
  }

  async deleteMedia(id: number): Promise<void> {
    await db.delete(media).where(eq(media.id, id));
  }

  async getAccountTags(accountId: string, type?: string): Promise<AccountTag[]> {
    if (type) {
      return db.select().from(accountTags).where(and(eq(accountTags.accountId, accountId), eq(accountTags.type, type as any))).orderBy(asc(accountTags.name));
    }
    return db.select().from(accountTags).where(eq(accountTags.accountId, accountId)).orderBy(asc(accountTags.name));
  }

  async createAccountTag(tag: InsertAccountTag): Promise<AccountTag> {
    const [created] = await db.insert(accountTags).values(tag).returning();
    return created;
  }

  async deleteAccountTag(id: number): Promise<void> {
    await db.delete(accountTags).where(eq(accountTags.id, id));
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

  async getAnnotationsByMedia(mediaId: number) {
    const rows = await db
      .select({
        annotation: mediaAnnotations,
        user: {
          firstName: users.firstName,
          lastName: users.lastName,
          profileImageUrl: users.profileImageUrl,
        },
      })
      .from(mediaAnnotations)
      .leftJoin(users, eq(mediaAnnotations.userId, users.id))
      .where(eq(mediaAnnotations.mediaId, mediaId))
      .orderBy(asc(mediaAnnotations.createdAt));
    return rows.map((r) => ({
      ...r.annotation,
      user: r.user?.firstName ? r.user : undefined,
    }));
  }

  async getAnnotationsByProject(projectId: number): Promise<MediaAnnotation[]> {
    const mediaRows = await db
      .select({ id: media.id })
      .from(media)
      .where(eq(media.projectId, projectId));
    const mediaIds = mediaRows.map((m) => m.id);
    if (mediaIds.length === 0) return [];
    return await db
      .select()
      .from(mediaAnnotations)
      .where(inArray(mediaAnnotations.mediaId, mediaIds))
      .orderBy(asc(mediaAnnotations.createdAt));
  }

  async getAnnotation(id: string): Promise<MediaAnnotation | undefined> {
    const [row] = await db
      .select()
      .from(mediaAnnotations)
      .where(eq(mediaAnnotations.id, id));
    return row;
  }

  async createAnnotation(annotation: InsertMediaAnnotation): Promise<MediaAnnotation> {
    const [created] = await db
      .insert(mediaAnnotations)
      .values(annotation as any)
      .returning();
    return created;
  }

  async updateAnnotation(id: string, data: { strokes: unknown }): Promise<MediaAnnotation | undefined> {
    const [updated] = await db
      .update(mediaAnnotations)
      .set({ strokes: data.strokes as any, updatedAt: new Date() })
      .where(eq(mediaAnnotations.id, id))
      .returning();
    return updated;
  }

  async deleteAnnotation(id: string): Promise<void> {
    await db.delete(mediaAnnotations).where(eq(mediaAnnotations.id, id));
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

  async deleteTask(id: number, accountId: string): Promise<boolean> {
    // Account-scoped delete: verify the task's project belongs to the caller's
    // account before issuing the DELETE. Returns false when no such task exists
    // OR when it exists but in a different account (caller cannot distinguish —
    // the route maps both to 404 to avoid leaking cross-account task IDs).
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(and(eq(tasks.id, id), eq(projects.accountId, accountId)))
      .limit(1);
    if (!row) return false;
    await db.delete(tasks).where(eq(tasks.id, id));
    return true;
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

    const ids = rows.map(r => r.checklist.id);
    const { itemAgg, sectionAgg } = await this._aggregateChecklistCounts(ids);

    return rows.map(r => ({
      ...r.checklist,
      assignedTo: r.assignedTo?.firstName ? r.assignedTo : undefined,
      itemCount: itemAgg.get(r.checklist.id)?.total ?? 0,
      checkedCount: itemAgg.get(r.checklist.id)?.checked ?? 0,
      sectionCount: sectionAgg.get(r.checklist.id) ?? 0,
    }));
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

    const ids = rows.map(r => r.checklist.id);
    const { itemAgg, sectionAgg } = await this._aggregateChecklistCounts(ids);

    return rows.map(r => ({
      ...r.checklist,
      project: r.project?.name ? r.project : undefined,
      assignedTo: r.assignedTo?.firstName ? r.assignedTo : undefined,
      itemCount: itemAgg.get(r.checklist.id)?.total ?? 0,
      checkedCount: itemAgg.get(r.checklist.id)?.checked ?? 0,
      sectionCount: sectionAgg.get(r.checklist.id) ?? 0,
    }));
  }

  // Collapses two N+1 queries into two grouped aggregates. "Checked" is now
  // defined as completed_at IS NOT NULL — the migration backfilled this
  // from the legacy `checked` flag, so legacy rows produce identical counts.
  private async _aggregateChecklistCounts(checklistIds: number[]): Promise<{
    itemAgg: Map<number, { total: number; checked: number }>;
    sectionAgg: Map<number, number>;
  }> {
    const itemAgg = new Map<number, { total: number; checked: number }>();
    const sectionAgg = new Map<number, number>();
    if (checklistIds.length === 0) return { itemAgg, sectionAgg };

    const itemRows = await db
      .select({
        checklistId: checklistItems.checklistId,
        total: sql<number>`count(*)::int`,
        checked: sql<number>`count(*) FILTER (WHERE ${checklistItems.completedAt} IS NOT NULL)::int`,
      })
      .from(checklistItems)
      .where(inArray(checklistItems.checklistId, checklistIds))
      .groupBy(checklistItems.checklistId);
    for (const r of itemRows) itemAgg.set(r.checklistId, { total: r.total, checked: r.checked });

    const sectionRows = await db
      .select({
        checklistId: checklistSections.checklistId,
        total: sql<number>`count(*)::int`,
      })
      .from(checklistSections)
      .where(inArray(checklistSections.checklistId, checklistIds))
      .groupBy(checklistSections.checklistId);
    for (const r of sectionRows) sectionAgg.set(r.checklistId, r.total);

    return { itemAgg, sectionAgg };
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
    // drizzle-zod's createInsertSchema().omit() collapses InsertChecklistItem
    // to `{}` in the inferred type — see comment in shared/schema.ts. Cast
    // through a locally-typed view so the field-type-aware logic stays sound.
    const i = item as ChecklistItemPatch;
    const valueBool = i.valueBool !== undefined ? i.valueBool : (i.checked ? true : i.valueBool);
    return await db.transaction(async (tx) => {
      const [created] = await tx.insert(checklistItems).values({
        ...item,
        valueBool,
      } as InsertChecklistItem).returning();
      // No photos at insert time, so the photos_required gate is the only
      // thing that can hold completion off — the recompute handles it.
      await this._recomputeItemCompletion(created.id, tx);
      const [final] = await tx.select().from(checklistItems).where(eq(checklistItems.id, created.id)).limit(1);
      return final;
    });
  }

  async updateChecklistItem(id: number, data: Partial<InsertChecklistItem> & { checked?: boolean }): Promise<ChecklistItem | undefined> {
    // Same drizzle-zod {} collapse — re-view through a concrete patch shape.
    const d = data as ChecklistItemPatch;

    // Read `current` INSIDE the tx with FOR UPDATE so two concurrent PATCHes
    // racing a fieldType change can't both make their wipe-or-merge decision
    // off the same pre-write snapshot. The row lock serialises them.
    const updated = await db.transaction(async (tx) => {
      const lockRes = await tx.execute(
        sql`SELECT id, field_type AS "fieldType" FROM ${checklistItems} WHERE id = ${id} FOR UPDATE`,
      );
      const current = (lockRes.rows[0] as { id: number; fieldType: string } | undefined);
      if (!current) return undefined;

      const patch: Record<string, unknown> = { ...data };
      if (d.fieldType !== undefined && d.fieldType !== current.fieldType) {
        // Field-type change wipes all value_* columns AND selected_option_id.
        // completed_at is recomputed by _recomputeItemCompletion afterwards.
        patch.valueBool = null;
        patch.valueRating = null;
        patch.valueText = null;
        patch.selectedOptionId = null;
        patch.checked = false;
      } else {
        // Legacy `checked` write-through. PATCH { checked: true } from old
        // mobile builds mirrors to value_bool=true; { checked: false } maps
        // to value_bool=NULL (not false). Legacy "unchecked" meant
        // "unanswered", not a deliberate "No" — mapping to false here would
        // mark the row complete under the new yes_no state machine.
        if (d.checked !== undefined && d.valueBool === undefined) {
          patch.valueBool = d.checked ? true : null;
        }
        // And vice-versa: new clients writing value_bool keep `checked` in
        // sync until the column is dropped in Stage 1.5. Only value_bool=true
        // counts as legacy-checked; both null and false → checked=false.
        if (d.valueBool !== undefined && d.checked === undefined) {
          patch.checked = d.valueBool === true;
        }
      }

      await tx
        .update(checklistItems)
        .set(patch as Partial<InsertChecklistItem>)
        .where(eq(checklistItems.id, id));
      await this._recomputeItemCompletion(id, tx);
      const [row] = await tx.select().from(checklistItems).where(eq(checklistItems.id, id)).limit(1);
      return row;
    });
    return updated;
  }

  /**
   * State machine for completed_at. Centralised here so future callers cannot
   * bypass it. Stage 2 adds:
   *   - multiple_choice → completed when selectedOptionId is non-null
   *   - photos_required gate → if true AND photoCount === 0, completed_at
   *     stays NULL even if the value field is "answered"
   *
   *   yes_no          → answered when value_bool is non-null (true OR false)
   *   rating          → answered when value_rating is between 1 and 5 inclusive
   *   text            → answered when value_text trim().length > 0
   *   multiple_choice → answered when selected_option_id is a positive integer
   *
   * When fieldType changes via PATCH, all value_*, selected_option_id, AND
   * completed_at are nulled simultaneously (handled by updateChecklistItem,
   * not here).
   */
  private _computeCompletedAt(
    fieldType: ChecklistFieldType,
    v: {
      valueBool: boolean | null;
      valueRating: number | null;
      valueText: string | null;
      selectedOptionId: number | null;
    },
    gates: { photosRequired: boolean; photoCount: number },
  ): Date | null {
    let answered: boolean;
    switch (fieldType) {
      case "yes_no":
        answered = v.valueBool !== null && v.valueBool !== undefined;
        break;
      case "rating":
        answered = typeof v.valueRating === "number" && v.valueRating >= 1 && v.valueRating <= 5;
        break;
      case "text":
        answered = typeof v.valueText === "string" && v.valueText.trim().length > 0;
        break;
      case "multiple_choice":
        answered = typeof v.selectedOptionId === "number" && v.selectedOptionId > 0;
        break;
      default:
        return null;
    }
    if (!answered) return null;
    if (gates.photosRequired && gates.photoCount === 0) return null;
    return new Date();
  }

  /**
   * Single source of truth for re-deriving completed_at after any side-effect
   * that can change it: value PATCH, fieldType change, photo attach/detach,
   * option delete (when the deleted option was the selected one). Touches
   * only completed_at on the items row — value_* / checked are owned by
   * updateChecklistItem.
   */
  private async _recomputeItemCompletion(itemId: number, executor: DbOrTx = db): Promise<void> {
    const [item] = await executor.select().from(checklistItems).where(eq(checklistItems.id, itemId)).limit(1);
    if (!item) return;
    const [{ photoCount }] = await executor
      .select({ photoCount: sql<number>`count(*)::int` })
      .from(checklistItemPhotos)
      .where(eq(checklistItemPhotos.itemId, itemId));
    const completedAt = this._computeCompletedAt(
      item.fieldType as ChecklistFieldType,
      {
        valueBool: item.valueBool,
        valueRating: item.valueRating,
        valueText: item.valueText,
        selectedOptionId: item.selectedOptionId,
      },
      { photosRequired: item.photosRequired, photoCount },
    );
    await executor.update(checklistItems).set({ completedAt }).where(eq(checklistItems.id, itemId));
  }

  async deleteChecklistItem(id: number): Promise<void> {
    await db.delete(checklistItems).where(eq(checklistItems.id, id));
  }

  // ── Stage 2: per-item options (multiple_choice) ──────────────────────────
  async getChecklistItemOptions(itemId: number): Promise<ChecklistItemOption[]> {
    return db.select().from(checklistItemOptions)
      .where(eq(checklistItemOptions.itemId, itemId))
      .orderBy(asc(checklistItemOptions.sortOrder), asc(checklistItemOptions.id));
  }

  async getChecklistItemOption(id: number): Promise<ChecklistItemOption | undefined> {
    const [row] = await db.select().from(checklistItemOptions).where(eq(checklistItemOptions.id, id)).limit(1);
    return row;
  }

  async createChecklistItemOption(option: InsertChecklistItemOption): Promise<ChecklistItemOption> {
    const [created] = await db.insert(checklistItemOptions).values(option).returning();
    return created;
  }

  async updateChecklistItemOption(id: number, data: { label?: string; sortOrder?: number }): Promise<ChecklistItemOption | undefined> {
    const patch: Record<string, unknown> = { ...data, updatedAt: new Date() };
    const [updated] = await db.update(checklistItemOptions).set(patch).where(eq(checklistItemOptions.id, id)).returning();
    return updated;
  }

  async deleteChecklistItemOption(id: number): Promise<void> {
    // FK ON DELETE SET NULL clears selectedOptionId on parent items
    // automatically. We capture the parent itemId BEFORE delete so we can
    // recompute its completion state (the row is now unanswered if the
    // deleted option was the selected one).
    await db.transaction(async (tx) => {
      const [opt] = await tx.select({ itemId: checklistItemOptions.itemId })
        .from(checklistItemOptions)
        .where(eq(checklistItemOptions.id, id))
        .limit(1);
      await tx.delete(checklistItemOptions).where(eq(checklistItemOptions.id, id));
      if (opt) await this._recomputeItemCompletion(opt.itemId, tx);
    });
  }

  async reorderChecklistItemOptions(itemId: number, orderedIds: number[]): Promise<void> {
    await db.transaction(async (tx) => {
      const existing = await tx.select({ id: checklistItemOptions.id })
        .from(checklistItemOptions)
        .where(eq(checklistItemOptions.itemId, itemId));
      const existingIds = new Set(existing.map((r) => r.id));
      if (orderedIds.length !== existingIds.size || !orderedIds.every((id) => existingIds.has(id))) {
        throw new Error("orderedIds does not match item options exactly");
      }
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(checklistItemOptions)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(eq(checklistItemOptions.id, orderedIds[i]));
      }
    });
  }

  // ── Stage 2: per-item photos ─────────────────────────────────────────────
  async getChecklistItemPhotos(itemId: number): Promise<(ChecklistItemPhoto & { media: Media })[]> {
    const rows = await db
      .select({ photo: checklistItemPhotos, media })
      .from(checklistItemPhotos)
      .innerJoin(media, eq(checklistItemPhotos.mediaId, media.id))
      .where(eq(checklistItemPhotos.itemId, itemId))
      .orderBy(asc(checklistItemPhotos.sortOrder), asc(checklistItemPhotos.id));
    return rows.map((r) => ({ ...r.photo, media: r.media }));
  }

  async getChecklistItemPhoto(id: number): Promise<ChecklistItemPhoto | undefined> {
    const [row] = await db.select().from(checklistItemPhotos).where(eq(checklistItemPhotos.id, id)).limit(1);
    return row;
  }

  async attachChecklistItemPhotos(itemId: number, mediaIds: number[]): Promise<ChecklistItemPhoto[]> {
    if (mediaIds.length === 0) return [];
    return db.transaction(async (tx) => {
      const [{ maxSort }] = await tx
        .select({ maxSort: sql<number | null>`max(${checklistItemPhotos.sortOrder})` })
        .from(checklistItemPhotos)
        .where(eq(checklistItemPhotos.itemId, itemId));
      const start = (maxSort ?? -1) + 1;
      const rows = mediaIds.map((mediaId, i) => ({ itemId, mediaId, sortOrder: start + i }));
      const created = await tx.insert(checklistItemPhotos).values(rows).returning();
      // Attaching the first photo to a photos_required item is what trips
      // it complete — recompute now.
      await this._recomputeItemCompletion(itemId, tx);
      return created;
    });
  }

  async detachChecklistItemPhoto(id: number): Promise<void> {
    await db.transaction(async (tx) => {
      const [row] = await tx.select({ itemId: checklistItemPhotos.itemId })
        .from(checklistItemPhotos)
        .where(eq(checklistItemPhotos.id, id))
        .limit(1);
      await tx.delete(checklistItemPhotos).where(eq(checklistItemPhotos.id, id));
      // Removing the last photo from a photos_required item un-completes it.
      if (row) await this._recomputeItemCompletion(row.itemId, tx);
    });
  }

  async reorderChecklistItemPhotos(itemId: number, orderedIds: number[]): Promise<void> {
    await db.transaction(async (tx) => {
      const existing = await tx.select({ id: checklistItemPhotos.id })
        .from(checklistItemPhotos)
        .where(eq(checklistItemPhotos.itemId, itemId));
      const existingIds = new Set(existing.map((r) => r.id));
      if (orderedIds.length !== existingIds.size || !orderedIds.every((id) => existingIds.has(id))) {
        throw new Error("orderedIds does not match item photos exactly");
      }
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(checklistItemPhotos)
          .set({ sortOrder: i })
          .where(eq(checklistItemPhotos.id, orderedIds[i]));
      }
    });
  }

  async getChecklistSections(checklistId: number): Promise<ChecklistSection[]> {
    return db.select().from(checklistSections)
      .where(eq(checklistSections.checklistId, checklistId))
      .orderBy(asc(checklistSections.sortOrder), asc(checklistSections.id));
  }

  async createChecklistSection(section: InsertChecklistSection): Promise<ChecklistSection> {
    const [created] = await db.insert(checklistSections).values(section).returning();
    return created;
  }

  async updateChecklistSection(id: number, data: Partial<InsertChecklistSection>): Promise<ChecklistSection | undefined> {
    const [updated] = await db
      .update(checklistSections)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(checklistSections.id, id))
      .returning();
    return updated;
  }

  async deleteChecklistSection(id: number): Promise<void> {
    // FK ON DELETE SET NULL drops items into the "Untitled" virtual group.
    await db.delete(checklistSections).where(eq(checklistSections.id, id));
  }

  async reorderChecklistSections(checklistId: number, orderedIds: number[]): Promise<void> {
    if (orderedIds.length === 0) return;
    // Validate every id belongs to this checklist before writing.
    const owned = await db.select({ id: checklistSections.id })
      .from(checklistSections)
      .where(eq(checklistSections.checklistId, checklistId));
    const ownedSet = new Set(owned.map(r => r.id));
    for (const id of orderedIds) {
      if (!ownedSet.has(id)) throw new Error(`Section ${id} does not belong to checklist ${checklistId}`);
    }
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(checklistSections)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(eq(checklistSections.id, orderedIds[i]));
      }
    });
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

  async getReportTree(id: number) {
    const [report] = await db.select().from(reports).where(eq(reports.id, id));
    if (!report) return undefined;

    const sections = await db
      .select()
      .from(reportSections)
      .where(eq(reportSections.reportId, id))
      .orderBy(asc(reportSections.sortOrder), asc(reportSections.id));

    if (sections.length === 0) {
      return { ...report, sections: [] as (ReportSection & { photos: (ReportSectionPhoto & { media: Media })[] })[] };
    }

    const sectionIds = sections.map((s) => s.id);
    const photoRows = await db
      .select({ photo: reportSectionPhotos, media })
      .from(reportSectionPhotos)
      .innerJoin(media, eq(reportSectionPhotos.mediaId, media.id))
      .where(inArray(reportSectionPhotos.sectionId, sectionIds))
      .orderBy(asc(reportSectionPhotos.sectionId), asc(reportSectionPhotos.sortOrder), asc(reportSectionPhotos.id));

    const bySection = new Map<number, (ReportSectionPhoto & { media: Media })[]>();
    for (const r of photoRows) {
      const arr = bySection.get(r.photo.sectionId) ?? [];
      arr.push({ ...r.photo, media: r.media });
      bySection.set(r.photo.sectionId, arr);
    }

    return {
      ...report,
      sections: sections.map((s) => ({ ...s, photos: bySection.get(s.id) ?? [] })),
    };
  }

  async createReport(report: InsertReport, tx?: DbOrTx): Promise<Report> {
    const dbx = tx ?? db;
    const [created] = await dbx.insert(reports).values(report).returning();
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

  async getReportSection(id: number): Promise<ReportSection | undefined> {
    const [s] = await db.select().from(reportSections).where(eq(reportSections.id, id));
    return s;
  }

  async createReportSection(input: { reportId: number; title: string; summary?: string | null; sortOrder?: number }, tx?: DbOrTx): Promise<ReportSection> {
    const dbx = tx ?? db;
    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [{ maxSort }] = await dbx
        .select({ maxSort: sql<number | null>`max(${reportSections.sortOrder})` })
        .from(reportSections)
        .where(eq(reportSections.reportId, input.reportId));
      sortOrder = (maxSort ?? -1) + 1;
    }
    const [created] = await dbx
      .insert(reportSections)
      .values({ reportId: input.reportId, title: input.title, summary: input.summary ?? null, sortOrder })
      .returning();
    return created;
  }

  async updateReportSection(id: number, data: Partial<InsertReportSection>): Promise<ReportSection | undefined> {
    const [updated] = await db
      .update(reportSections)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(reportSections.id, id))
      .returning();
    return updated;
  }

  async deleteReportSection(id: number): Promise<void> {
    await db.delete(reportSections).where(eq(reportSections.id, id));
  }

  async getReportSectionPhoto(id: number): Promise<ReportSectionPhoto | undefined> {
    const [p] = await db.select().from(reportSectionPhotos).where(eq(reportSectionPhotos.id, id));
    return p;
  }

  async addReportSectionPhotos(sectionId: number, mediaIds: number[]): Promise<ReportSectionPhoto[]> {
    if (mediaIds.length === 0) return [];
    const [{ maxSort }] = await db
      .select({ maxSort: sql<number | null>`max(${reportSectionPhotos.sortOrder})` })
      .from(reportSectionPhotos)
      .where(eq(reportSectionPhotos.sectionId, sectionId));
    const base = (maxSort ?? -1) + 1;
    const rows = mediaIds.map((mediaId, i) => ({
      sectionId,
      mediaId,
      caption: null,
      description: null,
      sortOrder: base + i,
    }));
    return db.insert(reportSectionPhotos).values(rows).returning();
  }

  async updateReportSectionPhoto(id: number, data: Partial<InsertReportSectionPhoto>): Promise<ReportSectionPhoto | undefined> {
    const [updated] = await db
      .update(reportSectionPhotos)
      .set(data)
      .where(eq(reportSectionPhotos.id, id))
      .returning();
    return updated;
  }

  async deleteReportSectionPhoto(id: number): Promise<void> {
    await db.delete(reportSectionPhotos).where(eq(reportSectionPhotos.id, id));
  }

  async getReportForPdf(id: number) {
    const tree = await this.getReportTree(id);
    if (!tree) return undefined;
    const { sections, ...report } = tree;

    const [project] = await db
      .select({ id: projects.id, name: projects.name, address: projects.address, coverPhotoId: projects.coverPhotoId })
      .from(projects)
      .where(eq(projects.id, report.projectId));
    if (!project) return undefined;

    const [account] = await db
      .select({
        id: accounts.id,
        name: accounts.name,
        companyLogoUrl: accounts.companyLogoUrl,
        companyLegalName: accounts.companyLegalName,
        companyAddress: accounts.companyAddress,
      })
      .from(accounts)
      .where(eq(accounts.id, report.accountId));
    if (!account) return undefined;

    let creator: { firstName: string | null; lastName: string | null } | null = null;
    if (report.createdById) {
      const [u] = await db
        .select({ firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(eq(users.id, report.createdById));
      creator = u ?? null;
    }

    // Prefer report-scoped cover photo (coverConfig.coverPhotoMediaId, reserved for
    // future per-report override) and fall back to the project's cover photo.
    const cfg = (report.coverConfig ?? {}) as { coverPhotoMediaId?: number | null };
    const coverMediaId = cfg.coverPhotoMediaId ?? project.coverPhotoId ?? null;
    let coverPhoto: Media | null = null;
    if (coverMediaId) {
      const [m] = await db.select().from(media).where(eq(media.id, coverMediaId));
      coverPhoto = m ?? null;
    }

    const totalPhotos = sections.reduce((acc, s) => acc + s.photos.length, 0);
    return { report, project, account, creator, sections, coverPhoto, totalPhotos };
  }

  async getUsers(accountId: string): Promise<User[]> {
    return db.select().from(users).where(eq(users.accountId, accountId)).orderBy(desc(users.createdAt));
  }

  async getAccountBranding(accountId: string) {
    const [row] = await db
      .select({
        companyLogoUrl: accounts.companyLogoUrl,
        companyLegalName: accounts.companyLegalName,
        companyAddress: accounts.companyAddress,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    return row;
  }

  async updateAccountBranding(
    accountId: string,
    patch: { companyLogoUrl?: string | null; companyLegalName?: string | null; companyAddress?: string | null },
  ) {
    const set: Record<string, string | null> = {};
    if (patch.companyLogoUrl !== undefined) set.companyLogoUrl = patch.companyLogoUrl;
    if (patch.companyLegalName !== undefined) set.companyLegalName = patch.companyLegalName;
    if (patch.companyAddress !== undefined) set.companyAddress = patch.companyAddress;
    const [updated] = await db
      .update(accounts)
      .set(set)
      .where(eq(accounts.id, accountId))
      .returning({
        companyLogoUrl: accounts.companyLogoUrl,
        companyLegalName: accounts.companyLegalName,
        companyAddress: accounts.companyAddress,
      });
    return updated;
  }

  async createSharedGallery(gallery: InsertSharedGallery): Promise<SharedGallery> {
    const [created] = await db.insert(sharedGalleries).values(gallery as any).returning();
    return created;
  }

  async getSharedGalleryByToken(token: string): Promise<SharedGallery | undefined> {
    const [gallery] = await db.select().from(sharedGalleries).where(eq(sharedGalleries.token, token));
    return gallery;
  }

  async setReportShareToken(id: number, token: string | null): Promise<Report | undefined> {
    const [updated] = await db
      .update(reports)
      .set({ shareToken: token, updatedAt: new Date() })
      .where(eq(reports.id, id))
      .returning();
    return updated;
  }

  async getReportByShareToken(token: string): Promise<Report | undefined> {
    const [row] = await db.select().from(reports).where(eq(reports.shareToken, token)).limit(1);
    return row;
  }

  async setProjectShareToken(projectId: number, accountId: string, token: string | null): Promise<boolean> {
    const updated = await db
      .update(projects)
      .set({ shareToken: token, updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.accountId, accountId)))
      .returning({ id: projects.id });
    return updated.length > 0;
  }

  async getProjectByShareToken(token: string): Promise<Project | undefined> {
    if (!token) return undefined;
    const [row] = await db.select().from(projects).where(eq(projects.shareToken, token)).limit(1);
    return row;
  }

  async getProjectPublicSummary(token: string) {
    if (!token) return undefined;
    const [project] = await db.select().from(projects).where(eq(projects.shareToken, token)).limit(1);
    if (!project || !project.accountId) return undefined;

    const [account] = await db
      .select({ name: accounts.name, companyLogoUrl: accounts.companyLogoUrl })
      .from(accounts)
      .where(eq(accounts.id, project.accountId));
    if (!account) return undefined;

    const [photoCountRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(media)
      .where(eq(media.projectId, project.id));
    const photoCount = photoCountRow?.n ?? 0;

    const [taskCountsRow] = await db
      .select({
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'done')::int`,
      })
      .from(tasks)
      .where(eq(tasks.projectId, project.id));
    const taskCount = taskCountsRow?.total ?? 0;
    const taskDone = taskCountsRow?.done ?? 0;
    const completionPercent = taskCount > 0 ? Math.round((taskDone / taskCount) * 100) : 0;

    let coverPhoto: { url: string } | null = null;
    if (project.coverPhotoId) {
      // Defense-in-depth: also require media.projectId === project.id, in
      // case a stale or maliciously-set coverPhotoId points to media in
      // another project (the project PATCH endpoint does not currently
      // validate cross-project ownership of coverPhotoId).
      const [m] = await db
        .select({ url: media.url })
        .from(media)
        .where(and(eq(media.id, project.coverPhotoId), eq(media.projectId, project.id)))
        .limit(1);
      if (m) coverPhoto = { url: m.url };
    }

    // Images only — the public viewer renders <img>, so videos / other
    // mime types must be excluded. Soft-capped at 200 to keep payload
    // bounded; revisit with pagination if any project hits the cap.
    // TODO: paginate if soft cap is regularly reached.
    const photos = await db
      .select({ id: media.id, url: media.url, takenAt: media.createdAt })
      .from(media)
      .where(and(eq(media.projectId, project.id), like(media.mimeType, "image/%")))
      .orderBy(desc(media.createdAt))
      .limit(200);

    return {
      project: {
        id: project.id,
        name: project.name,
        address: project.address,
        status: project.status as string,
        color: project.color,
        photoCount,
        taskCount,
        completionPercent,
      },
      account: {
        name: account.name,
        companyLogoUrl: account.companyLogoUrl,
      },
      coverPhoto,
      photos,
    };
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

  async getChecklistTemplateItem(id: number): Promise<ChecklistTemplateItem | undefined> {
    const [row] = await db.select().from(checklistTemplateItems).where(eq(checklistTemplateItems.id, id)).limit(1);
    return row;
  }

  async createChecklistTemplateItem(item: InsertChecklistTemplateItem): Promise<ChecklistTemplateItem> {
    const [created] = await db.insert(checklistTemplateItems).values(item).returning();
    return created;
  }

  async updateChecklistTemplate(id: number, patch: { title?: string; description?: string | null }): Promise<ChecklistTemplate | undefined> {
    const set: Record<string, unknown> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description;
    if (Object.keys(set).length === 0) {
      return this.getChecklistTemplate(id);
    }
    const [updated] = await db.update(checklistTemplates).set(set).where(eq(checklistTemplates.id, id)).returning();
    return updated;
  }

  async updateChecklistTemplateItem(
    id: number,
    patch: { label?: string; fieldType?: ChecklistFieldType; sectionId?: number | null; notes?: string | null; photosRequired?: boolean; sortOrder?: number },
  ): Promise<ChecklistTemplateItem | undefined> {
    const set: Record<string, unknown> = {};
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.fieldType !== undefined) set.fieldType = patch.fieldType;
    if (patch.sectionId !== undefined) set.sectionId = patch.sectionId;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.photosRequired !== undefined) set.photosRequired = patch.photosRequired;
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
    if (Object.keys(set).length === 0) {
      return this.getChecklistTemplateItem(id);
    }
    // Field-type change wipes child options — multiple_choice options are
    // meaningless on a yes_no/rating/text item. Cascade is parent → child
    // here just like the instance updateChecklistItem nulls value_*.
    if (patch.fieldType !== undefined) {
      return await db.transaction(async (tx) => {
        const [cur] = await tx.select({ fieldType: checklistTemplateItems.fieldType })
          .from(checklistTemplateItems)
          .where(eq(checklistTemplateItems.id, id))
          .limit(1);
        if (cur && cur.fieldType !== patch.fieldType && cur.fieldType === "multiple_choice") {
          await tx.delete(checklistTemplateItemOptions).where(eq(checklistTemplateItemOptions.itemId, id));
        }
        const [updated] = await tx.update(checklistTemplateItems).set(set).where(eq(checklistTemplateItems.id, id)).returning();
        return updated;
      });
    }
    const [updated] = await db.update(checklistTemplateItems).set(set).where(eq(checklistTemplateItems.id, id)).returning();
    return updated;
  }

  async deleteChecklistTemplateItem(id: number): Promise<void> {
    // FK cascade on checklist_template_item_options.item_id removes options.
    await db.delete(checklistTemplateItems).where(eq(checklistTemplateItems.id, id));
  }

  async reorderChecklistTemplateItems(templateId: number, orderedIds: number[]): Promise<void> {
    if (orderedIds.length === 0) return;
    const owned = await db.select({ id: checklistTemplateItems.id })
      .from(checklistTemplateItems)
      .where(eq(checklistTemplateItems.templateId, templateId));
    const ownedSet = new Set(owned.map(r => r.id));
    for (const id of orderedIds) {
      if (!ownedSet.has(id)) throw new Error(`Item ${id} does not belong to template ${templateId}`);
    }
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(checklistTemplateItems)
          .set({ sortOrder: i })
          .where(eq(checklistTemplateItems.id, orderedIds[i]));
      }
    });
  }

  // ── Stage 3: template sections ───────────────────────────────────────────
  async getChecklistTemplateSections(templateId: number): Promise<ChecklistTemplateSection[]> {
    return db.select().from(checklistTemplateSections)
      .where(eq(checklistTemplateSections.templateId, templateId))
      .orderBy(asc(checklistTemplateSections.sortOrder), asc(checklistTemplateSections.id));
  }

  async getChecklistTemplateSection(id: number): Promise<ChecklistTemplateSection | undefined> {
    const [row] = await db.select().from(checklistTemplateSections).where(eq(checklistTemplateSections.id, id)).limit(1);
    return row;
  }

  async createChecklistTemplateSection(section: InsertChecklistTemplateSection): Promise<ChecklistTemplateSection> {
    const [created] = await db.insert(checklistTemplateSections).values(section).returning();
    return created;
  }

  async updateChecklistTemplateSection(id: number, patch: { title?: string; sortOrder?: number }): Promise<ChecklistTemplateSection | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
    const [updated] = await db.update(checklistTemplateSections).set(set).where(eq(checklistTemplateSections.id, id)).returning();
    return updated;
  }

  async deleteChecklistTemplateSection(id: number): Promise<void> {
    // FK ON DELETE SET NULL on items.section_id; mirrors the instance behaviour.
    await db.delete(checklistTemplateSections).where(eq(checklistTemplateSections.id, id));
  }

  async reorderChecklistTemplateSections(templateId: number, orderedIds: number[]): Promise<void> {
    if (orderedIds.length === 0) return;
    const owned = await db.select({ id: checklistTemplateSections.id })
      .from(checklistTemplateSections)
      .where(eq(checklistTemplateSections.templateId, templateId));
    const ownedSet = new Set(owned.map(r => r.id));
    for (const id of orderedIds) {
      if (!ownedSet.has(id)) throw new Error(`Section ${id} does not belong to template ${templateId}`);
    }
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(checklistTemplateSections)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(eq(checklistTemplateSections.id, orderedIds[i]));
      }
    });
  }

  // ── Stage 3: template item options (multiple_choice authoring) ───────────
  async getChecklistTemplateItemOptions(itemId: number): Promise<ChecklistTemplateItemOption[]> {
    return db.select().from(checklistTemplateItemOptions)
      .where(eq(checklistTemplateItemOptions.itemId, itemId))
      .orderBy(asc(checklistTemplateItemOptions.sortOrder), asc(checklistTemplateItemOptions.id));
  }

  async getChecklistTemplateItemOption(id: number): Promise<ChecklistTemplateItemOption | undefined> {
    const [row] = await db.select().from(checklistTemplateItemOptions).where(eq(checklistTemplateItemOptions.id, id)).limit(1);
    return row;
  }

  async createChecklistTemplateItemOption(option: InsertChecklistTemplateItemOption): Promise<ChecklistTemplateItemOption> {
    const [created] = await db.insert(checklistTemplateItemOptions).values(option).returning();
    return created;
  }

  async updateChecklistTemplateItemOption(id: number, patch: { label?: string; sortOrder?: number }): Promise<ChecklistTemplateItemOption | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
    const [updated] = await db.update(checklistTemplateItemOptions).set(set).where(eq(checklistTemplateItemOptions.id, id)).returning();
    return updated;
  }

  async deleteChecklistTemplateItemOption(id: number): Promise<void> {
    await db.delete(checklistTemplateItemOptions).where(eq(checklistTemplateItemOptions.id, id));
  }

  async reorderChecklistTemplateItemOptions(itemId: number, orderedIds: number[]): Promise<void> {
    if (orderedIds.length === 0) return;
    const owned = await db.select({ id: checklistTemplateItemOptions.id })
      .from(checklistTemplateItemOptions)
      .where(eq(checklistTemplateItemOptions.itemId, itemId));
    const ownedSet = new Set(owned.map(r => r.id));
    for (const id of orderedIds) {
      if (!ownedSet.has(id)) throw new Error(`Option ${id} does not belong to item ${itemId}`);
    }
    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(checklistTemplateItemOptions)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(eq(checklistTemplateItemOptions.id, orderedIds[i]));
      }
    });
  }

  // ── Stage 3: instantiation ────────────────────────────────────────────────
  // Server-side, transactional clone of a template into a new checklist on a
  // project. Fixes the lossy client-side mapping (Stage 1+2 dropped fieldType,
  // notes, photosRequired, sections, options on every instantiation).
  // Account isolation is enforced here AND by the route's project access check.
  async instantiateChecklistFromTemplate(
    templateId: number,
    projectId: number,
    name: string,
    createdByUserId: string,
    accountId: string,
  ): Promise<number> {
    return await db.transaction(async (tx) => {
      const [tpl] = await tx.select().from(checklistTemplates).where(eq(checklistTemplates.id, templateId)).limit(1);
      if (!tpl) throw new Error("Template not found");
      if (tpl.accountId !== accountId) throw new Error("Template not in this account");

      const tplSections = await tx.select().from(checklistTemplateSections)
        .where(eq(checklistTemplateSections.templateId, templateId))
        .orderBy(asc(checklistTemplateSections.sortOrder), asc(checklistTemplateSections.id));
      const tplItems = await tx.select().from(checklistTemplateItems)
        .where(eq(checklistTemplateItems.templateId, templateId))
        .orderBy(asc(checklistTemplateItems.sortOrder), asc(checklistTemplateItems.id));
      const tplItemIds = tplItems.map(i => i.id);
      const tplOptions = tplItemIds.length === 0 ? [] : await tx.select().from(checklistTemplateItemOptions)
        .where(inArray(checklistTemplateItemOptions.itemId, tplItemIds))
        .orderBy(asc(checklistTemplateItemOptions.sortOrder), asc(checklistTemplateItemOptions.id));

      const [newChecklist] = await tx.insert(checklists).values({
        projectId,
        title: name,
        createdById: createdByUserId,
      } as any).returning();

      // Clone sections preserving the source sort_order verbatim — keeps
      // any deliberate gaps the author may have left between rows so future
      // reorders behave the same as on the template.
      const sectionMap = new Map<number, number>();
      for (const s of tplSections) {
        const [created] = await tx.insert(checklistSections).values({
          checklistId: newChecklist.id,
          title: s.title,
          sortOrder: s.sortOrder,
        }).returning();
        sectionMap.set(s.id, created.id);
      }

      // Clone items, mapping section_id via sectionMap (NULL stays NULL) and
      // preserving the source item sort_order.
      const itemMap = new Map<number, number>();
      for (const it of tplItems) {
        const newSectionId = it.sectionId == null ? null : (sectionMap.get(it.sectionId) ?? null);
        const [created] = await tx.insert(checklistItems).values({
          checklistId: newChecklist.id,
          sectionId: newSectionId,
          label: it.label,
          fieldType: it.fieldType,
          notes: it.notes,
          photosRequired: it.photosRequired,
          sortOrder: it.sortOrder,
        } as any).returning();
        itemMap.set(it.id, created.id);
      }

      // Clone options for multiple_choice items only — others can't have any
      // and the template-side updateChecklistTemplateItem already cascades them
      // away on a fieldType change, but we filter defensively here too.
      const mcItemIds = new Set(tplItems.filter(i => i.fieldType === "multiple_choice").map(i => i.id));
      const optionsByItem = new Map<number, ChecklistTemplateItemOption[]>();
      for (const opt of tplOptions) {
        if (!mcItemIds.has(opt.itemId)) continue;
        const arr = optionsByItem.get(opt.itemId) ?? [];
        arr.push(opt);
        optionsByItem.set(opt.itemId, arr);
      }
      for (const oldItemId of Array.from(optionsByItem.keys())) {
        const opts = optionsByItem.get(oldItemId)!;
        const newItemId = itemMap.get(oldItemId);
        if (!newItemId) continue;
        const rows = opts.map((o: ChecklistTemplateItemOption) => ({
          itemId: newItemId, label: o.label, sortOrder: o.sortOrder,
        }));
        await tx.insert(checklistItemOptions).values(rows as any);
      }

      return newChecklist.id;
    });
  }

  // Report templates — Stage 4. Hard delete (matches checklistTemplates).
  // No rows reference report_templates yet; templateId on createReport is wired
  // in PR-C and falls back to defaults if the template is missing.

  async getReportTemplates(accountId: string): Promise<(ReportTemplate & { sectionCount: number })[]> {
    const rows = await db.select().from(reportTemplates)
      .where(eq(reportTemplates.accountId, accountId))
      .orderBy(desc(reportTemplates.updatedAt));
    return rows.map((t) => {
      const cfg = (t.templateConfig ?? {}) as Partial<TemplateConfig>;
      const sectionCount = Array.isArray(cfg.sections) ? cfg.sections.length : 0;
      return { ...t, sectionCount };
    });
  }

  async getReportTemplate(id: number): Promise<ReportTemplate | undefined> {
    const [item] = await db.select().from(reportTemplates).where(eq(reportTemplates.id, id));
    return item;
  }

  async createReportTemplate(template: InsertReportTemplate): Promise<ReportTemplate> {
    const [created] = await db.insert(reportTemplates).values(template as any).returning();
    return created;
  }

  async updateReportTemplate(id: number, patch: Partial<InsertReportTemplate>): Promise<ReportTemplate | undefined> {
    // pgTable defaultNow() only fires on INSERT; this manual bump is required
    // so the Templates list (ordered by updatedAt DESC) reflects edits.
    const [updated] = await db.update(reportTemplates)
      .set({ ...patch, updatedAt: new Date() } as any)
      .where(eq(reportTemplates.id, id))
      .returning();
    return updated;
  }

  async deleteReportTemplate(id: number): Promise<void> {
    await db.delete(reportTemplates).where(eq(reportTemplates.id, id));
  }

  async getCalendarConnections(userId: string): Promise<CalendarConnection[]> {
    return db.select().from(calendarConnections).where(eq(calendarConnections.userId, userId)).orderBy(desc(calendarConnections.createdAt));
  }

  async getCalendarConnection(id: number): Promise<CalendarConnection | undefined> {
    const [item] = await db.select().from(calendarConnections).where(eq(calendarConnections.id, id));
    return item;
  }

  async createCalendarConnection(connection: InsertCalendarConnection): Promise<CalendarConnection> {
    const [created] = await db.insert(calendarConnections).values(connection).returning();
    return created;
  }

  async updateCalendarConnection(id: number, data: Partial<InsertCalendarConnection>): Promise<CalendarConnection | undefined> {
    const [updated] = await db.update(calendarConnections).set(data).where(eq(calendarConnections.id, id)).returning();
    return updated;
  }

  async deleteCalendarConnection(id: number): Promise<void> {
    await db.delete(calendarConnections).where(eq(calendarConnections.id, id));
  }

  async getCalendarEvents(accountId: string): Promise<CalendarEvent[]> {
    return db.select().from(calendarEvents).where(eq(calendarEvents.accountId, accountId)).orderBy(asc(calendarEvents.startsAt));
  }
  async getCalendarEvent(id: number): Promise<CalendarEvent | undefined> {
    const [item] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id));
    return item;
  }
  async createCalendarEvent(event: InsertCalendarEvent): Promise<CalendarEvent> {
    const [created] = await db.insert(calendarEvents).values(event).returning();
    return created;
  }
  async updateCalendarEvent(id: number, data: Partial<InsertCalendarEvent> & { syncStatus?: string; syncMessage?: string | null }): Promise<CalendarEvent | undefined> {
    const [updated] = await db.update(calendarEvents).set(data as any).where(eq(calendarEvents.id, id)).returning();
    return updated;
  }
  async deleteCalendarEvent(id: number): Promise<void> {
    await db.delete(calendarEvents).where(eq(calendarEvents.id, id));
  }

  async getTimeEntry(id: string): Promise<TimeEntry | undefined> {
    const [row] = await db.select().from(timeEntries).where(eq(timeEntries.id, id));
    return row;
  }

  async getActiveTimeEntryForUser(userId: string): Promise<TimeEntry | undefined> {
    const [row] = await db.select().from(timeEntries)
      .where(and(eq(timeEntries.userId, userId), sql`${timeEntries.clockOut} IS NULL`));
    return row;
  }

  async createTimeEntry(entry: InsertTimeEntry): Promise<TimeEntry> {
    const [created] = await db.insert(timeEntries).values(entry as any).returning();
    return created;
  }

  async updateTimeEntry(
    id: string,
    data: Partial<InsertTimeEntry> & { updatedAt?: Date },
  ): Promise<TimeEntry | undefined> {
    const [updated] = await db.update(timeEntries).set(data as any).where(eq(timeEntries.id, id)).returning();
    return updated;
  }

  async deleteTimeEntry(id: string): Promise<void> {
    await db.delete(timeEntries).where(eq(timeEntries.id, id));
  }

  // ===== S32a: pending geofence exits =====
  async createPendingExit(data: InsertPendingGeofenceExit): Promise<PendingGeofenceExit> {
    const [row] = await db.insert(pendingGeofenceExits).values(data as any).returning();
    return row;
  }
  async getPendingExitById(id: string): Promise<PendingGeofenceExit | undefined> {
    const [row] = await db.select().from(pendingGeofenceExits)
      .where(eq(pendingGeofenceExits.id, id)).limit(1);
    return row;
  }
  async getPendingExitByTimeEntryPending(timeEntryId: string): Promise<PendingGeofenceExit | undefined> {
    const [row] = await db.select().from(pendingGeofenceExits)
      .where(and(
        eq(pendingGeofenceExits.timeEntryId, timeEntryId),
        eq(pendingGeofenceExits.status, "pending"),
      )).limit(1);
    return row;
  }
  async getPendingExitByTimeEntryAny(timeEntryId: string): Promise<PendingGeofenceExit | undefined> {
    // Most recent row of any status for this entry — used by auto-undo to find a recent fire.
    const [row] = await db.select().from(pendingGeofenceExits)
      .where(eq(pendingGeofenceExits.timeEntryId, timeEntryId))
      .orderBy(desc(pendingGeofenceExits.createdAt))
      .limit(1);
    return row;
  }
  async getPendingExitsDue(limit: number): Promise<PendingGeofenceExit[]> {
    return db.select().from(pendingGeofenceExits)
      .where(and(
        eq(pendingGeofenceExits.status, "pending"),
        lte(pendingGeofenceExits.firesAt, new Date()),
      ))
      .orderBy(pendingGeofenceExits.firesAt)
      .limit(limit);
  }
  async cancelPendingExit(id: string): Promise<PendingGeofenceExit | undefined> {
    const now = new Date();
    const [row] = await db.update(pendingGeofenceExits)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(and(
        eq(pendingGeofenceExits.id, id),
        eq(pendingGeofenceExits.status, "pending"),
      ))
      .returning();
    return row;
  }
  async markPendingExitFired(id: string, notes?: string): Promise<PendingGeofenceExit | undefined> {
    const now = new Date();
    const [row] = await db.update(pendingGeofenceExits)
      .set({ status: "fired", firedAt: now, updatedAt: now, ...(notes ? { notes } : {}) })
      .where(eq(pendingGeofenceExits.id, id))
      .returning();
    return row;
  }
  async markPendingExitFailed(id: string, notes: string): Promise<PendingGeofenceExit | undefined> {
    const now = new Date();
    const [row] = await db.update(pendingGeofenceExits)
      .set({ status: "failed", notes, updatedAt: now })
      .where(eq(pendingGeofenceExits.id, id))
      .returning();
    return row;
  }
  async deletePendingExit(id: string): Promise<void> {
    await db.delete(pendingGeofenceExits).where(eq(pendingGeofenceExits.id, id));
  }

  // ===== S33: pending geofence enters (auto clock-in dwell) =====
  async createPendingEnter(data: InsertPendingGeofenceEnter): Promise<PendingGeofenceEnter> {
    const [row] = await db.insert(pendingGeofenceEnters).values(data as any).returning();
    return row;
  }
  async getPendingEnterById(id: string): Promise<PendingGeofenceEnter | undefined> {
    const [row] = await db.select().from(pendingGeofenceEnters)
      .where(eq(pendingGeofenceEnters.id, id)).limit(1);
    return row;
  }
  async getPendingEnterByUserProjectPending(userId: string, projectId: number): Promise<PendingGeofenceEnter | undefined> {
    // Backed by partial unique index: at most one row matches.
    const [row] = await db.select().from(pendingGeofenceEnters)
      .where(and(
        eq(pendingGeofenceEnters.userId, userId),
        eq(pendingGeofenceEnters.projectId, projectId),
        eq(pendingGeofenceEnters.status, "pending"),
      )).limit(1);
    return row;
  }
  async getPendingEntersDue(limit: number): Promise<PendingGeofenceEnter[]> {
    return db.select().from(pendingGeofenceEnters)
      .where(and(
        eq(pendingGeofenceEnters.status, "pending"),
        lte(pendingGeofenceEnters.firesAt, new Date()),
      ))
      .orderBy(pendingGeofenceEnters.firesAt)
      .limit(limit);
  }
  async cancelPendingEnter(id: string): Promise<PendingGeofenceEnter | undefined> {
    const now = new Date();
    const [row] = await db.update(pendingGeofenceEnters)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(and(
        eq(pendingGeofenceEnters.id, id),
        eq(pendingGeofenceEnters.status, "pending"),
      ))
      .returning();
    return row;
  }
  async markPendingEnterFired(id: string, opts?: { notes?: string; createdTimeEntryId?: string }): Promise<PendingGeofenceEnter | undefined> {
    // Status guard: only fire a row that is still 'pending'. Prevents an
    // out-of-tx caller (e.g., the cron's 23505 race-recovery path, which runs
    // after its tx aborted and released its row lock) from clobbering a row
    // that another actor (cancellation) just transitioned. Returns undefined
    // when the guard fails — caller treats that as "another actor won".
    const now = new Date();
    const [row] = await db.update(pendingGeofenceEnters)
      .set({
        status: "fired",
        firedAt: now,
        updatedAt: now,
        ...(opts?.notes !== undefined ? { notes: opts.notes } : {}),
        ...(opts?.createdTimeEntryId !== undefined ? { createdTimeEntryId: opts.createdTimeEntryId } : {}),
      })
      .where(and(
        eq(pendingGeofenceEnters.id, id),
        eq(pendingGeofenceEnters.status, "pending"),
      ))
      .returning();
    return row;
  }
  async markPendingEnterFailed(id: string, notes: string): Promise<PendingGeofenceEnter | undefined> {
    // Status guard: same rationale as markPendingEnterFired.
    const now = new Date();
    const [row] = await db.update(pendingGeofenceEnters)
      .set({ status: "failed", notes, updatedAt: now })
      .where(and(
        eq(pendingGeofenceEnters.id, id),
        eq(pendingGeofenceEnters.status, "pending"),
      ))
      .returning();
    return row;
  }

  async hasOverlappingEntry(opts: {
    accountId: string;
    userId: string;
    start: Date;
    end: Date;
    excludeEntryId?: string;
  }): Promise<TimeEntry | undefined> {
    // Predicate (boundary touch is intentionally allowed via strict <, >):
    //   existing.clock_in < $newEnd
    //   AND COALESCE(existing.clock_out, 'infinity'::timestamptz) > $newStart
    const conditions = [
      eq(timeEntries.accountId, opts.accountId),
      eq(timeEntries.userId, opts.userId),
      sql`${timeEntries.clockIn} < ${opts.end.toISOString()}::timestamptz`,
      sql`COALESCE(${timeEntries.clockOut}, 'infinity'::timestamptz) > ${opts.start.toISOString()}::timestamptz`,
    ];
    if (opts.excludeEntryId) {
      conditions.push(sql`${timeEntries.id} <> ${opts.excludeEntryId}`);
    }
    const [row] = await db.select().from(timeEntries).where(and(...conditions)).limit(1);
    return row;
  }

  async listTimeEntries(opts: {
    accountId: string;
    startDate: Date;
    endDate: Date;
    userId?: string;
    userIds?: string[];
    projectId?: number;
  }): Promise<TimeEntry[]> {
    const conditions = [
      eq(timeEntries.accountId, opts.accountId),
      sql`${timeEntries.clockIn} >= ${opts.startDate}`,
      sql`${timeEntries.clockIn} <= ${opts.endDate}`,
    ];
    if (opts.userId) conditions.push(eq(timeEntries.userId, opts.userId));
    if (opts.userIds && opts.userIds.length > 0) conditions.push(inArray(timeEntries.userId, opts.userIds));
    if (typeof opts.projectId === "number") conditions.push(eq(timeEntries.projectId, opts.projectId));
    return db.select().from(timeEntries).where(and(...conditions)).orderBy(desc(timeEntries.clockIn));
  }
}

export const storage = new DatabaseStorage();
