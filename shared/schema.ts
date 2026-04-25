import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, real, pgEnum, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export * from "./models/auth";
import { users, accounts, invitations } from "./models/auth";

export const tagTypeEnum = pgEnum("tag_type", ["photo", "project"]);
export const projectStatusEnum = pgEnum("project_status", ["active", "completed", "on_hold", "archived"]);
export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done"]);
export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high"]);
export const checklistStatusEnum = pgEnum("checklist_status", ["not_started", "in_progress", "completed"]);
export const reportStatusEnum = pgEnum("report_status", ["draft", "submitted", "approved"]);
export const calendarProviderEnum = pgEnum("calendar_provider", ["google", "outlook", "apple", "ical"]);
export const eventRepeatEnum = pgEnum("event_repeat", ["none", "daily", "weekly", "monthly", "yearly"]);
export const eventSyncStatusEnum = pgEnum("event_sync_status", ["pending", "synced", "failed", "disabled"]);

export const projects = pgTable("projects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  description: text("description"),
  status: projectStatusEnum("status").default("active").notNull(),
  address: text("address"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  color: text("color").default("#3B82F6"),
  tags: text("tags").array().default(sql`'{}'::text[]`),
  coverPhotoId: integer("cover_photo_id"),
  accountId: varchar("account_id").references(() => accounts.id),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("projects_account_id_idx").on(table.accountId),
  index("projects_created_by_id_idx").on(table.createdById),
]);

export const media = pgTable("media", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  uploadedById: varchar("uploaded_by_id").references(() => users.id),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  url: text("url").notNull(),
  caption: text("caption"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  tags: text("tags").array().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("media_project_id_idx").on(table.projectId),
]);

export const mediaAnnotations = pgTable("media_annotations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  mediaId: integer("media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  strokes: jsonb("strokes").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const comments = pgTable("comments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  mediaId: integer("media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tasks = pgTable("tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: taskStatusEnum("status").default("todo").notNull(),
  priority: taskPriorityEnum("priority").default("medium").notNull(),
  assignedToId: varchar("assigned_to_id").references(() => users.id),
  createdById: varchar("created_by_id").references(() => users.id),
  dueDate: timestamp("due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("tasks_project_id_idx").on(table.projectId),
]);

export const checklists = pgTable("checklists", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: checklistStatusEnum("status").default("not_started").notNull(),
  assignedToId: varchar("assigned_to_id").references(() => users.id),
  createdById: varchar("created_by_id").references(() => users.id),
  dueDate: timestamp("due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("checklists_project_id_idx").on(table.projectId),
]);

export const checklistItems = pgTable("checklist_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  checklistId: integer("checklist_id").references(() => checklists.id, { onDelete: "cascade" }).notNull(),
  label: text("label").notNull(),
  checked: boolean("checked").default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
});

export const reports = pgTable("reports", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  type: text("type").default("inspection").notNull(),
  status: reportStatusEnum("status").default("draft").notNull(),
  content: text("content"),
  findings: text("findings"),
  recommendations: text("recommendations"),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("reports_project_id_idx").on(table.projectId),
]);

export const checklistTemplates = pgTable("checklist_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description"),
  accountId: varchar("account_id").references(() => accounts.id),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const checklistTemplateItems = pgTable("checklist_template_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  templateId: integer("template_id").references(() => checklistTemplates.id, { onDelete: "cascade" }).notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
});

