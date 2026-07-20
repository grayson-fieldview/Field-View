import express, { type Express } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes, isAuthenticated, requireReadAccess, requireWriteAccess } from "./replit_integrations/auth";
import { getAccountBilling, isAccountBillingEnabled, overlayAccountBillingOnUser, isSeatAddonItem } from "./lib/billing";
import { requireAdmin, requireAdminOrManager, requireOwnerAdmin } from "./middleware/auth";
import { generateApiKey } from "./lib/apiKeys";
import { normalizeEmail } from "./lib/normalizeEmail";
import { apiV1Router } from "./apiV1";
import { authStorage } from "./replit_integrations/auth/storage";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";
import { insertProjectSchema, insertCommentSchema, insertTaskSchema, insertChecklistSchema, insertChecklistItemSchema, insertChecklistSectionSchema, insertChecklistItemOptionSchema, insertChecklistTemplateSchema, insertChecklistTemplateItemSchema, insertCalendarEventSchema, annotationStrokesSchema, projects, media, comments, tasks, checklists, checklistItems, checklistSections, checklistItemOptions, checklistItemPhotos, checklistTemplates, checklistTemplateSections, checklistTemplateItems, checklistTemplateItemOptions, reports, reportSections, reportSectionPhotos, projectAssignments, timeEntries, templateConfigSchema, accountSettingsPatchSchema, apiKeys, appInstallPromptEvents } from "@shared/schema";
import { executeAutoClockOut } from "./lib/timesheets";
import { formatLocalTime } from "./lib/geo";
import { users, invitations, accounts, assignedProjectIdsSchema } from "@shared/models/auth";
import { MAX_UPLOAD_BATCH } from "@shared/constants";
import { computeSeatUsage } from "./lib/seats";
import { resolvePhotoTimeZone, formatPhotoTimestamp } from "./lib/photoTime";
import { db } from "./db";
import { eq, sql, and, or, inArray, count, isNull, desc } from "drizzle-orm";
import { sanitizeUserForViewer, sanitizeTimeEntryForViewer, isManagerRole } from "./lib/userVisibility";
import { z } from "zod";
import { getPresignedUrl, isS3Url, extractS3KeyFromUrl, getPresignedPutUrl, deleteFromS3, getObjectStream, getS3Url } from "./s3";
import archiver from "archiver";
import { sendInvitationEmail, sendAccountDeletionEmail } from "./services/email";
import { sendGhlEvent, syncUsageToGhl } from "./lib/ghl";
import { sendMetaCapiEvent } from "./lib/metaCapi";
import { isCompAccount } from "./lib/slack";
import { toCsv } from "./lib/csv";
import bcrypt from "bcryptjs";
import { registerShowcaseRoutes } from "./showcases";
import { Sentry } from "./lib/sentry";
import { sendPushNotification } from "./lib/push";
import {
  RewardfulError,
  REWARDFUL_CAMPAIGN_ID,
  createAffiliate as rewardfulCreateAffiliate,
  findAffiliateByEmail as rewardfulFindAffiliateByEmail,
  getAffiliateById as rewardfulGetAffiliateById,
  extractReferralCode,
} from "./lib/rewardful";

async function streamReportPdfById(id: number, res: any): Promise<void> {
  const data = await storage.getReportForPdf(id);
  if (!data) {
    if (!res.headersSent) res.status(404).json({ message: "Report not found" });
    return;
  }
  if (data.totalPhotos > 50) {
    if (!res.headersSent) res.status(400).json({
      message: `Report has ${data.totalPhotos} photos; PDF generation is capped at 50. Remove some photos and try again.`,
    });
    return;
  }
  const { buildReportPdfStream } = await import("./pdf/buildPdf");
  const stream = await buildReportPdfStream({
    report: {
      title: data.report.title,
      description: data.report.description,
      coverConfig: data.report.coverConfig as any,
      createdAt: data.report.createdAt,
    },
    account: {
      name: data.account.name,
      companyLogoUrl: data.account.companyLogoUrl,
      companyLegalName: data.account.companyLegalName,
      companyAddress: data.account.companyAddress,
    },
    creator: data.creator,
    projectLatitude: data.project.latitude,
    projectLongitude: data.project.longitude,
    sections: data.sections.map((s) => ({
      id: s.id,
      title: s.title,
      summary: s.summary,
      photos: s.photos.map((p) => ({
        id: p.id,
        s3Key: extractS3KeyFromUrl(p.media.url),
        caption: p.caption,
        description: p.description,
        createdAt: p.media.createdAt,
        latitude: p.media.latitude,
        longitude: p.media.longitude,
      })),
    })),
    coverPhotoUrl: data.coverPhoto?.url ?? null,
    totalPhotos: data.totalPhotos,
  });
  const slug =
    (data.report.title || "")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "report";
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${slug}-${dateStr}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  stream.on("error", (err: Error) => {
    console.error("[reports/pdf] stream error:", err);
    res.destroy();
  });
  stream.pipe(res);
}

// Single source of truth for "card on file" / usable Stripe subscription.
// Mirrors the original inline condition from POST /api/account/seats so the
// three seat-cap sites (GET seats, POST seats, invite) can't drift.
const BLOCKED_SUBSCRIPTION_STATUSES = ["canceled", "incomplete_expired", "unpaid"];
function hasUsableSubscription(acct: {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
}): boolean {
  return (
    !!acct.stripeCustomerId &&
    !!acct.stripeSubscriptionId &&
    !(acct.subscriptionStatus &&
      BLOCKED_SUBSCRIPTION_STATUSES.includes(acct.subscriptionStatus))
  );
}

