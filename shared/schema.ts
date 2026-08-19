import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, bigint, timestamp, boolean, real, numeric, serial, pgEnum, jsonb, index, uniqueIndex, unique, customType } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { INDUSTRY_VALUES } from "./constants";

export * from "./models/auth";
import { users, accounts, invitations } from "./models/auth";

// tsvector isn't built into drizzle — customType mirror. The COLUMN IS OWNED
// BY THE DB: created by scripts/migrations/add_media_search_vector.ts as
// GENERATED ALWAYS AS ... STORED; app code must never write it. Declared with
// generatedAlwaysAs so drizzle also refuses inserts/updates to it.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const tagTypeEnum = pgEnum("tag_type", ["photo", "project"]);
export const projectStatusEnum = pgEnum("project_status", ["active", "completed", "on_hold", "archived"]);
export const taskStatusEnum = pgEnum("task_status", ["todo", "in_progress", "done"]);
export const taskPriorityEnum = pgEnum("task_priority", ["low", "medium", "high"]);
export const checklistStatusEnum = pgEnum("checklist_status", ["not_started", "in_progress", "completed"]);
// Stage 1 ships yes_no/rating/text. multiple_choice is Stage 2 (ALTER TYPE ADD VALUE).
export const checklistFieldTypeEnum = pgEnum("checklist_field_type", ["yes_no", "rating", "text", "multiple_choice"]);
export const reportStatusEnum = pgEnum("report_status", ["draft", "submitted", "approved", "generating", "failed"]);
export const calendarProviderEnum = pgEnum("calendar_provider", ["google", "outlook", "apple", "ical"]);
export const eventRepeatEnum = pgEnum("event_repeat", ["none", "daily", "weekly", "monthly", "yearly"]);
export const eventSyncStatusEnum = pgEnum("event_sync_status", ["pending", "synced", "failed", "disabled"]);
export const timeEntrySourceEnum = pgEnum("time_entry_source", ["manual", "auto_geofence", "edited"]);

// auth_rate_limits is owned at runtime by `rate-limiter-flexible` (RateLimiterPostgres)
// configured in server/middleware/rate-limit.ts. The library auto-creates and
// manages this table; we mirror its schema here ONLY so drizzle-kit recognizes
// it and does not propose to drop or rename it on `db:push`. Do not write to
// this table from app code — only the rate limiter library should touch it.
export const authRateLimits = pgTable("auth_rate_limits", {
  key: varchar("key", { length: 255 }).primaryKey().notNull(),
  points: integer("points").default(0).notNull(),
  expire: bigint("expire", { mode: "number" }),
});

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
  // NULL = inherit accounts.photo_overlay_enabled; true/false = explicit
  // override. Resolved via shared/photoOverlay.ts resolvePhotoOverlay().
  photoOverlayEnabled: boolean("photo_overlay_enabled"),
  shareToken: varchar("share_token", { length: 32 }),
  accountId: varchar("account_id").references(() => accounts.id),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("projects_account_id_idx").on(table.accountId),
  index("projects_created_by_id_idx").on(table.createdById),
  index("projects_share_token_idx").on(table.shareToken).where(sql`${table.shareToken} IS NOT NULL`),
]);

export const media = pgTable("media", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  uploadedById: varchar("uploaded_by_id").references(() => users.id),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  url: text("url").notNull(),
  // Server-generated 400px JPEG rendition (CloudFront URL). Nullable: filled
  // shortly after registration by deferred generation, or by the backfill.
  // Clients render thumbUrl ?? url.
  thumbUrl: text("thumb_url"),
  // Capture time as reported by the client; null for photos uploaded before
  // this existed and for any client that doesn't send it. Readers should
  // prefer takenAt ?? createdAt (createdAt is server registration time —
  // offline-synced photos can register hours after capture).
  takenAt: timestamp("taken_at"),
  // AI-generated caption (Claude vision). Nullable: filled shortly after
  // registration by deferred generation, or by the backfill. Distinct from
  // `caption` (user-authored, batch-shared) — never write one to the other.
  aiCaption: text("ai_caption"),
  aiCaptionGeneratedAt: timestamp("ai_caption_generated_at"),
  aiCaptionModel: text("ai_caption_model"),
  caption: text("caption"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  tags: text("tags").array().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // DB-owned generated column (see migration add_media_search_vector.ts).
  // Weights: A ai_caption (UNCLEAR sentinel excluded) + user caption,
  // B tags (via IMMUTABLE media_tags_text()), C original_name. 'simple'
  // config — no stemming. Never write from app code.
  searchVector: tsvector("search_vector").generatedAlwaysAs(
    sql`setweight(to_tsvector('simple', CASE WHEN ai_caption = 'UNCLEAR' THEN '' ELSE coalesce(ai_caption, '') END), 'A') || setweight(to_tsvector('simple', coalesce(caption, '')), 'A') || setweight(to_tsvector('simple', media_tags_text(tags)), 'B') || setweight(to_tsvector('simple', coalesce(original_name, '')), 'C')`,
  ),
}, (table) => [
  index("media_project_id_idx").on(table.projectId),
  // Daily Log / date-range photo queries filter by project + capture time.
  index("media_project_taken_at_idx").on(table.projectId, table.takenAt),
  index("media_search_vector_idx").using("gin", table.searchVector),
]);

// Project documents (work orders, change orders, permits) — uploaded by
// office staff, viewed by field crews. Separate from `media` (photos/videos):
// no caption/tags/geo/thumbnail semantics. Account scoping is derived via the
// project join (same as media) — deliberately no accountId column.
export const projectFiles = pgTable("project_files", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  uploadedById: varchar("uploaded_by_id").references(() => users.id),
  filename: text("filename").notNull(),       // S3 key
  originalName: text("original_name").notNull(), // immutable after insert
  // User-editable rename; null = never renamed. Clients decide whether to
  // render displayName ?? originalName — the server never collapses them.
  displayName: text("display_name"),
  mimeType: text("mime_type").notNull(),
  url: text("url").notNull(),                 // CloudFront URL
  sizeBytes: integer("size_bytes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("project_files_project_id_idx").on(table.projectId),
]);