export const reportTemplates = pgTable("report_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  type: text("type").default("inspection").notNull(),
  content: text("content"),
  findings: text("findings"),
  recommendations: text("recommendations"),
  accountId: varchar("account_id").references(() => accounts.id),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sharedGalleries = pgTable("shared_galleries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  token: varchar("token", { length: 32 }).notNull().unique(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  mediaIds: integer("media_ids").array().notNull(),
  includeMetadata: boolean("include_metadata").default(false).notNull(),
  includeDescriptions: boolean("include_descriptions").default(false).notNull(),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const projectAssignments = pgTable("project_assignments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  assignedById: varchar("assigned_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("project_assignments_user_project_idx").on(table.userId, table.projectId),
]);

export const insertSharedGallerySchema = createInsertSchema(sharedGalleries).omit({
  id: true,
  createdAt: true,
});

export type InsertSharedGallery = z.infer<typeof insertSharedGallerySchema>;
export type SharedGallery = typeof sharedGalleries.$inferSelect;
export type ProjectAssignment = typeof projectAssignments.$inferSelect;

export const accountTags = pgTable("account_tags", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  name: text("name").notNull(),
  type: tagTypeEnum("type").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAccountTagSchema = createInsertSchema(accountTags).omit({
  id: true,
  createdAt: true,
});
export type InsertAccountTag = z.infer<typeof insertAccountTagSchema>;
export type AccountTag = typeof accountTags.$inferSelect;

export const calendarConnections = pgTable("calendar_connections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  provider: calendarProviderEnum("provider").notNull(),
  externalEmail: text("external_email"),
  syncTasks: boolean("sync_tasks").default(true).notNull(),
  syncChecklists: boolean("sync_checklists").default(false).notNull(),
  status: text("status").default("pending").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCalendarConnectionSchema = createInsertSchema(calendarConnections).omit({
  id: true,
  createdAt: true,
});
export type InsertCalendarConnection = z.infer<typeof insertCalendarConnectionSchema>;
export type CalendarConnection = typeof calendarConnections.$inferSelect;

export const calendarEvents = pgTable("calendar_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  createdById: varchar("created_by_id").references(() => users.id).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  allDay: boolean("all_day").default(false).notNull(),
  repeat: eventRepeatEnum("repeat").default("none").notNull(),
  repeatUntil: timestamp("repeat_until"),
  attendees: text("attendees").array().default(sql`ARRAY[]::text[]`).notNull(),
  pushToConnected: boolean("push_to_connected").default(true).notNull(),
  syncStatus: eventSyncStatusEnum("sync_status").default("pending").notNull(),
  syncMessage: text("sync_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("calendar_events_account_id_idx").on(table.accountId),
]);

export const insertCalendarEventSchema = createInsertSchema(calendarEvents, {
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  repeatUntil: z.coerce.date().nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  syncStatus: true,
  syncMessage: true,
});
export type InsertCalendarEvent = z.infer<typeof insertCalendarEventSchema>;
export type CalendarEvent = typeof calendarEvents.$inferSelect;

export const projectsRelations = relations(projects, ({ one, many }) => ({
  createdBy: one(users, { fields: [projects.createdById], references: [users.id] }),
  media: many(media),
  tasks: many(tasks),
  checklists: many(checklists),
  reports: many(reports),
}));

export const mediaRelations = relations(media, ({ one, many }) => ({
  project: one(projects, { fields: [media.projectId], references: [projects.id] }),
  uploadedBy: one(users, { fields: [media.uploadedById], references: [users.id] }),
  comments: many(comments),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  media: one(media, { fields: [comments.mediaId], references: [media.id] }),
  user: one(users, { fields: [comments.userId], references: [users.id] }),
}));

export const mediaAnnotationsRelations = relations(mediaAnnotations, ({ one }) => ({
  media: one(media, { fields: [mediaAnnotations.mediaId], references: [media.id] }),
  user: one(users, { fields: [mediaAnnotations.userId], references: [users.id] }),
}));

export const tasksRelations = relations(tasks, ({ one }) => ({
  project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
  assignedTo: one(users, { fields: [tasks.assignedToId], references: [users.id] }),
  createdBy: one(users, { fields: [tasks.createdById], references: [users.id] }),
}));

export const checklistsRelations = relations(checklists, ({ one, many }) => ({
  project: one(projects, { fields: [checklists.projectId], references: [projects.id] }),
  assignedTo: one(users, { fields: [checklists.assignedToId], references: [users.id] }),
  createdBy: one(users, { fields: [checklists.createdById], references: [users.id] }),
  items: many(checklistItems),
}));

export const checklistItemsRelations = relations(checklistItems, ({ one }) => ({
  checklist: one(checklists, { fields: [checklistItems.checklistId], references: [checklists.id] }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  project: one(projects, { fields: [reports.projectId], references: [projects.id] }),
  createdBy: one(users, { fields: [reports.createdById], references: [users.id] }),
}));

export const checklistTemplatesRelations = relations(checklistTemplates, ({ many }) => ({
  items: many(checklistTemplateItems),
}));

export const checklistTemplateItemsRelations = relations(checklistTemplateItems, ({ one }) => ({
  template: one(checklistTemplates, { fields: [checklistTemplateItems.templateId], references: [checklistTemplates.id] }),
}));

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMediaSchema = createInsertSchema(media).omit({
  id: true,
  createdAt: true,
});

export const insertCommentSchema = createInsertSchema(comments).omit({
  id: true,
  createdAt: true,
});

export const annotationStrokeSchema = z.object({
  id: z.string(),
  type: z.enum(["pencil", "arrow", "rectangle", "circle", "line"]),
  color: z.string(),
  width: z.number(),
  points: z.array(z.object({ x: z.number(), y: z.number() })),
});

export const annotationStrokesSchema = z.array(annotationStrokeSchema);

export const insertMediaAnnotationSchema = createInsertSchema(mediaAnnotations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  strokes: annotationStrokesSchema,
});

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChecklistSchema = createInsertSchema(checklists).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChecklistItemSchema = createInsertSchema(checklistItems).omit({
  id: true,
});

export const insertReportSchema = createInsertSchema(reports).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;
export type InsertMedia = z.infer<typeof insertMediaSchema>;
export type Media = typeof media.$inferSelect;
export type InsertComment = z.infer<typeof insertCommentSchema>;
export type Comment = typeof comments.$inferSelect;
export type AnnotationStroke = z.infer<typeof annotationStrokeSchema>;
export type InsertMediaAnnotation = z.infer<typeof insertMediaAnnotationSchema>;
export type MediaAnnotation = typeof mediaAnnotations.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;
export type InsertChecklist = z.infer<typeof insertChecklistSchema>;
export type Checklist = typeof checklists.$inferSelect;
export type InsertChecklistItem = z.infer<typeof insertChecklistItemSchema>;
export type ChecklistItem = typeof checklistItems.$inferSelect;
export type InsertReport = z.infer<typeof insertReportSchema>;
export type Report = typeof reports.$inferSelect;

export const insertChecklistTemplateSchema = createInsertSchema(checklistTemplates).omit({
  id: true,
  createdAt: true,
});

export const insertChecklistTemplateItemSchema = createInsertSchema(checklistTemplateItems).omit({
  id: true,
});

export const insertReportTemplateSchema = createInsertSchema(reportTemplates).omit({
  id: true,
  createdAt: true,
});

export type InsertChecklistTemplate = z.infer<typeof insertChecklistTemplateSchema>;
export type ChecklistTemplate = typeof checklistTemplates.$inferSelect;
export type InsertChecklistTemplateItem = z.infer<typeof insertChecklistTemplateItemSchema>;
export type ChecklistTemplateItem = typeof checklistTemplateItems.$inferSelect;
export type InsertReportTemplate = z.infer<typeof insertReportTemplateSchema>;
export type ReportTemplate = typeof reportTemplates.$inferSelect;