// S46 GHL activation_milestone. Called fire-and-forget after every media
// batch insert. Threshold: ≥1 project AND ≥5 photos (image mime types) for
// the whole account. Idempotent via an atomic conditional UPDATE — only the
// caller whose UPDATE actually flips activated_at (rowCount 1) sends the
// event; racers see 0 rows and bail. Event identity is the account's
// originating admin (accounts.ownerId), never the uploader.
async function checkActivationMilestone(accountId: string | null): Promise<void> {
  if (!accountId) return;

  // Cheap short-circuit: already activated (the common case forever after).
  const [acct] = await db
    .select({ activatedAt: accounts.activatedAt, ownerId: accounts.ownerId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!acct || acct.activatedAt) return;

  const [projRow] = await db
    .select({ c: count() })
    .from(projects)
    .where(eq(projects.accountId, accountId));
  const projectsCreated = Number(projRow?.c ?? 0);
  if (projectsCreated < 1) return;

  const [photoRow] = await db
    .select({ c: count() })
    .from(media)
    .innerJoin(projects, eq(media.projectId, projects.id))
    .where(and(eq(projects.accountId, accountId), sql`${media.mimeType} LIKE 'image/%'`));
  const photosUploaded = Number(photoRow?.c ?? 0);
  if (photosUploaded < 5) return;

  // Atomic check-and-set: exactly one request can win this UPDATE.
  const flipped = await db
    .update(accounts)
    .set({ activatedAt: new Date() })
    .where(and(eq(accounts.id, accountId), isNull(accounts.activatedAt)))
    .returning({ activatedAt: accounts.activatedAt });
  if (flipped.length === 0) return; // lost the race — someone else fired it

  if (!acct.ownerId) return; // legacy account with no stamped owner — nothing to send
  const owner = await authStorage.getUser(acct.ownerId);
  if (!owner?.email || isCompAccount(owner.email)) return;

  sendGhlEvent("activation_milestone", {
    email: owner.email,
    app_user_id: owner.id,
    activation_status: "activated",
    activation_date: flipped[0].activatedAt?.toISOString() ?? new Date().toISOString(),
    projects_created: projectsCreated,
    photos_uploaded: photosUploaded,
  });

  // Meta CAPI "Activated" (custom event) — same win-the-atomic-UPDATE +
  // owner + isCompAccount gates as the GHL event above. No browser context
  // here (fire-and-forget helper, uploader ≠ owner), so no IP/UA; fbp/fbc
  // recovered from the owner row's signup attribution columns.
  sendMetaCapiEvent({
    eventName: "Activated",
    eventId: crypto.randomUUID(),
    email: owner.email,
    fbp: owner.signupFbp,
    fbc: owner.signupFbc,
  });
}

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

async function verifyChecklistSectionAccess(sectionId: number, accountId: string): Promise<{ ok: boolean; checklistId?: number }> {
  const [row] = await db.select({ accountId: projects.accountId, checklistId: checklists.id })
    .from(checklistSections)
    .innerJoin(checklists, eq(checklistSections.checklistId, checklists.id))
    .innerJoin(projects, eq(checklists.projectId, projects.id))
    .where(eq(checklistSections.id, sectionId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, checklistId: row.checklistId };
}

// Stage 2 — 4-table chain: option → item → checklist → project → account.
async function verifyChecklistItemAccess(itemId: number, accountId: string): Promise<{ ok: boolean; projectId?: number; checklistId?: number }> {
  const [row] = await db.select({ accountId: projects.accountId, projectId: projects.id, checklistId: checklists.id })
    .from(checklistItems)
    .innerJoin(checklists, eq(checklistItems.checklistId, checklists.id))
    .innerJoin(projects, eq(checklists.projectId, projects.id))
    .where(eq(checklistItems.id, itemId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, projectId: row.projectId, checklistId: row.checklistId };
}

async function verifyChecklistOptionAccess(optionId: number, accountId: string): Promise<{ ok: boolean; itemId?: number }> {
  const [row] = await db.select({ accountId: projects.accountId, itemId: checklistItemOptions.itemId })
    .from(checklistItemOptions)
    .innerJoin(checklistItems, eq(checklistItemOptions.itemId, checklistItems.id))
    .innerJoin(checklists, eq(checklistItems.checklistId, checklists.id))
    .innerJoin(projects, eq(checklists.projectId, projects.id))
    .where(eq(checklistItemOptions.id, optionId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, itemId: row.itemId };
}

// Stage 3 — template ownership-chain access checks. Templates live at the
// account level (no project pivot) so the chain is short. Item / option
// chains pivot through their parent template.
async function verifyChecklistTemplateAccess(templateId: number, accountId: string): Promise<boolean> {
  const [row] = await db.select({ accountId: checklistTemplates.accountId })
    .from(checklistTemplates)
    .where(eq(checklistTemplates.id, templateId))
    .limit(1);
  return !!row && row.accountId === accountId;
}

async function verifyChecklistTemplateSectionAccess(sectionId: number, accountId: string): Promise<{ ok: boolean; templateId?: number }> {
  const [row] = await db.select({ accountId: checklistTemplates.accountId, templateId: checklistTemplateSections.templateId })
    .from(checklistTemplateSections)
    .innerJoin(checklistTemplates, eq(checklistTemplateSections.templateId, checklistTemplates.id))
    .where(eq(checklistTemplateSections.id, sectionId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, templateId: row.templateId };
}

async function verifyChecklistTemplateItemAccess(itemId: number, accountId: string): Promise<{ ok: boolean; templateId?: number }> {
  const [row] = await db.select({ accountId: checklistTemplates.accountId, templateId: checklistTemplateItems.templateId })
    .from(checklistTemplateItems)
    .innerJoin(checklistTemplates, eq(checklistTemplateItems.templateId, checklistTemplates.id))
    .where(eq(checklistTemplateItems.id, itemId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, templateId: row.templateId };
}

async function verifyChecklistTemplateOptionAccess(optionId: number, accountId: string): Promise<{ ok: boolean; itemId?: number }> {
  const [row] = await db.select({ accountId: checklistTemplates.accountId, itemId: checklistTemplateItemOptions.itemId })
    .from(checklistTemplateItemOptions)
    .innerJoin(checklistTemplateItems, eq(checklistTemplateItemOptions.itemId, checklistTemplateItems.id))
    .innerJoin(checklistTemplates, eq(checklistTemplateItems.templateId, checklistTemplates.id))
    .where(eq(checklistTemplateItemOptions.id, optionId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, itemId: row.itemId };
}

async function verifyChecklistItemPhotoAccess(joinId: number, accountId: string): Promise<{ ok: boolean; itemId?: number }> {
  const [row] = await db.select({ accountId: projects.accountId, itemId: checklistItemPhotos.itemId })
    .from(checklistItemPhotos)
    .innerJoin(checklistItems, eq(checklistItemPhotos.itemId, checklistItems.id))
    .innerJoin(checklists, eq(checklistItems.checklistId, checklists.id))
    .innerJoin(projects, eq(checklists.projectId, projects.id))
    .where(eq(checklistItemPhotos.id, joinId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, itemId: row.itemId };
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
  const [row] = await db.select({ accountId: reports.accountId })
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);
  return !!row && row.accountId === accountId;
}

async function verifyReportSectionAccess(sectionId: number, accountId: string): Promise<{ ok: boolean; reportId?: number; projectId?: number }> {
  const [row] = await db.select({ accountId: reports.accountId, reportId: reports.id, projectId: reports.projectId })
    .from(reportSections)
    .innerJoin(reports, eq(reportSections.reportId, reports.id))
    .where(eq(reportSections.id, sectionId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, reportId: row.reportId, projectId: row.projectId };
}

async function verifyReportSectionPhotoAccess(photoId: number, accountId: string): Promise<{ ok: boolean; projectId?: number }> {
  const [row] = await db.select({ accountId: reports.accountId, projectId: reports.projectId })
    .from(reportSectionPhotos)
    .innerJoin(reportSections, eq(reportSectionPhotos.sectionId, reportSections.id))
    .innerJoin(reports, eq(reportSections.reportId, reports.id))
    .where(eq(reportSectionPhotos.id, photoId))
    .limit(1);
  if (!row || row.accountId !== accountId) return { ok: false };
  return { ok: true, projectId: row.projectId };
}

// Restricted users can only touch projects they created or are assigned to.
// Project-resolving variants chain tenant + role checks for report endpoints.
async function userCanAccessProject(req: any, projectId: number): Promise<boolean> {
  const project = await storage.getProject(projectId);
  if (!project || project.accountId !== req.user.accountId) return false;
  if (req.user.role !== "restricted") return true;
  const [a] = await db.select().from(projectAssignments)
    .where(and(eq(projectAssignments.projectId, projectId), eq(projectAssignments.userId, req.user.id)))
    .limit(1);
  return !!a || project.createdById === req.user.id;
}

async function verifyReportFullAccess(req: any, reportId: number): Promise<{ ok: boolean; projectId?: number }> {
  const [row] = await db.select({ accountId: reports.accountId, projectId: reports.projectId })
    .from(reports).where(eq(reports.id, reportId)).limit(1);
  if (!row || row.accountId !== req.user.accountId) return { ok: false };
  if (!(await userCanAccessProject(req, row.projectId))) return { ok: false };
  return { ok: true, projectId: row.projectId };
}

async function verifyReportSectionFullAccess(req: any, sectionId: number): Promise<{ ok: boolean; reportId?: number; projectId?: number }> {
  const access = await verifyReportSectionAccess(sectionId, req.user.accountId);
  if (!access.ok || !access.projectId) return { ok: false };
  if (!(await userCanAccessProject(req, access.projectId))) return { ok: false };
  return access;
}

async function verifyReportSectionPhotoFullAccess(req: any, photoId: number): Promise<{ ok: boolean; projectId?: number }> {
  const access = await verifyReportSectionPhotoAccess(photoId, req.user.accountId);
  if (!access.ok || !access.projectId) return { ok: false };
  if (!(await userCanAccessProject(req, access.projectId))) return { ok: false };
  return access;
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

const APP_PROMPT_SURFACES = ["modal", "banner"];
const APP_PROMPT_ACTIONS = ["shown", "clicked_ios", "clicked_android", "dismissed"];

// Set-once flag: first time ANY team member persists media from the mobile
// app (detected via the X-FieldView-Client header the mobile fetch wrapper
// sends on every non-GET request). Atomic conditional UPDATE — same
// idempotency pattern as activatedAt in checkActivationMilestone(). Fire-and-
// forget: must never fail or delay the upload response.
async function markFirstMobileUpload(accountId: string): Promise<void> {
  await db
    .update(accounts)
    .set({ firstMobileUploadAt: new Date() })
    .where(and(eq(accounts.id, accountId), isNull(accounts.firstMobileUploadAt)));
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  await setupAuth(app);
  registerAuthRoutes(app);
  registerShowcaseRoutes(app);

  // Install-prompt telemetry (modal/banner shown/clicked/dismissed).
  // Append-only, returns 204 immediately after a single insert.
  app.post("/api/app-install-prompt-events", isAuthenticated, async (req: any, res) => {
    try {
      const surface = req.body?.surface;
      const action = req.body?.action;
      if (!APP_PROMPT_SURFACES.includes(surface) || !APP_PROMPT_ACTIONS.includes(action)) {
        return res.status(400).json({ message: "Invalid surface or action" });
      }
      if (!req.user?.accountId) return res.status(400).json({ message: "No account" });
      await db.insert(appInstallPromptEvents).values({
        accountId: req.user.accountId,
        userId: req.user.id,
        surface,
        action,
      });
      res.status(204).end();
    } catch (error: any) {
      console.error("App install prompt event error:", error?.message || error);
      res.status(500).json({ message: "Failed to record event" });
    }
  });

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

  // Stub for pre-v1.1.0 mobile builds polling removed geofence feature.
  // Returns empty so old clients no-op. Remove after mobile install base
  // fully migrates. MUST be registered BEFORE /api/projects/:id or the :id
  // route captures "geofence-eligible" as a project ID (NaN -> 500).
  app.get("/api/projects/geofence-eligible", requireReadAccess, async (_req: any, res) => {
    res.json([]);
  });

  app.get("/api/projects/:id", requireReadAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(404).json({ message: "Project not found" });
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
      console.error("[API] GET /api/projects/:id failed:", error);
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
      if (Number.isNaN(id)) return res.status(404).json({ message: "Project not found" });
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
      console.error("[API] PATCH /api/projects/:id failed:", error);
      res.status(500).json({ message: "Failed to update project" });
    }
  });

  app.delete("/api/projects/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(404).json({ message: "Project not found" });
      const project = await storage.getProject(id);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (project.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      // Restricted users may NEVER delete a project, even ones they own or are
      // assigned to. Only standard/manager/admin (already past requireWriteAccess)
      // may proceed.
      if (req.user.role === "restricted") {
        return res.status(403).json({ message: "Access denied" });
      }
      // Explicit pre-check: time_entries FK is onDelete:"restrict", so a project
      // with logged time would otherwise fail with a caught Postgres error (500).
      // Surface a clear 409 instead of relying on the FK violation.
      const [{ value: timeEntryCount }] = await db
        .select({ value: count() })
        .from(timeEntries)
        .where(eq(timeEntries.projectId, id));
      if (timeEntryCount > 0) {
        return res.status(409).json({ message: "This project has logged time entries and can't be deleted" });
      }
      await storage.deleteProject(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      console.error("[API] DELETE /api/projects/:id failed:", error);
      res.status(500).json({ message: "Failed to delete project" });
    }
  });

  app.post("/api/uploads/sign", requireWriteAccess, async (req: any, res) => {
    try {
      const files = req.body?.files;
      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ message: "Provide a non-empty 'files' array" });
      }
      if (files.length > MAX_UPLOAD_BATCH) {
        return res.status(400).json({ message: `Cannot sign more than ${MAX_UPLOAD_BATCH} files at once` });
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
          const folder = f.folder === "branding" ? "branding"
                       : f.folder === "checklists" ? "checklists"
                       : "photos";
          return getPresignedPutUrl(f.originalName, f.mimeType, folder, f.fileSize);
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
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
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
      if (items.length > MAX_UPLOAD_BATCH) {
        return res.status(400).json({ message: `Cannot save more than ${MAX_UPLOAD_BATCH} media items at once` });
      }

      const caption = req.body.caption || null;
      const tags = Array.isArray(req.body.tags)
        ? req.body.tags.filter(Boolean)
        : (typeof req.body.tags === "string"
            ? req.body.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
            : []);

      const mediaRows = items.map((it: any) => {
        if (!it?.key || !it?.publicUrl || !it?.originalName || !it?.mimeType) {
          throw new Error("Each file must include key, publicUrl, originalName, and mimeType");
        }
        return {
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
        };
      });

      // Single bulk insert (one round-trip) instead of N individual inserts,
      // so a 100-file batch doesn't open N connections against the RDS pool.
      const created = await storage.createMediaBatch(mediaRows);

      // S46 GHL activation_milestone — account crosses ≥1 project AND ≥5
      // photos. Fully fire-and-forget (doesn't delay the upload response).
      // Idempotency: atomic conditional UPDATE ... WHERE activated_at IS NULL;
      // only the request that flips the row (rowCount=1) sends the event, so
      // concurrent batch uploads can't double-fire. The event identity is the
      // account's ORIGINATING ADMIN (accounts.ownerId — same rule as
      // partial_signup/trial_started), not the uploading team member.
      checkActivationMilestone(project.accountId).catch((err) =>
        console.error("[ghl] activation_milestone check failed (non-fatal):", err));

      // Mobile-app source attribution: the mobile fetch wrapper sends
      // X-FieldView-Client: mobile-1 on every non-GET request (see CSRF
      // middleware). First mobile-sourced media persist flips the account's
      // set-once first_mobile_upload_at, which suppresses the web app's
      // install prompt/banner. Fire-and-forget — never fails the upload.
      try {
        const clientHeader = String(req.headers["x-fieldview-client"] || "");
        if (clientHeader.startsWith("mobile")) {
          markFirstMobileUpload(project.accountId!).catch((err) =>
            console.error("[app-prompt] first_mobile_upload_at update failed (non-fatal):", err));
        }
      } catch {}

      res.status(201).json(await presignMediaUrls(created));
    } catch (error: any) {
      console.error("Create media error:", error?.message || error);
      res.status(500).json({ message: error?.message || "Failed to save media" });
    }
  });

  const downloadMediaSchema = z.object({
    mediaIds: z.array(z.number().int().positive()).min(1).max(50),
  });

  app.post("/api/projects/:id/media/download", requireReadAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
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

      const parsed = downloadMediaSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request body" });
      }

      const requestedIds = new Set(parsed.data.mediaIds);
      const allMedia = await storage.getMediaByProject(projectId);
      const targets = allMedia.filter((m) => requestedIds.has(m.id));
      if (targets.length === 0) {
        return res.status(400).json({ message: "No matching media found" });
      }

      const slug =
        (project.name || "")
          .replace(/[^a-z0-9]+/gi, "-")
          .toLowerCase()
          .replace(/^-+|-+$/g, "")
          .slice(0, 50) || "project";
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `${slug}-photos-${dateStr}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store");

      const archive = archiver("zip", { store: true });
      archive.on("error", (err) => {
        console.error("[media-download] archive error:", err);
        res.destroy();
      });
      archive.pipe(res);

      const errors: Array<{ name: string; error: string }> = [];
      const usedNames = new Map<string, number>();
      const dedupe = (raw: string): string => {
        let safe = raw.replace(/[\/\\]/g, "_").replace(/^\.+/, "").trim();
        if (!safe) safe = "file";
        const lower = safe.toLowerCase();
        const count = usedNames.get(lower) || 0;
        usedNames.set(lower, count + 1);
        if (count === 0) return safe;
        const dot = safe.lastIndexOf(".");
        if (dot > 0) {
          return `${safe.slice(0, dot)} (${count + 1})${safe.slice(dot)}`;
        }
        return `${safe} (${count + 1})`;
      };

      for (const m of targets) {
        const key = extractS3KeyFromUrl(m.url);
        const entryName = dedupe(m.originalName || `media-${m.id}.bin`);
        if (!key) {
          errors.push({ name: entryName, error: "Could not extract S3 key from URL" });
          continue;
        }
        try {
          const stream = await getObjectStream(key);
          archive.append(stream, { name: entryName });
        } catch (err: any) {
          console.error("[API] POST /api/projects/:id/media/download failed:", err);
          errors.push({ name: entryName, error: err?.message || "S3 fetch failed" });
        }
      }

      if (errors.length > 0) {
        const manifest = errors.map((e) => `${e.name}: ${e.error}`).join("\n");
        archive.append(manifest, { name: "_DOWNLOAD_ERRORS.txt" });
      }

      await archive.finalize();
    } catch (error: any) {
      console.error("[media-download] error:", error?.message || error);
      if (!res.headersSent) {
        res.status(500).json({ message: "Failed to download media" });
      } else {
        res.destroy();
      }
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

  // Cross-context reference inspector for a single photo. Mobile calls this
  // before offering a hard-delete confirm so the dialog can say "this photo
  // is in 1 report and 2 checklists" — and warn when one of the reports has
  // an active share token. The actual delete still goes through the existing
  // DELETE /api/media/:id (hard delete + S3 cleanup + FK cascade across the
  // four join tables). Per spec: 404 collapsed for not-found AND wrong-account
  // to avoid leaking cross-account media IDs.
  //
  // `tasks: []` is returned as a forward-compat stub — no task↔photo join
  // table exists today. When/if it lands, populate this bucket and mobile's
  // dialog picks it up without a shape change.
  app.get("/api/media/:id/references", requireReadAccess, async (req: any, res) => {
    try {
      const mediaId = parseInt(req.params.id as string);
      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        return res.status(404).json({ message: "Media not found" });
      }
      if (!(await verifyMediaAccess(mediaId, req.user.accountId))) {
        return res.status(404).json({ message: "Media not found" });
      }

      // Reports that include the photo on any of their sections. Distinct on
      // report id so a photo placed on multiple sections of one report still
      // appears once in the confirm dialog.
      const reportRows = await db
        .selectDistinct({
          id: reports.id,
          title: reports.title,
          shareToken: reports.shareToken,
          projectId: reports.projectId,
          createdById: reports.createdById,
        })
        .from(reportSectionPhotos)
        .innerJoin(reportSections, eq(reportSectionPhotos.sectionId, reportSections.id))
        .innerJoin(reports, eq(reportSections.reportId, reports.id))
        .where(eq(reportSectionPhotos.mediaId, mediaId));

      // Checklists that include the photo on any of their items. Same
      // distinct-on-id collapse so multi-item attachments don't double-count.
      const checklistRows = await db
        .selectDistinct({
          id: checklists.id,
          title: checklists.title,
          projectId: checklists.projectId,
          createdById: checklists.createdById,
        })
        .from(checklistItemPhotos)
        .innerJoin(checklistItems, eq(checklistItemPhotos.itemId, checklistItems.id))
        .innerJoin(checklists, eq(checklistItems.checklistId, checklists.id))
        .where(eq(checklistItemPhotos.mediaId, mediaId));

      // Restricted-user scoping — mirrors /api/reports (routes.ts:1702) and
      // /api/checklists (routes.ts:1232): only surface reports/checklists
      // for projects the user created or is assigned to. Without this filter
      // the dialog would leak titles of reports/checklists the caller cannot
      // otherwise see.
      let visibleReports = reportRows;
      let visibleChecklists = checklistRows;
      if (req.user.role === "restricted") {
        const assigned = await getRestrictedAssignedProjectIds(req.user.id);
        const userId = req.user.id;
        visibleReports = reportRows.filter(r => assigned.has(r.projectId) || r.createdById === userId);
        visibleChecklists = checklistRows.filter(c => assigned.has(c.projectId) || c.createdById === userId);
      }

      res.json({
        reports: visibleReports.map(r => ({
          id: r.id,
          title: r.title,
          isShared: r.shareToken !== null,
        })),
        checklists: visibleChecklists.map(c => ({
          id: c.id,
          title: c.title,
        })),
        tasks: [],
      });
    } catch (error) {
      Sentry.captureException(error);
      console.error("[media/references] error:", error);
      res.status(500).json({ message: "Failed to fetch references" });
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
      console.error("[API] GET /api/projects/:projectId/annotations failed:", error);
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
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
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
      console.error("[API] POST /api/projects/:id/tasks failed:", error);
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
      // Idempotent atomic completion stamping. Strip completedAt from the
      // caller-controlled patch first, then do the regular update, then
      // race-safely stamp completed_at via a single conditional UPDATE that
      // only succeeds when the prior row was NOT already done AND
      // completed_at IS NULL, so concurrent PATCHes stamp exactly once.
      // Reverse moves (done→todo) intentionally do NOT clear completed_at
      // — completion is a permanent lifecycle marker.
      delete (filtered as any).completedAt;
      const updated = await storage.updateTask(id, filtered);
      if (!updated) return res.status(404).json({ message: "Task not found" });
      if (filtered.status === "done") {
        try {
          const stamp = await db.execute(sql`
            UPDATE tasks
               SET completed_at = NOW()
             WHERE id = ${id}
               AND status = 'done'
               AND completed_at IS NULL
            RETURNING id
          `);
        } catch (stampErr) {
          console.error("[task-completed-detect] failed:", stampErr);
        }
      }
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update task" });
    }
  });

  app.delete("/api/tasks/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid task id" });
      // Per spec: collapse "not in account" and "not found" both to 404 so we
      // don't leak cross-account task IDs. (PATCH above returns 403 for the
      // access-denied case — DELETE intentionally diverges per spec request.)
      if (!(await verifyTaskAccess(id, req.user.accountId))) {
        return res.status(404).json({ message: "Task not found" });
      }
      const deleted = await storage.deleteTask(id, req.user.accountId);
      if (!deleted) return res.status(404).json({ message: "Task not found" });
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ message: "Failed to delete task" });
    }
  });

  // Checklists
  app.get("/api/checklists", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      let all = await storage.getAllChecklists(accountId);
      // Restricted users only see checklists for projects they created or are assigned to.
      // Mirrors the reports filter at /api/reports above. Per-item assignee visibility
      // for restricted users lands in Stage 2 alongside filters.
      if (req.user.role === "restricted") {
        const assigned = await getRestrictedAssignedProjectIds(req.user.id);
        all = all.filter((c: any) => assigned.has(c.projectId) || c.createdById === req.user.id);
      }
      res.json(all);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch checklists" });
    }
  });

  app.post("/api/projects/:id/checklists", requireWriteAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
      if (!(await verifyProjectAccess(projectId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });

      // Stage 3 — server-driven template instantiation. Single POST with a
      // templateId clones every section/item/option in one transaction,
      // preserving fieldType/notes/photosRequired and multiple_choice options
      // (Stage 1+2 client-side mapping silently dropped all of these).
      if (req.body?.templateId !== undefined && req.body.templateId !== null) {
        const templateId = parseInt(req.body.templateId);
        if (!Number.isInteger(templateId) || templateId <= 0) {
          return res.status(400).json({ message: "Invalid templateId" });
        }
        const name = typeof req.body.title === "string" && req.body.title.trim()
          ? req.body.title
          : (typeof req.body.name === "string" ? req.body.name : "");
        if (!name.trim()) return res.status(400).json({ message: "title required" });
        try {
          const newId = await storage.instantiateChecklistFromTemplate(
            templateId, projectId, name.trim(), req.user.id, req.user.accountId,
          );
          const created = await storage.getChecklist(newId);
          return res.status(201).json(created);
        } catch (e: any) {
          console.error("[API] POST /api/projects/:id/checklists failed:", e);
          const msg = String(e?.message ?? "");
          if (msg === "Template not found") return res.status(404).json({ message: msg });
          if (msg === "Template not in this account") return res.status(403).json({ message: "Access denied" });
          throw e;
        }
      }

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
          const raw = req.body.items[i];
          // Backward compat: legacy callers pass an array of strings.
          const seed = typeof raw === "string"
            ? { label: raw }
            : {
                label: String(raw.label ?? ""),
                fieldType: raw.fieldType,
                notes: raw.notes ?? null,
                sectionId: raw.sectionId ?? null,
                assignedToUserId: raw.assignedToUserId ?? null,
                photosRequired: raw.photosRequired === true,
              };
          if (!seed.label) continue;
          await storage.createChecklistItem({
            checklistId: checklist.id,
            sortOrder: i,
            ...seed,
          } as any);
        }
      }

      res.status(201).json(checklist);
    } catch (error) {
      console.error("[API] POST /api/projects/:id/checklists failed:", error);
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

  // Belt-and-suspenders: ensures the requested section_id (if any) belongs to
  // the same checklist. The DB FK only guarantees the section row exists in
  // SOME checklist, so without this a guessed/leaked id could cross-link items
  // across checklists (and via that, across accounts).
  async function assertSectionInChecklist(sectionId: number | null | undefined, checklistId: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (sectionId === null || sectionId === undefined) return { ok: true };
    if (!Number.isInteger(sectionId)) return { ok: false, reason: "sectionId must be an integer" };
    const [row] = await db.select({ checklistId: checklistSections.checklistId })
      .from(checklistSections)
      .where(eq(checklistSections.id, sectionId))
      .limit(1);
    if (!row) return { ok: false, reason: "Section not found" };
    if (row.checklistId !== checklistId) return { ok: false, reason: "Section does not belong to this checklist" };
    return { ok: true };
  }

  app.post("/api/checklists/:id/items", requireWriteAccess, async (req: any, res) => {
    try {
      const checklistId = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      if ("sectionId" in req.body) {
        const check = await assertSectionInChecklist(req.body.sectionId, checklistId);
        if (!check.ok) return res.status(400).json({ message: check.reason });
      }
      const seed: Record<string, any> = {
        checklistId,
        label: req.body.label,
        sortOrder: req.body.sortOrder ?? 0,
      };
      // Optional Stage 1 fields. Pass through verbatim — Zod + storage validate.
      for (const k of ["sectionId", "fieldType", "notes", "assignedToUserId", "photosRequired",
                       "valueBool", "valueRating", "valueText"]) {
        if (k in req.body) seed[k] = req.body[k];
      }
      const parsed = insertChecklistItemSchema.safeParse(seed);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const item = await storage.createChecklistItem(parsed.data as any);
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
      // Re-link guard: a PATCH that moves the item to a different section must
      // keep it inside the same checklist. Null is allowed (move to "Untitled").
      if ("sectionId" in req.body) {
        const check = await assertSectionInChecklist(req.body.sectionId, item[0].checklistId);
        if (!check.ok) return res.status(400).json({ message: check.reason });
      }
      // Strict Zod parse: rejects unknown keys + bad types with a clean 400
      // instead of falling through to a 500 from the DB layer. `checked` is
      // retained for legacy mobile clients — storage mirrors it to value_bool.
      const patchSchema = z.object({
        label: z.string().min(1).max(500).optional(),
        checked: z.boolean().optional(),
        sortOrder: z.number().int().nonnegative().optional(),
        sectionId: z.number().int().positive().nullable().optional(),
        fieldType: z.enum(["yes_no", "rating", "text", "multiple_choice"]).optional(),
        notes: z.string().nullable().optional(),
        assignedToUserId: z.string().nullable().optional(),
        valueBool: z.boolean().nullable().optional(),
        valueRating: z.number().int().min(1).max(5).nullable().optional(),
        valueText: z.string().nullable().optional(),
        photosRequired: z.boolean().optional(),
        selectedOptionId: z.number().int().positive().nullable().optional(),
      }).strict();
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid patch", errors: parsed.error.errors });
      const filtered = parsed.data as Record<string, unknown>;
      // Stage 2 — selectedOptionId ownership + fieldType-MC guard. NEVER
      // auto-coerce fieldType: caller must explicitly PATCH both keys
      // together if they want to switch type AND pick an option.
      if ("selectedOptionId" in filtered && filtered.selectedOptionId !== null) {
        const [currentItem] = await db.select({ fieldType: checklistItems.fieldType })
          .from(checklistItems).where(eq(checklistItems.id, id)).limit(1);
        const nextFt = filtered.fieldType ?? currentItem?.fieldType;
        if (nextFt !== "multiple_choice") {
          return res.status(400).json({ message: "Cannot select an option on a non-multiple-choice item" });
        }
        const opt = await storage.getChecklistItemOption(filtered.selectedOptionId as number);
        if (!opt || opt.itemId !== id) {
          return res.status(400).json({ message: "Option does not belong to this item" });
        }
      }
      const updated = await storage.updateChecklistItem(id, filtered);
      if (!updated) return res.status(404).json({ message: "Item not found" });

      // Idempotent completion stamping. After the PATCH commits, count items
      // in this checklist that still have no answer (value_bool/value_rating/
      // value_text/selected_option_id all NULL). If zero AND
      // checklists.completed_at is still NULL, atomically transition
      // NULL→now(). The conditional UPDATE guard means concurrent PATCHes
      // only stamp once.
      try {
        const checklistId = item[0].checklistId;
        const remaining = await db.execute(sql`
          SELECT COUNT(*)::int AS n
            FROM checklist_items
           WHERE checklist_id = ${checklistId}
             AND value_bool IS NULL
             AND value_rating IS NULL
             AND value_text IS NULL
             AND selected_option_id IS NULL
        `);
        const remainingCount = Number((remaining.rows[0] as any)?.n ?? 0);
        if (remainingCount === 0) {
          const flip = await db.execute(sql`
            UPDATE checklists
               SET completed_at = NOW()
             WHERE id = ${checklistId}
               AND completed_at IS NULL
            RETURNING id
          `);
        }
      } catch (stampErr) {
        console.error("[checklist-completed-detect] failed:", stampErr);
      }

      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update checklist item" });
    }
  });

  // ── Checklist sections (Stage 1 — instances only; templates land in Stage 3) ──
  app.get("/api/checklists/:id/sections", requireReadAccess, async (req: any, res) => {
    try {
      const checklistId = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      res.json(await storage.getChecklistSections(checklistId));
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch sections" });
    }
  });

  app.post("/api/checklists/:id/sections", requireWriteAccess, async (req: any, res) => {
    try {
      const checklistId = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const parsed = insertChecklistSectionSchema.safeParse({
        checklistId,
        title: req.body.title,
        sortOrder: req.body.sortOrder ?? 0,
      });
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
      const section = await storage.createChecklistSection(parsed.data as any);
      res.status(201).json(section);
    } catch (error) {
      res.status(500).json({ message: "Failed to create section" });
    }
  });

  app.patch("/api/checklist-sections/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyChecklistSectionAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const allowed = ["title", "sortOrder"];
      const filtered: Record<string, any> = {};
      for (const key of allowed) {
        if (key in req.body) filtered[key] = req.body[key];
      }
      const updated = await storage.updateChecklistSection(id, filtered);
      if (!updated) return res.status(404).json({ message: "Section not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update section" });
    }
  });

  app.delete("/api/checklist-sections/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyChecklistSectionAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      // FK ON DELETE SET NULL drops items into the "Untitled" virtual group.
      await storage.deleteChecklistSection(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete section" });
    }
  });

  app.post("/api/checklists/:id/sections/reorder", requireWriteAccess, async (req: any, res) => {
    try {
      const checklistId = parseInt(req.params.id as string);
      if (!(await verifyChecklistAccess(checklistId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const orderedIds = req.body.orderedIds;
      if (!Array.isArray(orderedIds) || !orderedIds.every((n) => Number.isInteger(n))) {
        return res.status(400).json({ message: "orderedIds must be an array of integers" });
      }
      await storage.reorderChecklistSections(checklistId, orderedIds);
      res.json({ message: "Reordered" });
    } catch (error: any) {
      res.status(error?.message?.includes("does not belong") ? 400 : 500)
        .json({ message: error?.message || "Failed to reorder sections" });
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

  // ── Stage 2: Per-item options (multiple_choice answer source) ──────────
  app.get("/api/checklist-items/:id/options", requireReadAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ message: "Invalid item id" });
      const access = await verifyChecklistItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const options = await storage.getChecklistItemOptions(itemId);
      res.json(options);
    } catch {
      res.status(500).json({ message: "Failed to fetch options" });
    }
  });

  app.post("/api/checklist-items/:id/options", requireWriteAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ message: "Invalid item id" });
      const access = await verifyChecklistItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      // Force the URL itemId — never trust body's itemId.
      const parsed = insertChecklistItemOptionSchema.safeParse({ ...req.body, itemId });
      if (!parsed.success) return res.status(400).json({ message: "Invalid option", errors: parsed.error.errors });
      const created = await storage.createChecklistItemOption(parsed.data as any);
      res.status(201).json(created);
    } catch {
      res.status(500).json({ message: "Failed to create option" });
    }
  });

  app.patch("/api/checklist-options/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      const access = await verifyChecklistOptionAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const optionPatchSchema = z.object({
        label: z.string().min(1).max(500).optional(),
        sortOrder: z.number().int().nonnegative().optional(),
      }).strict();
      const parsed = optionPatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid patch", errors: parsed.error.errors });
      const updated = await storage.updateChecklistItemOption(id, parsed.data);
      if (!updated) return res.status(404).json({ message: "Not found" });
      res.json(updated);
    } catch {
      res.status(500).json({ message: "Failed to update option" });
    }
  });

  app.delete("/api/checklist-options/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      const access = await verifyChecklistOptionAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      // Storage handles FK SET NULL on parent + recompute completion.
      await storage.deleteChecklistItemOption(id);
      res.json({ message: "Deleted" });
    } catch {
      res.status(500).json({ message: "Failed to delete option" });
    }
  });

  app.post("/api/checklist-items/:id/options/reorder", requireWriteAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ message: "Invalid item id" });
      const access = await verifyChecklistItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || !orderedIds.every((n) => Number.isInteger(n) && n > 0)) {
        return res.status(400).json({ message: "orderedIds must be array of positive integers" });
      }
      await storage.reorderChecklistItemOptions(itemId, orderedIds);
      res.json({ message: "Reordered" });
    } catch (e: any) {
      const msg = e?.message?.includes("does not match") ? e.message : "Failed to reorder options";
      res.status(e?.message?.includes("does not match") ? 400 : 500).json({ message: msg });
    }
  });

  // ── Stage 2: Per-item photo joins ──────────────────────────────────────
  app.get("/api/checklist-items/:id/photos", requireReadAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ message: "Invalid item id" });
      const access = await verifyChecklistItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const photos = await storage.getChecklistItemPhotos(itemId);
      res.json(photos);
    } catch {
      res.status(500).json({ message: "Failed to fetch photos" });
    }
  });

  app.post("/api/checklist-items/:id/photos", requireWriteAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ message: "Invalid item id" });
      const access = await verifyChecklistItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const mediaIds = req.body?.mediaIds;
      if (!Array.isArray(mediaIds) || mediaIds.length === 0 || !mediaIds.every((n) => Number.isInteger(n) && n > 0)) {
        return res.status(400).json({ message: "mediaIds must be a non-empty array of positive integers" });
      }
      // Cross-account guard: every media row must belong to the same account.
      const owned = await db.select({ id: media.id })
        .from(media)
        .innerJoin(projects, eq(media.projectId, projects.id))
        .where(and(inArray(media.id, mediaIds), eq(projects.accountId, req.user.accountId)));
      if (owned.length !== mediaIds.length) {
        return res.status(403).json({ message: "One or more media rows are not in your account" });
      }
      const created = await storage.attachChecklistItemPhotos(itemId, mediaIds);
      res.status(201).json(created);
    } catch {
      res.status(500).json({ message: "Failed to attach photos" });
    }
  });

  app.delete("/api/checklist-item-photos/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid id" });
      const access = await verifyChecklistItemPhotoAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      await storage.detachChecklistItemPhoto(id);
      res.json({ message: "Detached" });
    } catch {
      res.status(500).json({ message: "Failed to detach photo" });
    }
  });

  app.post("/api/checklist-items/:id/photos/reorder", requireWriteAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ message: "Invalid item id" });
      const access = await verifyChecklistItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || !orderedIds.every((n) => Number.isInteger(n) && n > 0)) {
        return res.status(400).json({ message: "orderedIds must be array of positive integers" });
      }
      await storage.reorderChecklistItemPhotos(itemId, orderedIds);
      res.json({ message: "Reordered" });
    } catch (e: any) {
      const msg = e?.message?.includes("does not match") ? e.message : "Failed to reorder photos";
      res.status(e?.message?.includes("does not match") ? 400 : 500).json({ message: msg });
    }
  });

  // ── Reports (structured shape, session 37 rewrite) ──────────────────────
  app.get("/api/reports", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      let all = await storage.getAllReports(accountId);
      // Restricted users only see reports for projects they created or are assigned to.
      if (req.user.role === "restricted") {
        const assigned = await getRestrictedAssignedProjectIds(req.user.id);
        all = all.filter((r: any) => assigned.has(r.projectId) || r.createdById === req.user.id);
      }
      res.json(all);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch reports" });
    }
  });

  app.get("/api/projects/:id/reports", requireReadAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
      if (!(await userCanAccessProject(req, projectId))) return res.status(403).json({ message: "Access denied" });
      res.json(await storage.getReportsByProject(projectId));
    } catch (error) {
      console.error("[API] GET /api/projects/:id/reports failed:", error);
      res.status(500).json({ message: "Failed to fetch project reports" });
    }
  });

  app.get("/api/reports/:id", requireReadAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const tree = await storage.getReportTree(id);
      if (!tree) return res.status(404).json({ message: "Report not found" });
      if (tree.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      if (!(await userCanAccessProject(req, tree.projectId))) return res.status(403).json({ message: "Access denied" });
      // Presign each section photo's media URL for browser viewing.
      const presigned = {
        ...tree,
        sections: await Promise.all(tree.sections.map(async (s) => ({
          ...s,
          photos: await Promise.all(s.photos.map(async (p) => {
            let url = p.media.url;
            if (isS3Url(url)) {
              const key = extractS3KeyFromUrl(url);
              if (key) url = await getPresignedUrl(key);
            }
            return { ...p, media: { ...p.media, url } };
          })),
        }))),
      };
      res.json(presigned);
    } catch (error) {
      console.error("[reports] get tree error:", error);
      res.status(500).json({ message: "Failed to fetch report" });
    }
  });

  const createReportBodySchema = z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional().nullable(),
    templateId: z.number().int().optional(), // forward-compat; ignored Stage 1
  });

  app.post("/api/projects/:id/reports", requireWriteAccess, async (req: any, res) => {
    try {
      const projectId = parseInt(req.params.id as string);
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
      if (!(await userCanAccessProject(req, projectId))) return res.status(403).json({ message: "Access denied" });
      const parsed = createReportBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });

      // Resolve template (if any) BEFORE the transaction so we fail fast on bad input.
      let tplCfg: z.infer<typeof templateConfigSchema> | undefined;
      if (parsed.data.templateId !== undefined) {
        const template = await storage.getReportTemplate(parsed.data.templateId);
        if (!template || template.accountId !== req.user.accountId) {
          return res.status(400).json({ message: "Invalid template" });
        }
        const parsedCfg = templateConfigSchema.safeParse(template.templateConfig);
        if (!parsedCfg.success) {
          return res.status(400).json({ message: "Template config is invalid (was authored under an incompatible schema version)" });
        }
        tplCfg = parsedCfg.data;
      }

      const defaultCover = {
        showCoverPhoto: true,
        showCompanyLogo: true,
        showCompanyName: true,
        showCreatorName: true,
        showPhotoCount: true,
        showDateCreated: true,
        coverPhotoMediaId: null as number | null,
      };

      const report = await db.transaction(async (tx) => {
        const created = await storage.createReport({
          projectId,
          accountId: req.user.accountId,
          title: parsed.data.title,
          description: parsed.data.description ?? tplCfg?.cover.description ?? null,
          coverConfig: tplCfg
            ? { ...tplCfg.cover.coverConfig, coverPhotoMediaId: null }
            : defaultCover,
          status: "draft",
          createdById: req.user.id,
        }, tx);
        if (tplCfg) {
          for (const s of tplCfg.sections) {
            await storage.createReportSection({
              reportId: created.id,
              title: s.title,
              summary: s.summary,
              sortOrder: s.sortOrder,
            }, tx);
          }
        }
        return created;
      });

      res.status(201).json(report);
    } catch (error) {
      console.error("[reports] create error:", error);
      res.status(500).json({ message: "Failed to create report" });
    }
  });

  const patchReportBodySchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    coverConfig: z.record(z.any()).optional(),
    status: z.enum(["draft", "submitted", "approved"]).optional(),
  });

  app.patch("/api/reports/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyReportFullAccess(req, id)).ok) return res.status(403).json({ message: "Access denied" });
      const parsed = patchReportBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
      const updated = await storage.updateReport(id, parsed.data as any);
      if (!updated) return res.status(404).json({ message: "Report not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update report" });
    }
  });

  app.delete("/api/reports/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyReportFullAccess(req, id)).ok) return res.status(403).json({ message: "Access denied" });
      await storage.deleteReport(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete report" });
    }
  });

  // Sections
  const createSectionBodySchema = z.object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().max(5000).nullable().optional(),
  });

  app.post("/api/reports/:id/sections", requireWriteAccess, async (req: any, res) => {
    try {
      const reportId = parseInt(req.params.id as string);
      if (!(await verifyReportFullAccess(req, reportId)).ok) return res.status(403).json({ message: "Access denied" });
      const parsed = createSectionBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
      const section = await storage.createReportSection({
        reportId,
        title: parsed.data.title,
        summary: parsed.data.summary ?? null,
      });
      res.status(201).json(section);
    } catch (error) {
      console.error("[reports] create section error:", error);
      res.status(500).json({ message: "Failed to create section" });
    }
  });

  const patchSectionBodySchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().max(5000).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
  });

  app.patch("/api/sections/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyReportSectionFullAccess(req, id);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const parsed = patchSectionBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
      const updated = await storage.updateReportSection(id, parsed.data);
      if (!updated) return res.status(404).json({ message: "Section not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update section" });
    }
  });

  app.delete("/api/sections/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyReportSectionFullAccess(req, id);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      await storage.deleteReportSection(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete section" });
    }
  });

  // Section photos
  const addSectionPhotosBodySchema = z.object({
    mediaIds: z.array(z.number().int().positive()).min(1).max(50),
  });

  app.post("/api/sections/:id/photos", requireWriteAccess, async (req: any, res) => {
    try {
      const sectionId = parseInt(req.params.id as string);
      const access = await verifyReportSectionFullAccess(req, sectionId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const parsed = addSectionPhotosBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
      const rows = await db.select({ id: media.id, projectId: media.projectId })
        .from(media).where(inArray(media.id, parsed.data.mediaIds));
      if (rows.length !== parsed.data.mediaIds.length) {
        return res.status(400).json({ message: "One or more photos not found" });
      }
      if (rows.some((r) => r.projectId !== access.projectId)) {
        return res.status(400).json({ message: "All photos must belong to this report's project" });
      }
      const created = await storage.addReportSectionPhotos(sectionId, parsed.data.mediaIds);
      res.status(201).json(created);
    } catch (error) {
      console.error("[reports] add section photos error:", error);
      res.status(500).json({ message: "Failed to add photos" });
    }
  });

  const patchSectionPhotoBodySchema = z.object({
    caption: z.string().max(500).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
  });

  app.patch("/api/section-photos/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyReportSectionPhotoFullAccess(req, id)).ok) return res.status(403).json({ message: "Access denied" });
      const parsed = patchSectionPhotoBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
      const updated = await storage.updateReportSectionPhoto(id, parsed.data);
      if (!updated) return res.status(404).json({ message: "Photo not found" });
      res.json(updated);
    } catch (error) {
      res.status(500).json({ message: "Failed to update photo" });
    }
  });

  app.delete("/api/section-photos/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyReportSectionPhotoFullAccess(req, id)).ok) return res.status(403).json({ message: "Access denied" });
      await storage.deleteReportSectionPhoto(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete photo" });
    }
  });

  app.post("/api/reports/:id/pdf", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyReportFullAccess(req, id)).ok) return res.status(403).json({ message: "Access denied" });
      await streamReportPdfById(id, res);
    } catch (error) {
      console.error("[reports/pdf] error:", error);
      if (!res.headersSent) res.status(500).json({ message: "Failed to generate PDF" });
      else res.destroy();
    }
  });

  // Generate or regenerate a public share token for a report.
  app.post("/api/reports/:id/share", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      if (!(await verifyReportFullAccess(req, id)).ok) return res.status(403).json({ message: "Access denied" });
      const token = crypto.randomBytes(16).toString("base64url");
      const updated = await storage.setReportShareToken(id, token);
      if (!updated) return res.status(404).json({ message: "Report not found" });
      res.json({ shareToken: token });
    } catch (error) {
      console.error("[reports/share] create error:", error);
      res.status(500).json({ message: "Failed to create share link" });
    }
  });

  // Revoke an existing share token.
  app.delete("/api/reports/:id/share", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      if (!(await verifyReportFullAccess(req, id)).ok) return res.status(403).json({ message: "Access denied" });
      const updated = await storage.setReportShareToken(id, null);
      if (!updated) return res.status(404).json({ message: "Report not found" });
      res.json({ shareToken: null });
    } catch (error) {
      console.error("[reports/share] revoke error:", error);
      res.status(500).json({ message: "Failed to revoke share link" });
    }
  });

  // Public viewer — no auth, token is the access grant.
  app.get("/api/public/reports/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!token) return res.status(404).json({ message: "Report not found" });
      const row = await storage.getReportByShareToken(token);
      if (!row) return res.status(404).json({ message: "Report not found" });
      const data = await storage.getReportForPdf(row.id);
      if (!data) return res.status(404).json({ message: "Report not found" });

      const sections = await Promise.all(
        data.sections.map(async (s) => ({
          id: s.id,
          title: s.title,
          summary: s.summary,
          sortOrder: s.sortOrder,
          photos: await presignMediaUrls(
            s.photos.map((p) => ({
              id: p.id,
              url: p.media.url,
              caption: p.caption,
              description: p.description,
              sortOrder: p.sortOrder,
              displayTimestamp: formatPhotoTimestamp(
                p.media.createdAt,
                resolvePhotoTimeZone(
                  p.media.latitude,
                  p.media.longitude,
                  data.project.latitude,
                  data.project.longitude,
                ),
              ),
            })),
          ),
        })),
      );

      const coverPhotoPresigned = data.coverPhoto
        ? (await presignMediaUrls([{ url: data.coverPhoto.url }]))[0].url
        : null;

      const rawLogo = data.account.companyLogoUrl;
      const logoKey = rawLogo && isS3Url(rawLogo) ? extractS3KeyFromUrl(rawLogo) : null;
      const companyLogoUrl = logoKey ? await getPresignedUrl(logoKey) : rawLogo;

      res.json({
        report: {
          id: data.report.id,
          title: data.report.title,
          description: data.report.description,
          coverConfig: data.report.coverConfig,
          createdAt: data.report.createdAt,
          status: data.report.status,
        },
        project: { name: data.project.name, address: data.project.address },
        account: {
          name: data.account.name,
          companyLogoUrl,
          companyLegalName: data.account.companyLegalName,
          companyAddress: data.account.companyAddress,
        },
        creator: data.creator,
        coverPhotoUrl: coverPhotoPresigned,
        sections,
      });
    } catch (error) {
      console.error("[public-reports] get error:", error);
      res.status(500).json({ message: "Failed to load report" });
    }
  });

  // ===== Project share-token flow (Session 42, Phase A) =====
  // Mirrors the reports/share pattern above. NO OG-tag injection here —
  // that's Phase B. The /api/public/projects/:token/cover.jpg endpoint
  // streams bytes (not a redirect for present covers) so OG scrapers in
  // Phase B can rely on a stable URL.

  // Generate or regenerate a public share token for a project.
  // Uses userCanAccessProject (NOT verifyProjectAccess) so restricted users
  // can only mint links for projects they're assigned to or created.
  app.post("/api/projects/:id/share", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      if (!(await userCanAccessProject(req, id))) {
        return res.status(403).json({ message: "Access denied" });
      }
      const token = crypto.randomBytes(16).toString("base64url");
      const ok = await storage.setProjectShareToken(id, req.user.accountId, token);
      if (!ok) return res.status(404).json({ message: "Project not found" });
      res.json({ shareToken: token });
    } catch (error) {
      console.error("[projects/share] create error:", error);
      res.status(500).json({ message: "Failed to create share link" });
    }
  });

  // Revoke an existing project share token. Same restricted-user check.
  app.delete("/api/projects/:id/share", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      if (!(await userCanAccessProject(req, id))) {
        return res.status(403).json({ message: "Access denied" });
      }
      const ok = await storage.setProjectShareToken(id, req.user.accountId, null);
      if (!ok) return res.status(404).json({ message: "Project not found" });
      res.json({ shareToken: null });
    } catch (error) {
      console.error("[projects/share] revoke error:", error);
      res.status(500).json({ message: "Failed to revoke share link" });
    }
  });

  // Public viewer — no auth, token is the access grant. Whitelist-only
  // payload — never include createdById, internal notes, restricted-user
  // assignments, or anything else not explicitly returned by
  // getProjectPublicSummary.
  app.get("/api/public/projects/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!token) return res.status(404).json({ message: "Project not found" });
      const data = await storage.getProjectPublicSummary(token);
      if (!data) return res.status(404).json({ message: "Project not found" });

      const coverPhotoUrl = data.coverPhoto
        ? (await presignMediaUrls([{ url: data.coverPhoto.url }]))[0].url
        : null;

      const photos = await presignMediaUrls(
        data.photos.map((p) => ({ id: p.id, url: p.url, takenAt: p.takenAt })),
      );

      const rawLogo = data.account.companyLogoUrl;
      const logoKey = rawLogo && isS3Url(rawLogo) ? extractS3KeyFromUrl(rawLogo) : null;
      const companyLogoUrl = logoKey ? await getPresignedUrl(logoKey) : rawLogo;

      res.set("Cache-Control", "public, max-age=300, s-maxage=300");
      res.json({
        project: data.project,
        account: { name: data.account.name, companyLogoUrl },
        coverPhoto: coverPhotoUrl ? { url: coverPhotoUrl } : null,
        photos,
      });
    } catch (error) {
      console.error("[public-projects] get error:", error);
      res.status(500).json({ message: "Failed to load project" });
    }
  });

  // Cover-image endpoint — streams S3 bytes for OG scrapers (stable URL).
  // Falls back to /favicon.png redirect if no cover. Auth-free, token-gated.
  app.get("/api/public/projects/:token/cover.jpg", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!token) return res.redirect(302, "/favicon.png");
      const project = await storage.getProjectByShareToken(token);
      if (!project || !project.coverPhotoId) return res.redirect(302, "/favicon.png");

      // Defense-in-depth: ensure the cover media row actually belongs to
      // this project before streaming bytes through a public endpoint.
      const cover = await storage.getMedia(project.coverPhotoId);
      if (!cover || cover.projectId !== project.id || !isS3Url(cover.url)) {
        return res.redirect(302, "/favicon.png");
      }

      const key = extractS3KeyFromUrl(cover.url);
      if (!key) return res.redirect(302, "/favicon.png");

      const stream = await getObjectStream(key);
      res.set("Content-Type", cover.mimeType || "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400");
      stream.pipe(res);
      stream.on("error", (err) => {
        console.error("[public-projects/cover] stream error:", err);
        if (!res.headersSent) res.redirect(302, "/favicon.png");
        else res.destroy();
      });
    } catch (error) {
      console.error("[public-projects/cover] error:", error);
      if (!res.headersSent) res.redirect(302, "/favicon.png");
    }
  });

  // Create a public Before/After comparison share link. Requires write
  // access; the token is the only access grant for the resulting public page.
  app.post("/api/comparisons", requireWriteAccess, async (req: any, res) => {
    try {
      const schema = z.object({
        projectId: z.number().int(),
        beforeMediaId: z.number().int(),
        afterMediaId: z.number().int(),
        beforeLabel: z.string().max(200),
        afterLabel: z.string().max(200),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid request" });
      }
      const { projectId, beforeMediaId, afterMediaId, beforeLabel, afterLabel } = parsed.data;

      if (!(await userCanAccessProject(req, projectId))) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Both media rows must belong to the project being shared.
      const before = await storage.getMedia(beforeMediaId);
      const after = await storage.getMedia(afterMediaId);
      if (
        !before || before.projectId !== projectId ||
        !after || after.projectId !== projectId
      ) {
        return res.status(400).json({ message: "Photos do not belong to this project" });
      }

      const token = crypto.randomBytes(16).toString("base64url");
      await storage.createComparisonShare({
        token,
        projectId,
        beforeMediaId,
        afterMediaId,
        beforeLabel,
        afterLabel,
        createdById: req.user.id,
      });

      const baseUrl = `${req.protocol}://${req.get("host")}`;
      res.json({ token, url: `${baseUrl}/compare/${token}` });
    } catch (error) {
      console.error("[comparisons] create error:", error);
      res.status(500).json({ message: "Failed to create comparison link" });
    }
  });

  // Public comparison view — no auth, token is the access grant. Returns a
  // strictly whitelisted payload (presigned image URLs, labels, project name,
  // account branding) and never leaks creator/internal fields.
  app.get("/api/public/comparisons/:token", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!token) return res.status(404).json({ message: "Comparison not found" });

      const view = await storage.getComparisonPublicView(token);
      if (!view) return res.status(404).json({ message: "Comparison not found" });

      const [before, after] = await presignMediaUrls([
        { url: view.beforeUrl },
        { url: view.afterUrl },
      ]);

      const rawLogo = view.account.companyLogoUrl;
      const logoKey = rawLogo && isS3Url(rawLogo) ? extractS3KeyFromUrl(rawLogo) : null;
      const companyLogoUrl = logoKey ? await getPresignedUrl(logoKey) : rawLogo;

      res.set("Cache-Control", "public, max-age=300, s-maxage=300");
      res.json({
        beforeUrl: before.url,
        afterUrl: after.url,
        beforeLabel: view.beforeLabel ?? "Before",
        afterLabel: view.afterLabel ?? "After",
        projectName: view.projectName,
        account: { name: view.account.name, companyLogoUrl },
      });
    } catch (error) {
      console.error("[public-comparisons] get error:", error);
      res.status(500).json({ message: "Failed to load comparison" });
    }
  });

  // Cover-image endpoint for the comparison — streams the AFTER image bytes
  // for OG scrapers (stable URL). Falls back to /favicon.png on any miss.
  app.get("/api/public/comparisons/:token/cover.jpg", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!token) return res.redirect(302, "/favicon.png");
      const share = await storage.getComparisonShareByToken(token);
      if (!share) return res.redirect(302, "/favicon.png");

      // Defense-in-depth: the after-media row must still belong to the share's
      // project before streaming bytes through a public endpoint.
      const after = await storage.getMedia(share.afterMediaId);
      if (!after || after.projectId !== share.projectId || !isS3Url(after.url)) {
        return res.redirect(302, "/favicon.png");
      }

      const key = extractS3KeyFromUrl(after.url);
      if (!key) return res.redirect(302, "/favicon.png");

      const stream = await getObjectStream(key);
      res.set("Content-Type", after.mimeType || "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400");
      stream.pipe(res);
      stream.on("error", (err) => {
        console.error("[public-comparisons/cover] stream error:", err);
        if (!res.headersSent) res.redirect(302, "/favicon.png");
        else res.destroy();
      });
    } catch (error) {
      console.error("[public-comparisons/cover] error:", error);
      if (!res.headersSent) res.redirect(302, "/favicon.png");
    }
  });

  // Public PDF — no auth, token is the access grant.
  app.get("/api/public/reports/:token/pdf", async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!token) return res.status(404).json({ message: "Report not found" });
      const row = await storage.getReportByShareToken(token);
      if (!row) return res.status(404).json({ message: "Report not found" });
      await streamReportPdfById(row.id, res);
    } catch (error) {
      console.error("[public-reports] pdf error:", error);
      if (!res.headersSent) res.status(500).json({ message: "Failed to generate PDF" });
      else res.destroy();
    }
  });

  app.get("/api/account/branding", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const branding = await storage.getAccountBranding(accountId);
      if (!branding) return res.status(404).json({ message: "Account not found" });
      const rawLogo = branding.companyLogoUrl;
      const s3Key = rawLogo && isS3Url(rawLogo) ? extractS3KeyFromUrl(rawLogo) : null;
      const companyLogoUrl = s3Key ? await getPresignedUrl(s3Key) : rawLogo;
      res.json({ ...branding, companyLogoUrl });
    } catch (error) {
      console.error("[branding GET] error:", error);
      res.status(500).json({ message: "Failed to load branding" });
    }
  });

  app.patch("/api/account/branding", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const schema = z.object({
        companyLogoUrl: z.string().url().nullable().optional(),
        companyLegalName: z.string().max(200).nullable().optional(),
        companyAddress: z.string().max(500).nullable().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      const updated = await storage.updateAccountBranding(accountId, parsed.data);
      const rawLogo = updated.companyLogoUrl;
      const s3Key = rawLogo && isS3Url(rawLogo) ? extractS3KeyFromUrl(rawLogo) : null;
      const companyLogoUrl = s3Key ? await getPresignedUrl(s3Key) : rawLogo;
      res.json({ ...updated, companyLogoUrl });
    } catch (error) {
      console.error("[branding PATCH] error:", error);
      res.status(500).json({ message: "Failed to update branding" });
    }
  });

  // S46: account-wide capture preferences (default photo aspect ratio).
  // GET is requireReadAccess (any user — mobile camera fetches this on every
  // session for every role). PATCH is admin-only via requireAdmin.
  // Body validation uses .strict() to reject typo'd keys instead of silently
  // ignoring them.
  app.get("/api/account/settings", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const settings = await storage.getAccountSettings(accountId);
      res.json(settings);
    } catch (error) {
      console.error("[account/settings GET] error:", error);
      res.status(500).json({ message: "Failed to load account settings" });
    }
  });

  app.patch("/api/account/settings", requireWriteAccess, requireAdmin, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const parsed = accountSettingsPatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      const updated = await storage.updateAccountSettings(accountId, parsed.data);
      res.json(updated);
    } catch (error) {
      console.error("[account/settings PATCH] error:", error);
      res.status(500).json({ message: "Failed to update account settings" });
    }
  });

  app.get("/api/users", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const usersList = await storage.getUsers(accountId);

      // Optional filter: ?assignableForProjectId=<id>. When the param resolves
      // to a project in the caller's account, restricted users not assigned to
      // that project are dropped; admin/manager/standard always pass through.
      // Missing/invalid param OR project-not-in-account => silent fallback to
      // the unfiltered list (bit-identical to pre-filter behavior). Never 400
      // here — the caller is a UI picker; falling back to the full list is
      // safer than erroring.
      let filtered = usersList;
      const rawProjectId = req.query.assignableForProjectId;
      // Strict numeric validation — parseInt would accept "39abc" as 39.
      // Anything malformed silently falls back to the unfiltered list.
      const rawStr = typeof rawProjectId === "string" ? rawProjectId.trim() : "";
      const projectId = /^[1-9]\d*$/.test(rawStr) ? Number(rawStr) : NaN;
      if (Number.isInteger(projectId) && projectId > 0) {
        const project = await storage.getProject(projectId);
        if (project && project.accountId === accountId) {
          const assignedRows = await db
            .select({ userId: projectAssignments.userId })
            .from(projectAssignments)
            .where(eq(projectAssignments.projectId, projectId));
          const assignedUserIds = new Set(assignedRows.map(r => r.userId));
          filtered = usersList.filter(u =>
            u.role !== "restricted" || assignedUserIds.has(u.id),
          );
        }
      }

      const safeUsers = filtered.map(({ password, ...rest }) => sanitizeUserForViewer(rest, req.user));
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
          stripeCustomerId: accounts.stripeCustomerId,
          stripeSubscriptionId: accounts.stripeSubscriptionId,
          trialEndsAt: accounts.trialEndsAt,
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
      const usage = await computeSeatUsage(db, accountId);
      const used = usage.used;
      const available = Math.max(0, total - used);
      const overCapacity = used > total;

      const ownerName = [row.ownerFirstName, row.ownerLastName]
        .filter(Boolean)
        .join(" ") || null;
      const isTrial =
        row.subscriptionStatus === "trialing" || row.subscriptionStatus === "trial";
      const hasCard = hasUsableSubscription(row);
      // Card-aware trial cap: no card -> 3, card on file -> 10, non-trial -> null.
      const trialMaxSeats = isTrial ? (hasCard ? 10 : 3) : null;
      const trialCanUnlockSeats = isTrial && !hasCard;

      return res.json({
        used,
        total,
        available,
        activeUsers: usage.activeUsers,
        pendingInvites: usage.pendingInvites,
        overCapacity,
        billingCycle: row.billingCycle ?? null,
        subscriptionStatus: row.subscriptionStatus ?? null,
        stripeCustomerId: row.stripeCustomerId ?? null,
        stripeSubscriptionId: row.stripeSubscriptionId ?? null,
        ownerName,
        ownerId: row.ownerId ?? null,
        trialMaxSeats,
        trialCanUnlockSeats,
        trialEndsAt: row.trialEndsAt ? row.trialEndsAt.toISOString() : null,
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
      // Reject only when there's no working Stripe subscription to attach the
      // new seat line-item to. Trialing / active / past_due all support
      // subscription.update — Stripe just modifies the sub and (for trialing)
      // bills the new line at trial end alongside the base subscription.
      const hasWorkingSubscription = hasUsableSubscription(acc);
      if (!hasWorkingSubscription || !acc.stripeCustomerId || !acc.stripeSubscriptionId) {
        const isTrialAcct =
          acc.subscriptionStatus === "trialing" || acc.subscriptionStatus === "trial";
        // A trialing account with no usable subscription needs a card to unlock
        // seats — route it to the card-add flow with a distinct code. Lapsed /
        // non-trial accounts keep the generic billing_not_set_up code.
        if (isTrialAcct) {
          return res.status(400).json({
            code: "trial_needs_card",
            action: "setup_billing",
            message:
              "Add a payment method to unlock up to 10 seats during your trial.",
          });
        }
        return res.status(400).json({
          code: "billing_not_set_up",
          action: "setup_billing",
          message:
            "This account doesn't have an active subscription. Visit Settings → Billing to set up your subscription before inviting team members.",
        });
      }
      const stripeSubscriptionId: string = acc.stripeSubscriptionId;

      const usage = await computeSeatUsage(db, accountId);
      if (desiredCount < usage.used) {
        return res.status(400).json({
          message: `Cannot reduce to ${desiredCount} seats — account has ${usage.activeUsers} active user(s) and ${usage.pendingInvites} pending invite(s). Cancel pending invites first.`,
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
      const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
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
        await stripe.subscriptions.update(stripeSubscriptionId, {
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

  // ── /api/v1 — external (Zapier) data endpoints, API-key authed ──
  // Mounted inside registerRoutes, i.e. AFTER setupAuth(app) has installed
  // csrfGuard, so every request passes through csrfGuard first. Bearer
  // requests are admitted by csrfGuard's Authorization-header branch, then
  // authenticated by requireApiKey at the router level (no session fallback).
  app.use("/api/v1", apiV1Router);

  // ── Export manifest — owner/admin-only, JSON only (never file bytes) ──
  // Lists every project in the account with its media, URLs normalized to
  // the permanent CloudFront form. The client builds the ZIP itself by
  // fetching each CloudFront URL directly (client/src/lib/exportZip.ts).
  app.get("/api/export/manifest", requireOwnerAdmin, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;

      const [acctRow] = await db
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1);

      const projectRows = await db
        .select({
          id: projects.id,
          name: projects.name,
          address: projects.address,
          status: projects.status,
          createdAt: projects.createdAt,
        })
        .from(projects)
        .where(eq(projects.accountId, accountId))
        .orderBy(projects.name);

      // media has no accountId — scope through the projects join.
      const mediaRows = await db
        .select({
          id: media.id,
          projectId: media.projectId,
          url: media.url,
          originalName: media.originalName,
          mimeType: media.mimeType,
          createdAt: media.createdAt,
        })
        .from(media)
        .innerJoin(projects, eq(media.projectId, projects.id))
        .where(eq(projects.accountId, accountId))
        .orderBy(media.id);

      // Same normalization as apiV1's permanentUrl().
      const toPermanentUrl = (url: string): string => {
        if (isS3Url(url)) {
          const key = extractS3KeyFromUrl(url);
          if (key) return getS3Url(key);
        }
        return url;
      };

      const filesByProject = new Map<number, Array<{
        id: number;
        url: string;
        originalName: string;
        mimeType: string;
        createdAt: Date;
      }>>();
      for (const m of mediaRows) {
        let list = filesByProject.get(m.projectId);
        if (!list) {
          list = [];
          filesByProject.set(m.projectId, list);
        }
        list.push({
          id: m.id,
          url: toPermanentUrl(m.url),
          originalName: m.originalName,
          mimeType: m.mimeType,
          createdAt: m.createdAt,
        });
      }

      res.json({
        exportedAt: new Date().toISOString(),
        accountName: acctRow?.name ?? "FieldView Account",
        projects: projectRows.map((p) => ({
          id: p.id,
          name: p.name,
          address: p.address,
          status: p.status,
          createdAt: p.createdAt,
          files: filesByProject.get(p.id) ?? [],
        })),
      });
    } catch (error) {
      console.error("[API] GET /api/export/manifest failed:", error);
      res.status(500).json({ message: "Failed to build export manifest" });
    }
  });

  // ── API keys — session-authed owner management for the settings UI ──
  // These endpoints are guarded by requireOwnerAdmin (session cookie), NOT by
  // the api-key auth middleware. The /api/v1 data endpoints that CONSUME keys
  // are a separate session.
  app.get("/api/account/api-keys", requireOwnerAdmin, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      const keys = await db
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          lastFourChars: apiKeys.lastFourChars,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.accountId, accountId))
        .orderBy(desc(apiKeys.createdAt));
      res.json(keys);
    } catch (error) {
      console.error("[API] GET /api/account/api-keys failed:", error);
      res.status(500).json({ message: "Failed to list API keys" });
    }
  });

  app.post("/api/account/api-keys", requireOwnerAdmin, async (req: any, res) => {
    try {
      const parsed = z
        .object({ name: z.string().trim().min(1).max(100) })
        .safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.message });
      }
      const accountId = req.user.accountId;
      const { plaintext, hash, prefix, lastFour } = generateApiKey();
      const [created] = await db
        .insert(apiKeys)
        .values({
          accountId,
          name: parsed.data.name,
          keyHash: hash,
          keyPrefix: prefix,
          lastFourChars: lastFour,
          createdById: req.user.id,
        })
        .returning({
          id: apiKeys.id,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          lastFourChars: apiKeys.lastFourChars,
          lastUsedAt: apiKeys.lastUsedAt,
          revokedAt: apiKeys.revokedAt,
          createdAt: apiKeys.createdAt,
        });
      // plaintext is returned exactly once here and never persisted.
      res.status(201).json({ ...created, plaintext });
    } catch (error) {
      console.error("[API] POST /api/account/api-keys failed:", error);
      res.status(500).json({ message: "Failed to create API key" });
    }
  });

  app.delete("/api/account/api-keys/:id", requireOwnerAdmin, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      const id = req.params.id as string;
      const [existing] = await db
        .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.accountId, accountId)));
      if (!existing) {
        return res.status(404).json({ message: "API key not found" });
      }
      if (existing.revokedAt) {
        return res.status(200).json({ message: "API key already revoked" });
      }
      await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
      res.status(200).json({ message: "API key revoked" });
    } catch (error) {
      console.error("[API] DELETE /api/account/api-keys/:id failed:", error);
      res.status(500).json({ message: "Failed to revoke API key" });
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
      const { email, role, firstName, lastName, assignedProjectIds: rawAssignedProjectIds } = req.body || {};
      if (!email) return res.status(400).json({ message: "Email is required" });
      const trimmedFirst = typeof firstName === "string" ? firstName.trim() : "";
      const trimmedLast = typeof lastName === "string" ? lastName.trim() : "";
      if (!trimmedFirst || !trimmedLast) {
        return res.status(400).json({ message: "First and last name are required." });
      }
      const validRoles = ["admin", "manager", "standard", "restricted"];
      const effectiveRole = role || "standard";
      if (!validRoles.includes(effectiveRole)) {
        return res.status(400).json({ message: "Invalid role" });
      }
      if (currentUser.role === "manager" && (effectiveRole === "admin" || effectiveRole === "manager")) {
        return res.status(403).json({ message: "Managers can only invite standard or restricted users" });
      }

      // S41: validate optional assignedProjectIds[]. Only meaningful for restricted role.
      // Empty/missing = no auto-assignment at acceptance (post-acceptance flow still works).
      const parsedAssignedIds = assignedProjectIdsSchema.safeParse(rawAssignedProjectIds ?? []);
      if (!parsedAssignedIds.success) {
        return res.status(400).json({
          error: "assigned_projects_invalid",
          message: "assignedProjectIds must be an array of positive integers",
        });
      }
      const assignedProjectIds = parsedAssignedIds.data;
      if (effectiveRole !== "restricted" && assignedProjectIds.length > 0) {
        return res.status(400).json({
          error: "assigned_projects_invalid_role",
          message: "Project assignments only apply to restricted role",
        });
      }
      if (assignedProjectIds.length > 0) {
        const found = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(
            inArray(projects.id, assignedProjectIds),
            eq(projects.accountId, currentUser.accountId),
          ));
        if (found.length !== assignedProjectIds.length) {
          return res.status(400).json({
            error: "project_not_found",
            message: "One or more project IDs not found or not accessible",
          });
        }
      }

      const existingUser = await authStorage.getUserByEmail(email);
      if (existingUser) {
        return res.status(409).json({ message: "A user with this email already exists" });
      }

      const token = crypto.randomBytes(24).toString("base64url");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // Reserve a seat atomically: lock the account row, recompute usage under
      // the lock, then dup-check + insert. Prevents two concurrent sends from
      // both passing the capacity check when only one slot is available.
      type TxResult =
        | { kind: "ok"; invitation: typeof invitations.$inferSelect }
        | { kind: "dup_invite" }
        | { kind: "trial_needs_card"; used: number }
        | { kind: "trial_cap"; trialMaxSeats: number; used: number }
        | {
            kind: "no_seats";
            used: number;
            total: number;
            activeUsers: number;
            pendingInvites: number;
          };

      const result = await db.transaction(async (tx): Promise<TxResult> => {
        const [acct] = await tx
          .select({
            seatCount: accounts.seatCount,
            subscriptionStatus: accounts.subscriptionStatus,
            stripeCustomerId: accounts.stripeCustomerId,
            stripeSubscriptionId: accounts.stripeSubscriptionId,
          })
          .from(accounts)
          .where(eq(accounts.id, currentUser.accountId))
          .for("update")
          .limit(1);
        const total = acct?.seatCount ?? 3;
        const isTrial =
          acct?.subscriptionStatus === "trialing" ||
          acct?.subscriptionStatus === "trial";
        const hasCard = acct ? hasUsableSubscription(acct) : false;
        // Card-aware trial cap: no card -> 3, card on file -> 10.
        const trialMaxSeats = isTrial ? (hasCard ? 10 : 3) : null;

        const usage = await computeSeatUsage(tx, currentUser.accountId);

        // No-card trial at its 3-seat ceiling: prompt to add a card (must be
        // checked before the generic trial_cap so the frontend can route to
        // the card-add flow instead of an "upgrade" message).
        if (isTrial && !hasCard && usage.used >= 3) {
          return { kind: "trial_needs_card", used: usage.used };
        }
        if (trialMaxSeats != null && usage.used >= trialMaxSeats) {
          return { kind: "trial_cap", trialMaxSeats, used: usage.used };
        }
        if (usage.used >= total) {
          return {
            kind: "no_seats",
            used: usage.used,
            total,
            activeUsers: usage.activeUsers,
            pendingInvites: usage.pendingInvites,
          };
        }

        const [existingInvite] = await tx.select().from(invitations).where(
          and(
            eq(invitations.email, normalizeEmail(String(email))),
            eq(invitations.accountId, currentUser.accountId),
            eq(invitations.status, "pending"),
          ),
        );
        if (existingInvite) return { kind: "dup_invite" };

        const [created] = await tx.insert(invitations).values({
          accountId: currentUser.accountId,
          email: normalizeEmail(String(email)),
          firstName: trimmedFirst,
          lastName: trimmedLast,
          role: effectiveRole,
          token,
          invitedById: currentUser.id,
          expiresAt,
          assignedProjectIds,
        }).returning();
        return { kind: "ok", invitation: created };
      });

      if (result.kind === "dup_invite") {
        return res.status(409).json({ message: "An invitation has already been sent to this email" });
      }
      if (result.kind === "trial_needs_card") {
        return res.status(409).json({
          error: "trial_needs_card",
          message: "Add a payment method to unlock up to 10 seats during your trial.",
          seatsAvailable: 0,
          suggestion: "Add a card to invite more team members",
        });
      }
      if (result.kind === "trial_cap") {
        return res.status(409).json({
          error: "trial_cap_reached",
          message: `Trial accounts are limited to ${result.trialMaxSeats} seats. Upgrade to add more.`,
          seatsAvailable: 0,
          suggestion: "Upgrade your plan to invite more team members",
        });
      }
      if (result.kind === "no_seats") {
        return res.status(409).json({
          error: "no_seats_available",
          message: `Account is at capacity (${result.used} of ${result.total} seats used).`,
          seatsAvailable: 0,
          activeUsers: result.activeUsers,
          pendingInvites: result.pendingInvites,
          suggestion: "Purchase additional seats to invite more team members",
        });
      }
      const invitation = result.invitation;

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
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
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
      console.error("[API] GET /api/projects/:id/assignments failed:", error);
      res.status(500).json({ message: "Failed to fetch assignments" });
    }
  });

  app.post("/api/projects/:id/assignments", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const projectId = parseInt(req.params.id);
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
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
      console.error("[API] POST /api/projects/:id/assignments failed:", error);
      res.status(500).json({ message: "Failed to assign user" });
    }
  });

  app.delete("/api/projects/:id/assignments/:userId", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const currentUser = req.user;
      const projectId = parseInt(req.params.id);
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
      if (!(await verifyProjectAccess(projectId, currentUser.accountId))) return res.status(403).json({ message: "Access denied" });
      await db.delete(projectAssignments).where(
        and(eq(projectAssignments.projectId, projectId), eq(projectAssignments.userId, req.params.userId))
      );
      res.json({ message: "Assignment removed" });
    } catch (error) {
      console.error("[API] DELETE /api/projects/:id/assignments/:userId failed:", error);
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


  // POST /api/users/push-token — register/update an Expo push token for the
  // authenticated user. Token is validated against Expo's `ExponentPushToken[..]`
  // format. Single device per user (multi-device deferred). DELETE counterpart
  // below clears the token (called by mobile on logout).
  app.post("/api/users/push-token", isAuthenticated, async (req: any, res) => {
    const schema = z.object({
      token: z.string().regex(/^ExponentPushToken\[.+\]$/, "Invalid Expo push token format"),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid token" });
    }
    await db.update(users)
      .set({ expoPushToken: parsed.data.token })
      .where(eq(users.id, req.user.id));
    res.status(204).send();
  });

  app.delete("/api/users/push-token", isAuthenticated, async (req: any, res) => {
    await db.update(users)
      .set({ expoPushToken: null })
      .where(eq(users.id, req.user.id));
    res.status(204).send();
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
      if (req.body?.source === "auto_geofence" && !fresh.autoTrackingEnabled) {
        return res.status(403).json({ error: "auto_tracking_disabled" });
      }

      const body = z.object({
        projectId: z.coerce.number().int().positive(),
        notes: z.string().max(2000).optional().nullable(),
        source: z.enum(["manual", "auto_geofence"]).default("manual"),
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
          source: body.data.source,
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


  // GET /api/cron/max-shift-cleanup
  // Vercel Cron hits this every 30 minutes (see vercel.json `crons`).
  //
  // Auth: `Authorization: Bearer <CRON_SECRET>` — same pattern as the other crons.
  //
  // Safety-net for ANY exit-detection failure (iOS Exit miss, heartbeat-app-killed,
  // network outage, manual-entry forgot-to-clock-out, etc). Closes time entries that
  // have been open more than 12 hours, clamping clock_out to clock_in + 8 hours so
  // payroll reflects a reasonable shift length instead of a 12+ hour ghost.
  //
  // Covers ALL sources (manual + auto_geofence) — the whole point is "user forgot to
  // clock out", which doesn't depend on how the entry was created.
  //
  // Idempotency: checks for "max_shift_safety" tag in notes and skips already-tagged
  // entries. A user could in theory undo + re-open + get re-closed 30 min later, but
  // (a) they'd need to keep it open another 12+ hours for the cron to re-pick it up,
  // and (b) the tag check still applies to the re-opened row.
  app.get("/api/cron/max-shift-cleanup", async (req, res) => {
    try {
      const expected = process.env.CRON_SECRET;
      if (!expected) {
        console.error("[cron] CRON_SECRET not set — refusing");
        return res.status(401).json({ message: "Unauthorized" });
      }
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${expected}`) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const SHIFT_LENGTH_MS = 8 * 60 * 60 * 1000;
      const SAFETY_TAG = "max_shift_safety";

      const orphans = await db
        .select({
          id: timeEntries.id,
          userId: timeEntries.userId,
          accountId: timeEntries.accountId,
          projectId: timeEntries.projectId,
          clockIn: timeEntries.clockIn,
          notes: timeEntries.notes,
          projectName: projects.name,
          projectLat: projects.latitude,
          projectLng: projects.longitude,
        })
        .from(timeEntries)
        .leftJoin(projects, eq(timeEntries.projectId, projects.id))
        .where(and(
          isNull(timeEntries.clockOut),
          sql`${timeEntries.clockIn} < ${cutoff}`,
          or(
            isNull(timeEntries.notes),
            sql`${timeEntries.notes} NOT LIKE ${"%" + SAFETY_TAG + "%"}`,
          ),
        ))
        .limit(100);

      let fired = 0;
      let errored = 0;
      const pushPromises: Promise<void>[] = [];

      let raceSkipped = 0;
      for (const orphan of orphans) {
        try {
          const clockOutAt = new Date(orphan.clockIn.getTime() + SHIFT_LENGTH_MS);
          let didFire = false;
          await db.transaction(async (tx) => {
            // Re-check inside the tx with FOR UPDATE so a user-initiated
            // clock-out (or another cron) cannot land between our SELECT
            // (above, outside the tx) and the executeAutoClockOut UPDATE
            // — without this we would clobber a legitimate clock_out with
            // the clamped 8h value and rewrite audit fields on a row the
            // user already closed.
            const [recheck] = await tx.select({
              clockOut: timeEntries.clockOut,
              notes: timeEntries.notes,
            })
              .from(timeEntries)
              .where(eq(timeEntries.id, orphan.id))
              .for("update")
              .limit(1);
            if (!recheck || recheck.clockOut !== null) return; // already closed
            if (recheck.notes && recheck.notes.includes(SAFETY_TAG)) return; // already tagged

            await executeAutoClockOut({
              timeEntryId: orphan.id,
              userId: orphan.userId,
              clockOutAt,
            }, tx);
            // Append the safety tag so the next 30-min run skips this row.
            // Bracketed tag is distinguishable from user-typed notes. Tag string
            // is hardcoded (matches SAFETY_TAG above and the LIKE filter below)
            // — kept as a literal here instead of interpolated to avoid any
            // confusion with parameter binding.
            await tx.update(timeEntries)
              .set({
                notes: sql`COALESCE(${timeEntries.notes} || E'\n[max_shift_safety]', '[max_shift_safety]')`,
              })
              .where(eq(timeEntries.id, orphan.id));
            didFire = true;
          });
          if (!didFire) {
            raceSkipped++;
            continue; // no push for race-skipped rows
          }
          fired++;

          // Post-commit push receipt — collected and awaited via Promise.allSettled
          // at end of loop. Failure here MUST NOT affect DB counters (clock-out
          // already committed atomically above). Mirrors the pattern from the
          // exit/enter crons after tonight's push reliability fix.
          const projectName = orphan.projectName ?? "your project";
          // Project-local time (not server UTC) — push may arrive hours after
          // the effective clock-out (clockIn + 8h), so the user needs a concrete
          // local-time reference to verify their timesheet rather than guess.
          // Falls back to UTC + " UTC" suffix if project has no coords.
          const localClockOut = formatLocalTime(clockOutAt, orphan.projectLat, orphan.projectLng);
          const pushPromise = sendPushNotification({
            userId: orphan.userId,
            title: "Shift auto-closed",
            body: `Your shift at ${projectName} was auto-closed at ${localClockOut} after 12 hours. Tap to review or correct.`,
            data: {
              type: "shift_auto_closed",
              timeEntryId: orphan.id,
              projectId: orphan.projectId,
              clockOutAt: clockOutAt.toISOString(),
            },
          });
          // Synchronously attach a no-op rejection handler to prevent Node from
          // emitting unhandledRejection during the await window before
          // Promise.allSettled below. allSettled still observes the real
          // resolution/rejection state via the original promise reference.
          pushPromise.catch(() => {});
          pushPromises.push(pushPromise);
        } catch (rowErr: any) {
          console.error(`[cron max-shift] row ${orphan.id} failed:`, rowErr);
          Sentry.captureException(rowErr);
          errored++;
        }
      }

      const pushResults = await Promise.allSettled(pushPromises);
      const pushFailed = pushResults.filter(r => r.status === "rejected").length;

      return res.status(200).json({
        processed: orphans.length,
        fired,
        race_skipped: raceSkipped,
        errored,
        push_attempted: pushPromises.length,
        push_failed: pushFailed,
      });
    } catch (error: any) {
      console.error("[cron] max-shift-cleanup fatal:", error);
      Sentry.captureException(error);
      res.status(500).json({ message: "Cron run failed" });
    }
  });

  // GET /api/cron/ghl-usage-sync
  // Vercel Cron hits this daily at 10:00 UTC (see vercel.json `crons`).
  // Auth: `Authorization: Bearer <CRON_SECRET>` — same pattern as
  // max-shift-cleanup above (fail-closed if the secret is unset).
  // Syncs live usage stats into GHL contact custom fields; DB access is
  // read-only. Returns the run summary so a manual test-fire shows results.
  app.get("/api/cron/ghl-usage-sync", async (req, res) => {
    try {
      const expected = process.env.CRON_SECRET;
      if (!expected) {
        console.error("[cron] CRON_SECRET not set — refusing");
        return res.status(401).json({ message: "Unauthorized" });
      }
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${expected}`) {
        return res.status(401).json({ message: "Unauthorized" });
      }

      const summary = await syncUsageToGhl();
      if (!summary) {
        return res.status(200).json({
          skipped: true,
          reason: "GHL_API_TOKEN or GHL_LOCATION_ID not set",
        });
      }
      return res.status(200).json(summary);
    } catch (error: any) {
      console.error("[cron] ghl-usage-sync fatal:", error);
      Sentry.captureException(error);
      res.status(500).json({ message: "Cron run failed" });
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

  app.get("/api/checklist-templates/:id", requireReadAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const template = await storage.getChecklistTemplate(id);
      if (!template || template.accountId !== req.user.accountId) return res.status(403).json({ message: "Access denied" });
      res.json(template);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch template" });
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

  // ── Stage 3: template parity surface ─────────────────────────────────────
  // Open to all write users by deliberate divergence from report-templates —
  // no requireAdminOrManager. Account isolation enforced via verify helpers.

  app.patch("/api/checklist-templates/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyChecklistTemplateAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const patch: { title?: string; description?: string | null } = {};
      if (typeof req.body.title === "string") patch.title = req.body.title;
      if ("description" in req.body) patch.description = req.body.description ?? null;
      const updated = await storage.updateChecklistTemplate(id, patch);
      if (!updated) return res.status(404).json({ message: "Template not found" });
      res.json(updated);
    } catch {
      res.status(500).json({ message: "Failed to update template" });
    }
  });

  // Sections
  app.get("/api/checklist-templates/:id/sections", requireReadAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (!(await verifyChecklistTemplateAccess(id, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      res.json(await storage.getChecklistTemplateSections(id));
    } catch {
      res.status(500).json({ message: "Failed to fetch sections" });
    }
  });

  app.post("/api/checklist-templates/:id/sections", requireWriteAccess, async (req: any, res) => {
    try {
      const templateId = parseInt(req.params.id as string);
      if (!(await verifyChecklistTemplateAccess(templateId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const title = String(req.body?.title ?? "").trim();
      if (!title) return res.status(400).json({ message: "title required" });
      const sortOrder = Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : 0;
      const created = await storage.createChecklistTemplateSection({ templateId, title, sortOrder });
      res.status(201).json(created);
    } catch {
      res.status(500).json({ message: "Failed to create section" });
    }
  });

  app.patch("/api/checklist-template-sections/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateSectionAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const patch: { title?: string; sortOrder?: number } = {};
      if (typeof req.body.title === "string") patch.title = req.body.title;
      if (Number.isInteger(req.body.sortOrder)) patch.sortOrder = req.body.sortOrder;
      const updated = await storage.updateChecklistTemplateSection(id, patch);
      if (!updated) return res.status(404).json({ message: "Section not found" });
      res.json(updated);
    } catch {
      res.status(500).json({ message: "Failed to update section" });
    }
  });

  app.delete("/api/checklist-template-sections/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateSectionAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      await storage.deleteChecklistTemplateSection(id);
      res.json({ message: "Deleted" });
    } catch {
      res.status(500).json({ message: "Failed to delete section" });
    }
  });

  app.post("/api/checklist-templates/:id/sections/reorder", requireWriteAccess, async (req: any, res) => {
    try {
      const templateId = parseInt(req.params.id as string);
      if (!(await verifyChecklistTemplateAccess(templateId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || !orderedIds.every((n) => Number.isInteger(n) && n > 0)) {
        return res.status(400).json({ message: "orderedIds must be array of positive integers" });
      }
      await storage.reorderChecklistTemplateSections(templateId, orderedIds);
      res.json({ message: "Reordered" });
    } catch (e: any) {
      const msg = e?.message ?? "Failed to reorder sections";
      res.status(msg.includes("does not belong") ? 400 : 500).json({ message: msg });
    }
  });

  // Items
  app.post("/api/checklist-templates/:id/items", requireWriteAccess, async (req: any, res) => {
    try {
      const templateId = parseInt(req.params.id as string);
      if (!(await verifyChecklistTemplateAccess(templateId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const label = String(req.body?.label ?? "").trim();
      if (!label) return res.status(400).json({ message: "label required" });
      // sectionId, if provided, must belong to this template.
      let sectionId: number | null = null;
      if (req.body?.sectionId !== undefined && req.body.sectionId !== null) {
        const sid = parseInt(req.body.sectionId);
        if (!Number.isInteger(sid)) return res.status(400).json({ message: "Invalid sectionId" });
        const access = await verifyChecklistTemplateSectionAccess(sid, req.user.accountId);
        if (!access.ok || access.templateId !== templateId) {
          return res.status(400).json({ message: "Section does not belong to template" });
        }
        sectionId = sid;
      }
      const created = await storage.createChecklistTemplateItem({
        templateId,
        sectionId,
        label,
        fieldType: req.body?.fieldType ?? "yes_no",
        notes: req.body?.notes ?? null,
        photosRequired: req.body?.photosRequired === true,
        sortOrder: Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : 0,
      });
      res.status(201).json(created);
    } catch {
      res.status(500).json({ message: "Failed to create template item" });
    }
  });

  app.patch("/api/checklist-template-items/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateItemAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const patch: any = {};
      if (typeof req.body.label === "string") patch.label = req.body.label;
      if (typeof req.body.fieldType === "string") patch.fieldType = req.body.fieldType;
      if ("sectionId" in req.body) {
        const raw = req.body.sectionId;
        if (raw === null) {
          patch.sectionId = null;
        } else {
          const sid = parseInt(raw);
          if (!Number.isInteger(sid)) return res.status(400).json({ message: "Invalid sectionId" });
          const sAccess = await verifyChecklistTemplateSectionAccess(sid, req.user.accountId);
          if (!sAccess.ok || sAccess.templateId !== access.templateId) {
            return res.status(400).json({ message: "Section does not belong to template" });
          }
          patch.sectionId = sid;
        }
      }
      if ("notes" in req.body) patch.notes = req.body.notes ?? null;
      if (typeof req.body.photosRequired === "boolean") patch.photosRequired = req.body.photosRequired;
      if (Number.isInteger(req.body.sortOrder)) patch.sortOrder = req.body.sortOrder;
      const updated = await storage.updateChecklistTemplateItem(id, patch);
      if (!updated) return res.status(404).json({ message: "Item not found" });
      res.json(updated);
    } catch {
      res.status(500).json({ message: "Failed to update template item" });
    }
  });

  app.delete("/api/checklist-template-items/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateItemAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      await storage.deleteChecklistTemplateItem(id);
      res.json({ message: "Deleted" });
    } catch {
      res.status(500).json({ message: "Failed to delete template item" });
    }
  });

  app.post("/api/checklist-templates/:id/items/reorder", requireWriteAccess, async (req: any, res) => {
    try {
      const templateId = parseInt(req.params.id as string);
      if (!(await verifyChecklistTemplateAccess(templateId, req.user.accountId))) return res.status(403).json({ message: "Access denied" });
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || !orderedIds.every((n) => Number.isInteger(n) && n > 0)) {
        return res.status(400).json({ message: "orderedIds must be array of positive integers" });
      }
      await storage.reorderChecklistTemplateItems(templateId, orderedIds);
      res.json({ message: "Reordered" });
    } catch (e: any) {
      const msg = e?.message ?? "Failed to reorder items";
      res.status(msg.includes("does not belong") ? 400 : 500).json({ message: msg });
    }
  });

  // Options (multiple_choice authoring)
  app.get("/api/checklist-template-items/:id/options", requireReadAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      res.json(await storage.getChecklistTemplateItemOptions(itemId));
    } catch {
      res.status(500).json({ message: "Failed to fetch options" });
    }
  });

  app.post("/api/checklist-template-items/:id/options", requireWriteAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const label = String(req.body?.label ?? "").trim();
      if (!label) return res.status(400).json({ message: "label required" });
      const sortOrder = Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : 0;
      const created = await storage.createChecklistTemplateItemOption({ itemId, label, sortOrder });
      res.status(201).json(created);
    } catch {
      res.status(500).json({ message: "Failed to create option" });
    }
  });

  app.patch("/api/checklist-template-options/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateOptionAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const patch: { label?: string; sortOrder?: number } = {};
      if (typeof req.body.label === "string") patch.label = req.body.label;
      if (Number.isInteger(req.body.sortOrder)) patch.sortOrder = req.body.sortOrder;
      const updated = await storage.updateChecklistTemplateItemOption(id, patch);
      if (!updated) return res.status(404).json({ message: "Option not found" });
      res.json(updated);
    } catch {
      res.status(500).json({ message: "Failed to update option" });
    }
  });

  app.delete("/api/checklist-template-options/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateOptionAccess(id, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      await storage.deleteChecklistTemplateItemOption(id);
      res.json({ message: "Deleted" });
    } catch {
      res.status(500).json({ message: "Failed to delete option" });
    }
  });

  app.post("/api/checklist-template-items/:id/options/reorder", requireWriteAccess, async (req: any, res) => {
    try {
      const itemId = parseInt(req.params.id as string);
      const access = await verifyChecklistTemplateItemAccess(itemId, req.user.accountId);
      if (!access.ok) return res.status(403).json({ message: "Access denied" });
      const orderedIds = req.body?.orderedIds;
      if (!Array.isArray(orderedIds) || !orderedIds.every((n) => Number.isInteger(n) && n > 0)) {
        return res.status(400).json({ message: "orderedIds must be array of positive integers" });
      }
      await storage.reorderChecklistTemplateItemOptions(itemId, orderedIds);
      res.json({ message: "Reordered" });
    } catch (e: any) {
      const msg = e?.message ?? "Failed to reorder options";
      res.status(msg.includes("does not belong") ? 400 : 500).json({ message: msg });
    }
  });

  // ─── Report Templates (Stage 4 PR-B) ────────────────────────────────────────
  // List = readers; create/update/delete = Admin/Manager. Cross-account
  // ownership check on every per-id route. accountId + createdById injected
  // from session — never trusted from client.

  app.get("/api/report-templates", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const templates = await storage.getReportTemplates(accountId);
      res.json(templates);
    } catch (error) {
      console.error("[report-templates] list error:", error);
      res.status(500).json({ message: "Failed to list templates" });
    }
  });

  app.get("/api/report-templates/:id", requireReadAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const t = await storage.getReportTemplate(id);
      if (!t || t.accountId !== req.user.accountId)
        return res.status(403).json({ message: "Access denied" });
      res.json(t);
    } catch (error) {
      console.error("[report-templates] get error:", error);
      res.status(500).json({ message: "Failed to load template" });
    }
  });

  const createReportTemplateBodySchema = z.object({
    title: z.string().trim().min(1).max(200),
    templateConfig: templateConfigSchema,
  }).strict();

  app.post("/api/report-templates", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const parsed = createReportTemplateBodySchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      const created = await storage.createReportTemplate({
        accountId,
        createdById: req.user.id,
        title: parsed.data.title,
        templateConfig: parsed.data.templateConfig,
      });
      res.status(201).json({ ...created, sectionCount: parsed.data.templateConfig.sections.length });
    } catch (error) {
      console.error("[report-templates] create error:", error);
      res.status(500).json({ message: "Failed to create template" });
    }
  });

  const patchReportTemplateBodySchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    templateConfig: templateConfigSchema.optional(),
  }).strict();

  app.patch("/api/report-templates/:id", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const existing = await storage.getReportTemplate(id);
      if (!existing || existing.accountId !== req.user.accountId)
        return res.status(403).json({ message: "Access denied" });
      const parsed = patchReportTemplateBodySchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      const updated = await storage.updateReportTemplate(id, parsed.data);
      if (!updated) return res.status(404).json({ message: "Template not found" });
      res.json(updated);
    } catch (error) {
      console.error("[report-templates] patch error:", error);
      res.status(500).json({ message: "Failed to update template" });
    }
  });

  app.delete("/api/report-templates/:id", requireWriteAccess, requireAdminOrManager, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id as string);
      if (Number.isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const existing = await storage.getReportTemplate(id);
      if (!existing || existing.accountId !== req.user.accountId)
        return res.status(403).json({ message: "Access denied" });
      await storage.deleteReportTemplate(id);
      res.json({ message: "Deleted" });
    } catch (error) {
      console.error("[report-templates] delete error:", error);
      res.status(500).json({ message: "Failed to delete template" });
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
      if (Number.isNaN(projectId)) return res.status(404).json({ message: "Project not found" });
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
        .where(eq(reports.accountId, accountId));
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

      // Session 2 of trial-flow rework: read billing from the
      // accounts-source path so trialEndsAt reflects the app-side
      // deadline anchored at signup. getAccountBilling falls back to
      // the user row when ACCOUNT_BILLING_ENABLED is off.
      const billing = await getAccountBilling(req);

      let customerId = billing.stripeCustomerId ?? user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email || undefined,
          name: [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined,
          metadata: { userId: user.id, accountId: user.accountId || "" },
        });
        customerId = customer.id;
        // Persist on BOTH user and account so the accounts-source
        // billing path (when ACCOUNT_BILLING_ENABLED=on) picks it up
        // and we don't create a duplicate Stripe customer next time.
        await authStorage.updateUser(user.id, { stripeCustomerId: customerId });
        if (user.accountId) {
          await db
            .update(accounts)
            .set({ stripeCustomerId: customerId })
            .where(eq(accounts.id, user.accountId));
        }
      }

      const baseUrl = `${req.protocol}://${req.get("host")}`;

      // Duplicate-subscription guard: if this account already has a live
      // subscription (id stored AND status active/trialing/past_due), do NOT
      // create a new Checkout session — a second checkout would create a
      // duplicate subscription on the same customer. Send them to the Stripe
      // billing portal instead (same pattern as /api/create-portal-session).
      // The client redirects to whatever `url` comes back, so no UI change.
      // Sub id + status are evaluated as PAIRS from the same source (billing
      // row, then user row) — mixing fields across sources can misclassify
      // when the two records have drifted.
      const liveStatuses = ["active", "trialing", "past_due"];
      const billingLive =
        !!billing.stripeSubscriptionId &&
        liveStatuses.includes(billing.subscriptionStatus || "");
      const userLive =
        !!user.stripeSubscriptionId &&
        liveStatuses.includes(user.subscriptionStatus || "");
      const existingSubId = billingLive
        ? billing.stripeSubscriptionId
        : userLive
          ? user.stripeSubscriptionId
          : null;
      const existingStatus = billingLive
        ? billing.subscriptionStatus
        : userLive
          ? user.subscriptionStatus
          : null;
      if (existingSubId) {
        console.log(
          `[checkout] user ${user.id} already has live subscription ${existingSubId} (${existingStatus}) — redirecting to billing portal instead of checkout`,
        );
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: `${baseUrl}/settings`,
        });
        return res.json({ url: portalSession.url, redirected: "billing_portal" });
      }

      const hasSubscription =
        billing.subscriptionStatus === "active" ||
        !!billing.stripeSubscriptionId ||
        user.subscriptionStatus === "active" ||
        !!user.stripeSubscriptionId;
      // Rewardful: client_reference_id is how Rewardful attributes the
      // Stripe conversion to the right affiliate. Mirrored into
      // subscription_data.metadata as defense-in-depth in case the
      // checkout-session-level attribution misses (e.g., subscription
      // updates after initial checkout).
      // Validation: Stripe caps client_reference_id at 200 chars; restrict
      // to a conservative URL-safe charset to keep abusive payloads out
      // of Stripe and our subscription metadata.
      let rewardfulReferral: string | undefined;
      const rawReferral = req.body?.rewardfulReferral;
      if (rawReferral != null && rawReferral !== "") {
        if (typeof rawReferral !== "string") {
          return res.status(400).json({ message: "rewardfulReferral must be a string" });
        }
        const trimmed = rawReferral.trim();
        if (trimmed.length > 0) {
          if (trimmed.length > 200 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
            return res.status(400).json({ message: "rewardfulReferral is invalid" });
          }
          rewardfulReferral = trimmed;
        }
      }

      const sessionConfig: any = {
        customer: customerId,
        mode: "subscription",
        line_items: stripeLineItems,
        success_url: `${baseUrl}/?checkout=success`,
        cancel_url: `${baseUrl}/?checkout=canceled`,
        payment_method_collection: "always",
        // BETA100 (100% off, 50-redemption cap) and any future promo
        // codes are surfaced via this flag — DO NOT remove.
        allow_promotion_codes: true,
        ...(rewardfulReferral ? { client_reference_id: rewardfulReferral } : {}),
      };
      if (!hasSubscription) {
        // Mid-trial card add: anchor Stripe's trial_end to OUR app-side
        // trialEndsAt so the user gets ONLY their remaining trial time,
        // not a fresh 14 days on top. Stripe expects Unix SECONDS
        // (not milliseconds — ms produces a confusing parse error).
        const trialEnd = billing.trialEndsAt ? new Date(billing.trialEndsAt) : null;
        if (trialEnd && trialEnd.getTime() > Date.now()) {
          sessionConfig.subscription_data = {
            trial_end: Math.floor(trialEnd.getTime() / 1000),
          };
        }
        // Else: trial expired or no trial → no trial_end, charge
        // immediately on Checkout completion.
      }
      if (rewardfulReferral) {
        sessionConfig.subscription_data = {
          ...(sessionConfig.subscription_data || {}),
          metadata: {
            ...((sessionConfig.subscription_data || {}).metadata || {}),
            rewardful_referral: rewardfulReferral,
          },
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

      // Multi-subscription safety: if we already know the account's
      // subscription, sync THAT one by id — a `list({ limit: 1, status:
      // "all" })` can return a stale duplicate first and overwrite the
      // stored id. Only fall back to listing when nothing is stored, and
      // then prefer live subs (active/trialing, most recent by created)
      // over canceled leftovers.
      let sub: any = null;
      if (user.stripeSubscriptionId) {
        try {
          sub = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
        } catch (e: any) {
          console.error(
            `[confirm-checkout] failed to retrieve stored sub ${user.stripeSubscriptionId}: ${e?.message} — falling back to list`,
          );
        }
      }
      if (!sub) {
        const [activeSubs, trialingSubs] = await Promise.all([
          stripe.subscriptions.list({ customer: user.stripeCustomerId, status: "active", limit: 10 }),
          stripe.subscriptions.list({ customer: user.stripeCustomerId, status: "trialing", limit: 10 }),
        ]);
        const candidates = [...activeSubs.data, ...trialingSubs.data].sort(
          (a, b) => (b.created || 0) - (a.created || 0),
        );
        sub = candidates[0] || null;
      }

      if (sub) {
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

  // ============================================================
  // S43: Rewardful affiliate / referral
  // ============================================================
  // GET /api/me/referral
  // Returns the current user's Rewardful affiliate referral URL + stats.
  // Lazily creates the affiliate in the "Friends of Field View" campaign on
  // first call and caches the affiliate id + URL on the user row so future
  // calls only need a stats refresh against Rewardful.
  app.get("/api/me/referral", isAuthenticated, async (req: any, res) => {
    try {
      const user = await authStorage.getUser(req.user.id);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      if (!user.email) {
        return res.status(400).json({
          error: "Your account needs an email address before you can refer friends.",
        });
      }

      let affiliate = null as Awaited<ReturnType<typeof rewardfulGetAffiliateById>> | null;

      if (user.rewardfulAffiliateId && user.rewardfulReferralUrl) {
        // Cached path — refresh stats only. If the cached id is stale (404),
        // fall through to the find-or-create flow below.
        try {
          affiliate = await rewardfulGetAffiliateById(user.rewardfulAffiliateId);
        } catch (e) {
          if (!(e instanceof RewardfulError && e.status === 404)) throw e;
        }
      }

      if (!affiliate) {
        // Lookup is campaign-scoped: the same email may already be enrolled
        // in a different Rewardful campaign on this account; binding to that
        // record would hand the user the wrong referral link.
        affiliate = await rewardfulFindAffiliateByEmail(
          user.email,
          REWARDFUL_CAMPAIGN_ID,
        );
        if (!affiliate) {
          // Spec says split full_name on first space; our schema already has
          // discrete first/last columns, so use them directly. Fall back to
          // the email local-part when both are blank so Rewardful gets a
          // non-empty first_name (its API requires it).
          const first = (user.firstName || "").trim();
          const last = (user.lastName || "").trim();
          const fallbackFirst = user.email.split("@")[0] || "Field View";
          try {
            affiliate = await rewardfulCreateAffiliate({
              email: user.email,
              first_name: first || fallbackFirst,
              last_name: last,
            });
          } catch (createErr) {
            // Race / duplicate fallback: a concurrent request (or a previous
            // partial run that failed before persisting) may have already
            // created the affiliate. Rewardful answers duplicates with
            // 422/409 — re-query (campaign-scoped) and reuse if present
            // before bubbling the error.
            const isDup =
              createErr instanceof RewardfulError &&
              (createErr.status === 422 || createErr.status === 409);
            if (!isDup) throw createErr;
            const existing = await rewardfulFindAffiliateByEmail(
              user.email,
              REWARDFUL_CAMPAIGN_ID,
            );
            if (!existing) throw createErr;
            affiliate = existing;
          }
        }

        const referralUrl = affiliate.links?.[0]?.url ?? null;
        if (!referralUrl) {
          throw new RewardfulError(
            "Rewardful affiliate has no referral link",
            502,
            affiliate,
          );
        }
        await authStorage.updateUser(user.id, {
          rewardfulAffiliateId: affiliate.id,
          rewardfulReferralUrl: referralUrl,
        });
        user.rewardfulAffiliateId = affiliate.id;
        user.rewardfulReferralUrl = referralUrl;
      }

      const referralUrl =
        user.rewardfulReferralUrl || affiliate.links?.[0]?.url || "";
      const referralCode = extractReferralCode(referralUrl);

      // Rewardful returns commissions either as integer cents or as decimal
      // strings (varies by endpoint). Normalize to cents defensively.
      const toCents = (v: unknown): number => {
        if (typeof v === "number" && Number.isFinite(v)) {
          return Number.isInteger(v) ? v : Math.round(v * 100);
        }
        if (typeof v === "string" && v.trim() !== "") {
          const n = Number(v);
          if (Number.isFinite(n)) {
            return Number.isInteger(n) ? n : Math.round(n * 100);
          }
        }
        return 0;
      };

      res.json({
        referralUrl,
        referralCode,
        stats: {
          visitors: Number(affiliate.visitors ?? 0),
          leads: Number(affiliate.leads ?? 0),
          conversions: Number(affiliate.conversions ?? 0),
          unpaidCommissionsCents: toCents(affiliate.unpaid_commissions),
          paidCommissionsCents: toCents(affiliate.paid_commissions),
        },
      });
    } catch (error: any) {
      console.error("[referral] error:", error?.message || error);
      Sentry.captureException(error);
      res.status(503).json({
        error: "Couldn't load referral info, try again shortly",
      });
    }
  });

  return httpServer;
}