export const mediaAnnotations = pgTable("media_annotations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  mediaId: integer("media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  strokes: jsonb("strokes").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  // One annotation row per user per photo. Enforced in the DB (see
  // scripts/migrations/migrate_media_annotations_dedupe.ts) so two clients
  // can never diverge into duplicate rows; a stray POST hits 409 instead.
  uniqueIndex("media_annotations_media_user_uniq").on(table.mediaId, table.userId),
]);

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
  // S45 — set ONCE on status NULL→done transition for idempotent CIO
  // task_completed event firing. Never re-set on re-edits.
  completedAt: timestamp("completed_at"),
  // Photo requirement: minimum number of attached photos (task_photos rows)
  // required before status can transition to "done". 0 = no requirement
  // (backward compatible — every existing client is unaffected). Enforced
  // server-side in PATCH /api/tasks/:id (422 PHOTOS_REQUIRED). Checked ONLY
  // on the transition to done — never recomputed afterwards, so raising the
  // requirement or deleting attached photos does NOT reopen a completed task.
  // Settable only by admins (enforced in server/routes.ts).
  requiredPhotoCount: integer("required_photo_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("tasks_project_id_idx").on(table.projectId),
]);

// Photo ↔ task join (mirrors checklist_item_photos). Detach deletes ONLY the
// join row — the media row is not deleted (other things may reference it).
// Media deletion cascades the join row away; task deletion likewise. No
// updated_at on purpose — re-attach is delete + create. Unlike
// checklist_item_photos there is NO completion recompute on attach/detach:
// the requirement is evaluated only at the moment of the done transition.
export const taskPhotos = pgTable("task_photos", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
  mediaId: integer("media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("task_photos_task_sort_idx").on(table.taskId, table.sortOrder),
  unique("task_photos_task_media_uniq").on(table.taskId, table.mediaId),
]);

// Stripe webhook event dedupe — currently used ONLY by the
// customer.subscription.trial_will_end handler, because that event triggers a
// customer-facing "your card will be charged" email via GHL: a Stripe
// redelivery must not email the customer twice. The other handlers stay
// dedupe-free on purpose (their DB writes are naturally idempotent and their
// Slack messages are ops-only). INSERT ... ON CONFLICT DO NOTHING on the
// event-id PK is the entire mechanism — first insert wins, replays skip.
export const processedStripeEvents = pgTable("processed_stripe_events", {
  eventId: varchar("event_id").primaryKey(), // Stripe event id (evt_...)
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});

export const checklists = pgTable("checklists", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: checklistStatusEnum("status").default("not_started").notNull(),
  assignedToId: varchar("assigned_to_id").references(() => users.id),
  createdById: varchar("created_by_id").references(() => users.id),
  dueDate: timestamp("due_date"),
  // S45 — set ONCE when the last unanswered item transitions to answered.
  // Drives idempotent CIO checklist_completed event firing.
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("checklists_project_id_idx").on(table.projectId),
]);

// Sections group items within a single checklist. Sort order persists; deleting
// a section sets owning items.section_id NULL (they fall into the "Untitled"
// virtual group in the UI). Stage 1 — instances only; templates get sections in Stage 3.
export const checklistSections = pgTable("checklist_sections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  checklistId: integer("checklist_id").references(() => checklists.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("checklist_sections_checklist_sort_idx").on(table.checklistId, table.sortOrder),
]);

// Stage 1 shape. Field-type-specific value columns (value_bool/value_rating/
// value_text) are nullable and only one applies based on `fieldType`.
// `completed_at` is computed in storage.updateChecklistItem — see state machine
// doc on that method. `checked` is kept for Stage 1 backward-compat (legacy
// mobile clients still send it); writes go through to value_bool. Drop in Stage 1.5.
// `selectedOptionId` lands as a plain integer placeholder — FK + options table
// arrive in Stage 2 alongside multiple_choice support.
export const checklistItems = pgTable("checklist_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  checklistId: integer("checklist_id").references(() => checklists.id, { onDelete: "cascade" }).notNull(),
  sectionId: integer("section_id").references(() => checklistSections.id, { onDelete: "set null" }),
  label: text("label").notNull(),
  fieldType: checklistFieldTypeEnum("field_type").default("yes_no").notNull(),
  notes: text("notes"),
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id),
  photosRequired: boolean("photos_required").default(false).notNull(),
  checked: boolean("checked").default(false).notNull(),
  valueBool: boolean("value_bool"),
  valueRating: integer("value_rating"),
  valueText: text("value_text"),
  // FK added in Stage 2 — references checklistItemOptions(id) ON DELETE SET NULL.
  // Forward-ref via lazy function is fine; Drizzle resolves at codegen time.
  selectedOptionId: integer("selected_option_id").references((): any => checklistItemOptions.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at"),
  sortOrder: integer("sort_order").default(0).notNull(),
}, (table) => [
  index("checklist_items_section_idx").on(table.sectionId),
  index("checklist_items_assigned_idx").on(table.assignedToUserId),
]);

// Stage 2 — per-item answer options for fieldType='multiple_choice'.
// Cascade-delete with parent item; selected_option_id on the parent FK
// nulls out via ON DELETE SET NULL when a chosen option is deleted.
export const checklistItemOptions = pgTable("checklist_item_options", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id").references(() => checklistItems.id, { onDelete: "cascade" }).notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("checklist_item_options_item_sort_idx").on(table.itemId, table.sortOrder),
]);

// Stage 2 — per-item photo attachments. Join row only; the underlying media
// row is not deleted on detach (other things may reference it). No updated_at
// on purpose — re-attach is delete + create.
export const checklistItemPhotos = pgTable("checklist_item_photos", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id").references(() => checklistItems.id, { onDelete: "cascade" }).notNull(),
  mediaId: integer("media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("checklist_item_photos_item_sort_idx").on(table.itemId, table.sortOrder),
]);

// ─── Reports (new structured shape, session 37 rewrite) ───────────────────────
// coverConfig jsonb shape (Stage 1):
//   {
//     showCoverPhoto: boolean,
//     showCompanyLogo: boolean,
//     showCompanyName: boolean,
//     showCreatorName: boolean,
//     showPhotoCount: boolean,
//     showDateCreated: boolean,
//     coverPhotoMediaId: number | null   // Stage 2 will populate; field reserved
//   }
// Title and description are always-rendered first-class columns (not toggles).
export const reports = pgTable("reports", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  coverConfig: jsonb("cover_config").notNull().default(sql`'{}'::jsonb`),
  status: reportStatusEnum("status").default("draft").notNull(),
  shareToken: varchar("share_token", { length: 32 }),
  lastPdfAt: timestamp("last_pdf_at"), // set by the authenticated PDF export route only
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("reports_project_id_idx").on(table.projectId),
  index("reports_account_id_idx").on(table.accountId),
]);

export const reportSections = pgTable("report_sections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  reportId: integer("report_id").references(() => reports.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  sortOrder: integer("sort_order").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("report_sections_report_sort_idx").on(table.reportId, table.sortOrder),
]);

export const reportSectionPhotos = pgTable("report_section_photos", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sectionId: integer("section_id").references(() => reportSections.id, { onDelete: "cascade" }).notNull(),
  mediaId: integer("media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  caption: text("caption"),
  description: text("description"),
  sortOrder: integer("sort_order").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("report_section_photos_section_sort_idx").on(table.sectionId, table.sortOrder),
]);

export const checklistTemplates = pgTable("checklist_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description"),
  accountId: varchar("account_id").references(() => accounts.id),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Stage 3 — sections on templates, mirroring checklist_sections. Cascade
// delete with the parent template; setting items.section_id NULL on section
// delete drops them into the "Untitled" virtual group, same as instances.
export const checklistTemplateSections = pgTable("checklist_template_sections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  templateId: integer("template_id").references(() => checklistTemplates.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("checklist_template_sections_template_sort_idx").on(table.templateId, table.sortOrder),
]);

// Mirror of checklist_items minus value_*/assigned_to/completed_at. sectionId
// became a real FK in Stage 3 alongside checklist_template_sections.
export const checklistTemplateItems = pgTable("checklist_template_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  templateId: integer("template_id").references(() => checklistTemplates.id, { onDelete: "cascade" }).notNull(),
  sectionId: integer("section_id").references(() => checklistTemplateSections.id, { onDelete: "set null" }),
  label: text("label").notNull(),
  fieldType: checklistFieldTypeEnum("field_type").default("yes_no").notNull(),
  notes: text("notes"),
  photosRequired: boolean("photos_required").default(false).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
});

// Stage 3 — per-template-item answer options (multiple_choice authoring).
// Mirrors checklist_item_options. Cascades with the parent template item.
export const checklistTemplateItemOptions = pgTable("checklist_template_item_options", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  itemId: integer("item_id").references(() => checklistTemplateItems.id, { onDelete: "cascade" }).notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("checklist_template_item_options_item_sort_idx").on(table.itemId, table.sortOrder),
]);

// Report templates (new shape, session 37). Stage 1 ships the table only; the
// authoring/apply UI lands in Stage 4. templateConfig is intentionally opaque
// jsonb so the shape can evolve without further migrations.
export const reportTemplates = pgTable("report_templates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  templateConfig: jsonb("template_config").notNull().default(sql`'{}'::jsonb`),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("report_templates_account_id_idx").on(table.accountId),
]);

// Shape of report_templates.template_config jsonb. version bumps as the shape
// evolves; keep server-side parse strict and migrate stored rows lazily on read.
// coverPhotoMediaId intentionally OMITTED from the cover toggles — it is
// project-specific and cannot be carried by a template.
export const templateCoverConfigSchema = z.object({
  showCoverPhoto: z.boolean(),
  showCompanyLogo: z.boolean(),
  showCompanyName: z.boolean(),
  showCreatorName: z.boolean(),
  showPhotoCount: z.boolean(),
  showDateCreated: z.boolean(),
}).strict();

export const templateSectionSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(5000).nullable(),
  sortOrder: z.number().int().min(0),
}).strict();

export const templateConfigSchema = z.object({
  version: z.literal(1),
  cover: z.object({
    description: z.string().max(2000).nullable(),
    coverConfig: templateCoverConfigSchema,
  }).strict(),
  sections: z.array(templateSectionSchema).max(50),
}).strict();

export type TemplateCoverConfig = z.infer<typeof templateCoverConfigSchema>;
export type TemplateSection = z.infer<typeof templateSectionSchema>;
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

export const sharedGalleries = pgTable("shared_galleries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  token: varchar("token", { length: 32 }).notNull().unique(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  // Snapshot galleries serve exactly these mediaIds forever. Live galleries
  // (isLive) resolve photos from the project at request time; mediaIds is
  // still stored as a record of the original selection but is not consulted
  // when serving the gallery.
  mediaIds: integer("media_ids").array().notNull(),
  isLive: boolean("is_live").default(false).notNull(),
  includeMetadata: boolean("include_metadata").default(false).notNull(),
  includeDescriptions: boolean("include_descriptions").default(false).notNull(),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const comparisonShares = pgTable("comparison_shares", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  token: varchar("token", { length: 32 }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  beforeMediaId: integer("before_media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  afterMediaId: integer("after_media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  beforeLabel: text("before_label"),
  afterLabel: text("after_label"),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("comparison_shares_token_idx").on(table.token),
]);

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

export const insertComparisonShareSchema = createInsertSchema(comparisonShares).omit({
  id: true,
  createdAt: true,
});

export type InsertComparisonShare = z.infer<typeof insertComparisonShareSchema>;
export type ComparisonShare = typeof comparisonShares.$inferSelect;

export const accountTags = pgTable("account_tags", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  name: text("name").notNull(),
  type: tagTypeEnum("type").notNull(),
  // Hex from the fixed palette in shared/tagColors.ts, or null (default
  // badge styling). Enforced at the API layer, not by the DB.
  color: text("color"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAccountTagSchema = createInsertSchema(accountTags).omit({
  id: true,
  createdAt: true,
});
export type InsertAccountTag = z.infer<typeof insertAccountTagSchema>;
export type AccountTag = typeof accountTags.$inferSelect;

// ── Client contacts ─────────────────────────────────────────────────────────
// PII WARNING: contact rows are customer PII (names, emails, phones, home
// addresses). They must NEVER appear in any public/share payload — project
// shareToken, shared galleries, comparison shares, showcases, the public
// report viewer, or any other unauthenticated surface. All contact routes
// are admin/manager only.
export const contactTypeEnum = pgEnum("contact_type", ["owner", "renter", "property_manager", "gc", "other"]);
export const recapFrequencyEnum = pgEnum("recap_frequency", ["none", "daily", "weekly"]);

// Account-scoped person directory (non-user people: homeowners, GCs,
// property managers). Per-project role/prefs live on project_contacts.
export const contacts = pgTable("contacts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "cascade" }).notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  // Nullable — not every contact has one; recap emails require it at
  // opt-in time (enforced by the recap feature, not the DB).
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  notes: text("notes"),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("contacts_account_id_idx").on(table.accountId),
]);

// Join row = the (contact, project) relationship: contact type is
// per-project (same person can be "gc" on one job, "owner" on another),
// and it doubles as the recap-email subscription row (frequency,
// unsubscribe token, last-sent bookkeeping).
export const projectContacts = pgTable("project_contacts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  contactType: contactTypeEnum("contact_type").notNull().default("owner"),
  recapFrequency: recapFrequencyEnum("recap_frequency").notNull().default("none"),
  // Generated by the recap feature at opt-in time; nullable and unwritten
  // until then. Unique when present (partial index in the migration).
  unsubscribeToken: varchar("unsubscribe_token", { length: 32 }),
  lastRecapSentAt: timestamp("last_recap_sent_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("project_contacts_project_contact_idx").on(table.projectId, table.contactId),
  index("project_contacts_contact_id_idx").on(table.contactId),
  uniqueIndex("project_contacts_unsubscribe_token_idx").on(table.unsubscribeToken).where(sql`${table.unsubscribeToken} IS NOT NULL`),
]);

export type Contact = typeof contacts.$inferSelect;
export type ProjectContact = typeof projectContacts.$inferSelect;

export const contactTypeSchema = z.enum(["owner", "renter", "property_manager", "gc", "other"]);
export const recapFrequencySchema = z.enum(["none", "daily", "weekly"]);

const contactFieldsSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().max(100).nullable().optional(),
  email: z.string().trim().email().max(255).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
});
export const createContactSchema = contactFieldsSchema.strict();
export const updateContactSchema = contactFieldsSchema.partial().strict();
export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

// Attach: either an existing contactId OR an inline contact to create-and-
// attach — exactly one of the two.
export const attachProjectContactSchema = z.object({
  contactId: z.number().int().positive().optional(),
  contact: createContactSchema.optional(),
  contactType: contactTypeSchema.default("owner"),
  recapFrequency: recapFrequencySchema.default("none"),
}).strict().refine((v) => !!v.contactId !== !!v.contact, {
  message: "Provide exactly one of contactId or contact",
});
export const updateProjectContactSchema = z.object({
  contactType: contactTypeSchema.optional(),
  recapFrequency: recapFrequencySchema.optional(),
}).strict();

// ── Project messaging ────────────────────────────────────────────────────
// One thread per project. Mentions are stored as a validated array of user
// ids (varchar, matching users.id) — display names are resolved at render
// time, never stored. Deliberately separate from the media-scoped comments
// table: different auth path (userCanAccessProject), different lifecycle.
export const projectMessages = pgTable("project_messages", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  content: text("content").notNull(),
  // Server-validated mentioned user ids (invalid/out-of-visibility ids are
  // silently dropped at POST time — see routes).
  mentions: varchar("mentions").array().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("project_messages_project_created_idx").on(table.projectId, table.createdAt),
]);

// Per-user-per-thread last-read watermark. Absent row = everything unread.
export const projectThreadReads = pgTable("project_thread_reads", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  lastReadAt: timestamp("last_read_at").notNull(),
}, (table) => [
  uniqueIndex("project_thread_reads_project_user_idx").on(table.projectId, table.userId),
]);

// Personally-directed notification inbox rows (mentions, task assignments).
// NOT an activity feed — /api/activity stays computed on the fly.
export const notifications = pgTable("notifications", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "cascade" }).notNull(),
  type: text("type").notNull(), // "project_mention" | "task_assigned"
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
  messageId: integer("message_id").references(() => projectMessages.id, { onDelete: "cascade" }),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  actorUserId: varchar("actor_user_id").references(() => users.id),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("notifications_user_created_idx").on(table.userId, table.createdAt),
  index("notifications_user_unread_idx").on(table.userId).where(sql`${table.readAt} IS NULL`),
]);

export type ProjectMessage = typeof projectMessages.$inferSelect;
export type ProjectThreadRead = typeof projectThreadReads.$inferSelect;
export type Notification = typeof notifications.$inferSelect;

export const createProjectMessageSchema = z.object({
  content: z.string().trim().min(1).max(5000),
  mentions: z.array(z.string().trim().min(1)).max(50).default([]),
}).strict();
export type CreateProjectMessageInput = z.infer<typeof createProjectMessageSchema>;

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

export const timeEntries = pgTable("time_entries", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "restrict" }).notNull(),
  clockIn: timestamp("clock_in", { withTimezone: true }).notNull(),
  clockOut: timestamp("clock_out", { withTimezone: true }),
  source: timeEntrySourceEnum("source").default("manual").notNull(),
  notes: text("notes"),
  rateCentsSnapshot: integer("rate_cents_snapshot"),
  editedByUserId: varchar("edited_by_user_id").references(() => users.id),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  originalClockIn: timestamp("original_clock_in", { withTimezone: true }),
  originalClockOut: timestamp("original_clock_out", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("time_entries_account_user_clock_in_idx").on(table.accountId, table.userId, table.clockIn.desc()),
  index("time_entries_account_project_clock_in_idx").on(table.accountId, table.projectId, table.clockIn.desc()),
  uniqueIndex("time_entries_one_active_per_user").on(table.userId).where(sql`clock_out IS NULL`),
]);

export const insertTimeEntrySchema = createInsertSchema(timeEntries, {
  clockIn: z.coerce.date(),
  clockOut: z.coerce.date().nullable().optional(),
  editedAt: z.coerce.date().nullable().optional(),
  originalClockIn: z.coerce.date().nullable().optional(),
  originalClockOut: z.coerce.date().nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTimeEntry = z.infer<typeof insertTimeEntrySchema>;
export type TimeEntry = typeof timeEntries.$inferSelect;

export const timeEntriesRelations = relations(timeEntries, ({ one }) => ({
  project: one(projects, { fields: [timeEntries.projectId], references: [projects.id] }),
  user: one(users, { fields: [timeEntries.userId], references: [users.id] }),
  editedBy: one(users, { fields: [timeEntries.editedByUserId], references: [users.id] }),
}));

// ============================================================
// S32a: pending auto clock-out (geofence exit debounce)
// ============================================================

export const pendingExitStatusEnum = pgEnum("pending_exit_status", [
  "pending", "fired", "cancelled", "failed",
]);

export const pendingGeofenceExits = pgTable("pending_geofence_exits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  timeEntryId: varchar("time_entry_id").references(() => timeEntries.id, { onDelete: "cascade" }).notNull(),
  exitDetectedAt: timestamp("exit_detected_at", { withTimezone: true }).defaultNow().notNull(),
  firesAt: timestamp("fires_at", { withTimezone: true }).notNull(),
  status: pendingExitStatusEnum("status").default("pending").notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  firedAt: timestamp("fired_at", { withTimezone: true }),
  // `notes` is double-duty: stores error text for status='failed' AND short tags
  // like "already_clocked_out" or "time_entry_missing" for clean status='fired' rows.
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("pending_geofence_exits_status_fires_at_idx").on(table.status, table.firesAt),
  index("pending_geofence_exits_user_project_status_idx").on(table.userId, table.projectId, table.status),
  uniqueIndex("pending_geofence_exits_one_pending_per_entry")
    .on(table.timeEntryId)
    .where(sql`status = 'pending'`),
]);

export const insertPendingGeofenceExitSchema = createInsertSchema(pendingGeofenceExits, {
  exitDetectedAt: z.coerce.date().optional(),
  firesAt: z.coerce.date(),
  cancelledAt: z.coerce.date().nullable().optional(),
  firedAt: z.coerce.date().nullable().optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPendingGeofenceExit = z.infer<typeof insertPendingGeofenceExitSchema>;
export type PendingGeofenceExit = typeof pendingGeofenceExits.$inferSelect;

// S33 (session 45): mirror of pending_geofence_exits for auto clock-IN dwell verification.
// Structural deviations from the exits table:
//   - No timeEntryId (no active session at enter-time).
//   - Partial unique index keys on (user_id, project_id) instead.
//   - Adds createdTimeEntryId (FK SET NULL): populated by the cron when the row fires
//     successfully, giving downstream consumers (e.g. /auto-undo) a precise pointer to
//     the time_entries row this debounce produced.
export const pendingEnterStatusEnum = pgEnum("pending_enter_status", [
  "pending", "fired", "cancelled", "failed",
]);

export const pendingGeofenceEnters = pgTable("pending_geofence_enters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  enterDetectedAt: timestamp("enter_detected_at", { withTimezone: true }).defaultNow().notNull(),
  firesAt: timestamp("fires_at", { withTimezone: true }).notNull(),
  status: pendingEnterStatusEnum("status").default("pending").notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  firedAt: timestamp("fired_at", { withTimezone: true }),
  // Same dual-use convention as pending_geofence_exits.notes:
  //   - status='failed' → error text
  //   - status='fired'  → optional short tag ("already_clocked_in",
  //     "auto_tracking_disabled", "timesheet_disabled", "project_missing_or_moved")
  notes: text("notes"),
  createdTimeEntryId: varchar("created_time_entry_id").references(() => timeEntries.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("pending_geofence_enters_status_fires_at_idx").on(table.status, table.firesAt),
  index("pending_geofence_enters_user_project_status_idx").on(table.userId, table.projectId, table.status),
  uniqueIndex("pending_geofence_enters_one_pending_per_user_project")
    .on(table.userId, table.projectId)
    .where(sql`status = 'pending'`),
]);

export const insertPendingGeofenceEnterSchema = createInsertSchema(pendingGeofenceEnters, {
  enterDetectedAt: z.coerce.date().optional(),
  firesAt: z.coerce.date(),
  cancelledAt: z.coerce.date().nullable().optional(),
  firedAt: z.coerce.date().nullable().optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPendingGeofenceEnter = z.infer<typeof insertPendingGeofenceEnterSchema>;
export type PendingGeofenceEnter = typeof pendingGeofenceEnters.$inferSelect;

// S46: account-wide camera/capture preferences. WIRE format (colons) — never
// the DB enum format (underscores). Storage layer translates at the boundary.
export type PhotoAspectRatio = "4:3" | "1:1" | "16:9";
export type AccountSettings = {
  defaultPhotoAspectRatio: PhotoAspectRatio;
  photoOverlayEnabled: boolean;
  industry: string | null;
  aiContext: string | null;
};
export const photoAspectRatioWireSchema = z.enum(["4:3", "1:1", "16:9"]);
const accountIndustrySchema = z.string().refine(
  (value) => (INDUSTRY_VALUES as readonly string[]).includes(value),
  "Invalid industry",
);
const aiContextSchema = z.string().trim().refine(
  (value) => !value || value.split(/\s+/).length <= 500,
  "Business context must be 500 words or fewer",
);
export const accountSettingsPatchSchema = z.object({
  defaultPhotoAspectRatio: photoAspectRatioWireSchema.optional(),
  photoOverlayEnabled: z.boolean().optional(),
  industry: accountIndustrySchema.nullable().optional(),
  aiContext: aiContextSchema.nullable().optional(),
}).strict();
export type AccountSettingsPatch = z.infer<typeof accountSettingsPatchSchema>;

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
  sections: many(checklistSections),
}));

export const checklistSectionsRelations = relations(checklistSections, ({ one, many }) => ({
  checklist: one(checklists, { fields: [checklistSections.checklistId], references: [checklists.id] }),
  items: many(checklistItems),
}));

export const checklistItemsRelations = relations(checklistItems, ({ one, many }) => ({
  checklist: one(checklists, { fields: [checklistItems.checklistId], references: [checklists.id] }),
  section: one(checklistSections, { fields: [checklistItems.sectionId], references: [checklistSections.id] }),
  assignedTo: one(users, { fields: [checklistItems.assignedToUserId], references: [users.id] }),
  options: many(checklistItemOptions),
  photos: many(checklistItemPhotos),
}));

export const checklistItemOptionsRelations = relations(checklistItemOptions, ({ one }) => ({
  item: one(checklistItems, { fields: [checklistItemOptions.itemId], references: [checklistItems.id] }),
}));

export const checklistItemPhotosRelations = relations(checklistItemPhotos, ({ one }) => ({
  item: one(checklistItems, { fields: [checklistItemPhotos.itemId], references: [checklistItems.id] }),
  media: one(media, { fields: [checklistItemPhotos.mediaId], references: [media.id] }),
}));

export const reportsRelations = relations(reports, ({ one, many }) => ({
  project: one(projects, { fields: [reports.projectId], references: [projects.id] }),
  createdBy: one(users, { fields: [reports.createdById], references: [users.id] }),
  sections: many(reportSections),
}));

export const reportSectionsRelations = relations(reportSections, ({ one, many }) => ({
  report: one(reports, { fields: [reportSections.reportId], references: [reports.id] }),
  photos: many(reportSectionPhotos),
}));

export const reportSectionPhotosRelations = relations(reportSectionPhotos, ({ one }) => ({
  section: one(reportSections, { fields: [reportSectionPhotos.sectionId], references: [reportSections.id] }),
  media: one(media, { fields: [reportSectionPhotos.mediaId], references: [media.id] }),
}));

export const checklistTemplatesRelations = relations(checklistTemplates, ({ many }) => ({
  items: many(checklistTemplateItems),
  sections: many(checklistTemplateSections),
}));

export const checklistTemplateSectionsRelations = relations(checklistTemplateSections, ({ one, many }) => ({
  template: one(checklistTemplates, { fields: [checklistTemplateSections.templateId], references: [checklistTemplates.id] }),
  items: many(checklistTemplateItems),
}));

export const checklistTemplateItemsRelations = relations(checklistTemplateItems, ({ one, many }) => ({
  template: one(checklistTemplates, { fields: [checklistTemplateItems.templateId], references: [checklistTemplates.id] }),
  section: one(checklistTemplateSections, { fields: [checklistTemplateItems.sectionId], references: [checklistTemplateSections.id] }),
  options: many(checklistTemplateItemOptions),
}));

export const checklistTemplateItemOptionsRelations = relations(checklistTemplateItemOptions, ({ one }) => ({
  item: one(checklistTemplateItems, { fields: [checklistTemplateItemOptions.itemId], references: [checklistTemplateItems.id] }),
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

// No createInsertSchema for projectFiles: the drizzle-zod version in this
// repo makes .omit() a TS error (boolean-not-assignable-to-never, same as the
// pre-existing errors on the other insert schemas) and nothing consumes it —
// routes validate fields explicitly and InsertProjectFile comes from
// $inferInsert below.

export const insertCommentSchema = createInsertSchema(comments).omit({
  id: true,
  createdAt: true,
});

const baseStrokeSchema = z.object({
  id: z.string(),
  type: z.enum(["pencil", "arrow", "rectangle", "circle", "line"]),
  color: z.string(),
  width: z.number(),
  points: z.array(z.object({ x: z.number(), y: z.number() })),
});

const textAnnotationSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  x: z.number(),
  y: z.number(),
  content: z.string().min(1).max(500),
  color: z.string(),
  fontSize: z.number().min(8).max(96).default(18),
  // ADDITIVE (July 2026): normalized font size as a 0–1 fraction of image
  // height. fontSize stays required with unchanged meaning — legacy mobile
  // builds still read/write absolute px and cannot be force-updated.
  // Bound is a sanity cap, not 1: typedPx / fittedHeight can legitimately
  // exceed 1 on small windows (fontSize max 96 vs tiny fitted heights).
  fontSizeNorm: z.number().positive().max(4).optional(),
});

export const annotationStrokeSchema = z.union([baseStrokeSchema, textAnnotationSchema]);

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

// Note: only `id` is omitted. `completedAt` stays in the schema (always nullable
// so it's optional in the insert type) — storage.updateChecklistItem strips any
// client-supplied value and recomputes via the state machine. Adding a 2nd omit
// key here collapses drizzle-zod's type inference to `{}` for the insert type.
export const insertChecklistItemSchema = createInsertSchema(checklistItems).omit({
  id: true,
});

export const insertChecklistSectionSchema = createInsertSchema(checklistSections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Same drizzle-zod {} collapse as the section schema — extra omit keys flip
// the inferred insert type to {}. Storage uses a local concrete patch type
// where field-aware writes are needed; route handlers pass parsed.data.
export const insertChecklistItemOptionSchema = createInsertSchema(checklistItemOptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChecklistItemPhotoSchema = createInsertSchema(checklistItemPhotos).omit({
  id: true,
  createdAt: true,
});

export const insertReportSchema = createInsertSchema(reports).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertReportSectionSchema = createInsertSchema(reportSections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertReportSectionPhotoSchema = createInsertSchema(reportSectionPhotos).omit({
  id: true,
  createdAt: true,
});

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;
export type InsertMedia = z.infer<typeof insertMediaSchema>;
export type Media = typeof media.$inferSelect;

// Typed from the table (not z.infer) — the drizzle-zod version in this repo
// infers createInsertSchema types as {} (see the pre-existing TS2769 errors
// on media/comments inserts); $inferInsert gives the real column types.
export type InsertProjectFile = Omit<typeof projectFiles.$inferInsert, "id" | "createdAt">;
export type ProjectFile = typeof projectFiles.$inferSelect;
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
export type InsertChecklistSection = z.infer<typeof insertChecklistSectionSchema>;
export type ChecklistSection = typeof checklistSections.$inferSelect;
export type InsertChecklistItemOption = z.infer<typeof insertChecklistItemOptionSchema>;
export type ChecklistItemOption = typeof checklistItemOptions.$inferSelect;
export type InsertChecklistItemPhoto = z.infer<typeof insertChecklistItemPhotoSchema>;
export type ChecklistItemPhoto = typeof checklistItemPhotos.$inferSelect;
// No zod insert schema on purpose: attach validation happens in the route
// (mediaIds array shape + account/project scoping), and drizzle-zod's .omit
// on identity columns trips the known TS2322 'never' quirk in this repo.
export type InsertTaskPhoto = typeof taskPhotos.$inferInsert;
export type TaskPhoto = typeof taskPhotos.$inferSelect;
export type InsertReport = z.infer<typeof insertReportSchema>;
export type Report = typeof reports.$inferSelect;
export type InsertReportSection = z.infer<typeof insertReportSectionSchema>;
export type ReportSection = typeof reportSections.$inferSelect;
export type InsertReportSectionPhoto = z.infer<typeof insertReportSectionPhotoSchema>;
export type ReportSectionPhoto = typeof reportSectionPhotos.$inferSelect;

export const insertChecklistTemplateSchema = createInsertSchema(checklistTemplates).omit({
  id: true,
  createdAt: true,
});

export const insertChecklistTemplateItemSchema = createInsertSchema(checklistTemplateItems).omit({
  id: true,
});

export const insertChecklistTemplateSectionSchema = createInsertSchema(checklistTemplateSections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertChecklistTemplateItemOptionSchema = createInsertSchema(checklistTemplateItemOptions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertReportTemplateSchema = createInsertSchema(reportTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChecklistTemplate = z.infer<typeof insertChecklistTemplateSchema>;
export type ChecklistTemplate = typeof checklistTemplates.$inferSelect;
export type InsertChecklistTemplateItem = z.infer<typeof insertChecklistTemplateItemSchema>;
export type ChecklistTemplateItem = typeof checklistTemplateItems.$inferSelect;
export type InsertChecklistTemplateSection = z.infer<typeof insertChecklistTemplateSectionSchema>;
export type ChecklistTemplateSection = typeof checklistTemplateSections.$inferSelect;
export type InsertChecklistTemplateItemOption = z.infer<typeof insertChecklistTemplateItemOptionSchema>;
export type ChecklistTemplateItemOption = typeof checklistTemplateItemOptions.$inferSelect;
export type InsertReportTemplate = z.infer<typeof insertReportTemplateSchema>;
export type ReportTemplate = typeof reportTemplates.$inferSelect;

// API keys — per-account, owner-generated Bearer tokens for the external
// /api/v1 API (Zapier etc.). keyHash is the sha256 hex of the full plaintext
// key; the plaintext is shown to the user exactly once at creation and never
// stored. keyPrefix (first 12 chars incl. "fv_live_") + lastFourChars are
// display-only. Soft-revoke via revokedAt (rows are never hard-deleted).
export const apiKeys = pgTable("api_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  lastFourChars: text("last_four_chars").notNull(),
  createdById: varchar("created_by_id").references(() => users.id).notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("api_keys_key_hash_idx").on(table.keyHash),
  index("api_keys_account_id_idx").on(table.accountId),
]);

export const insertApiKeySchema = createInsertSchema(apiKeys).omit({
  id: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
});
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeys.$inferSelect;

// ---------------------------------------------------------------------------
// Showcases — curated public portfolio feature (Task: Showcases).
// Privacy: public surfaces NEVER expose exact addresses or precise GPS.
// displayLat/displayLng are OBFUSCATED coordinates (city snap or ~0.5mi
// jitter) stored on the showcase; locationLabel is a city-level label.
// ---------------------------------------------------------------------------
export const showcaseStatusEnum = pgEnum("showcase_status", ["draft", "published"]);
export const showcasePairRoleEnum = pgEnum("showcase_pair_role", ["before", "after"]);

export const showcases = pgTable("showcases", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  // Unique per account (uniqueIndex below). Public URL: /p/{portfolioSlug}/{slug}
  slug: text("slug").notNull(),
  description: text("description"),
  projectTypes: text("project_types").array().default(sql`'{}'::text[]`).notNull(),
  productsUsed: text("products_used").array().default(sql`'{}'::text[]`).notNull(),
  status: showcaseStatusEnum("status").default("draft").notNull(),
  coverMediaId: integer("cover_media_id").references(() => media.id, { onDelete: "set null" }),
  displayLat: real("display_lat"),
  displayLng: real("display_lng"),
  locationLabel: text("location_label"),
  publishedAt: timestamp("published_at"),
  createdById: varchar("created_by_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("showcases_account_id_idx").on(table.accountId),
  uniqueIndex("showcases_account_slug_idx").on(table.accountId, table.slug),
]);

export const showcasePhotos = pgTable("showcase_photos", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  showcaseId: integer("showcase_id").references(() => showcases.id, { onDelete: "cascade" }).notNull(),
  mediaId: integer("media_id").references(() => media.id, { onDelete: "cascade" }).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  caption: text("caption"),
  // Before/after pairing: photos sharing a pairGroupId form one slider;
  // exactly one "before" + one "after" per group (validated server-side).
  pairGroupId: varchar("pair_group_id", { length: 36 }),
  pairRole: showcasePairRoleEnum("pair_role"),
}, (table) => [
  index("showcase_photos_showcase_id_idx").on(table.showcaseId),
  index("showcase_photos_media_id_idx").on(table.mediaId),
]);

export const showcaseSettings = pgTable("showcase_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id).notNull().unique(),
  portfolioEnabled: boolean("portfolio_enabled").default(false).notNull(),
  // Globally unique public slug: /p/{portfolioSlug}
  portfolioSlug: varchar("portfolio_slug", { length: 60 }).unique(),
  displayName: text("display_name"),
  logoUrl: text("logo_url"),
  brandColor: varchar("brand_color", { length: 9 }),
  showMap: boolean("show_map").default(true).notNull(),
  contactCtaEnabled: boolean("contact_cta_enabled").default(false).notNull(),
  contactCtaLabel: text("contact_cta_label"),
  contactCtaUrl: text("contact_cta_url"),
  introText: text("intro_text"),
  // Company-manageable project-type tag list used by the showcase editor.
  showcaseTags: text("showcase_tags").array().default(sql`'{}'::text[]`).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Mobile-app install prompt telemetry — append-only, modeled on
// showcase_views. One row per modal/banner impression or interaction.
export const appInstallPromptEvents = pgTable("app_install_prompt_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  surface: text("surface").notNull(), // 'modal' | 'banner'
  action: text("action").notNull(), // 'shown' | 'clicked_ios' | 'clicked_android' | 'dismissed'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("app_install_prompt_events_account_created_idx").on(table.accountId, table.createdAt),
]);

// AI usage metering — one row per (account, feature, month). Incremented via
// INSERT ... ON CONFLICT DO UPDATE after each successful AI generation.
export const aiUsage = pgTable("ai_usage", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "cascade" }).notNull(),
  feature: text("feature").notNull(), // 'report_generation'
  periodMonth: text("period_month").notNull(), // 'YYYY-MM'
  count: integer("count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ai_usage_account_feature_period_uniq").on(table.accountId, table.feature, table.periodMonth),
  index("ai_usage_account_id_idx").on(table.accountId),
]);

export type AiUsage = typeof aiUsage.$inferSelect;

// Append-only provider-call telemetry. This is intentionally separate from
// ai_usage: ai_usage remains the monthly admission meter, while these rows
// preserve the provider usage needed for cost analysis and future credit
// accounting. Failures have nullable usage/cost fields but still retain the
// attempted provider/model and error code.
export const aiUsageEvents = pgTable("ai_usage_events", {
  id: serial("id").primaryKey(),
  accountId: varchar("account_id").references(() => accounts.id, { onDelete: "cascade" }).notNull(),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  feature: text("feature").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheCreationTokens: integer("cache_creation_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  audioSeconds: numeric("audio_seconds", { precision: 12, scale: 3 }),
  imageCount: integer("image_count"),
  success: boolean("success").notNull(),
  errorCode: text("error_code"),
  providerRequestId: text("provider_request_id"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("ai_usage_events_account_created_idx").on(table.accountId, table.createdAt),
  index("ai_usage_events_feature_created_idx").on(table.feature, table.createdAt),
]);

export const aiUsageEventsRelations = relations(aiUsageEvents, ({ one }) => ({
  account: one(accounts, { fields: [aiUsageEvents.accountId], references: [accounts.id] }),
  user: one(users, { fields: [aiUsageEvents.userId], references: [users.id] }),
}));

export type AiUsageEvent = typeof aiUsageEvents.$inferSelect;
export type InsertAiUsageEvent = typeof aiUsageEvents.$inferInsert;

export const showcaseViews = pgTable("showcase_views", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  accountId: varchar("account_id").references(() => accounts.id).notNull(),
  // NULL showcaseId = a portfolio-level (index page) view.
  showcaseId: integer("showcase_id").references(() => showcases.id, { onDelete: "cascade" }),
  viewedAt: timestamp("viewed_at").defaultNow().notNull(),
  referrer: text("referrer"),
}, (table) => [
  index("showcase_views_account_viewed_idx").on(table.accountId, table.viewedAt),
  index("showcase_views_showcase_id_idx").on(table.showcaseId),
]);

export const insertShowcaseSchema = createInsertSchema(showcases).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
});
export type InsertShowcase = z.infer<typeof insertShowcaseSchema>;
export type Showcase = typeof showcases.$inferSelect;

export const insertShowcasePhotoSchema = createInsertSchema(showcasePhotos).omit({
  id: true,
});
export type InsertShowcasePhoto = z.infer<typeof insertShowcasePhotoSchema>;
export type ShowcasePhoto = typeof showcasePhotos.$inferSelect;

export const insertShowcaseSettingsSchema = createInsertSchema(showcaseSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertShowcaseSettings = z.infer<typeof insertShowcaseSettingsSchema>;
export type ShowcaseSettings = typeof showcaseSettings.$inferSelect;
export type ShowcaseView = typeof showcaseViews.$inferSelect;
