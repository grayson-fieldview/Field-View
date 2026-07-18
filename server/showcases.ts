import type { Express } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { db } from "./db";
import { eq, and, sql, inArray, desc, gte, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import {
  showcases,
  showcasePhotos,
  showcaseSettings,
  showcaseViews,
  media,
  projects,
  insertShowcaseSchema,
} from "@shared/schema";
import { accounts } from "@shared/models/auth";
import { requireReadAccess, requireWriteAccess } from "./replit_integrations/auth";
import { getObjectStream, extractS3KeyFromUrl, isS3Url } from "./s3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "showcase"
  );
}

// Deterministic ~0.5 mile jitter derived from showcase identity so the pin
// doesn't wander on every save. Never store or return precise coords publicly.
export function obfuscateLocation(lat: number, lng: number, seed: string): { lat: number; lng: number } {
  const h = crypto.createHash("sha256").update(seed).digest();
  const a = h.readUInt32BE(0) / 0xffffffff; // 0..1
  const b = h.readUInt32BE(4) / 0xffffffff;
  const angle = a * 2 * Math.PI;
  const distMiles = 0.15 + b * 0.35; // 0.15–0.5 mi
  const dLat = (distMiles / 69) * Math.sin(angle);
  const dLng = (distMiles / (69 * Math.cos((lat * Math.PI) / 180) || 1)) * Math.cos(angle);
  return { lat: +(lat + dLat).toFixed(5), lng: +(lng + dLng).toFixed(5) };
}

async function getOrCreateSettings(accountId: string) {
  const [existing] = await db.select().from(showcaseSettings).where(eq(showcaseSettings.accountId, accountId)).limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(showcaseSettings)
    .values({ accountId })
    .onConflictDoNothing({ target: showcaseSettings.accountId })
    .returning();
  if (created) return created;
  const [row] = await db.select().from(showcaseSettings).where(eq(showcaseSettings.accountId, accountId)).limit(1);
  return row;
}

async function uniqueShowcaseSlug(accountId: string, title: string, excludeId?: number): Promise<string> {
  const base = slugify(title);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`.slice(0, 60);
    const [clash] = await db
      .select({ id: showcases.id })
      .from(showcases)
      .where(and(eq(showcases.accountId, accountId), eq(showcases.slug, candidate), ...(excludeId ? [ne(showcases.id, excludeId)] : [])))
      .limit(1);
    if (!clash) return candidate;
  }
  return `${base}-${crypto.randomBytes(3).toString("hex")}`.slice(0, 60);
}

type PhotoInput = z.infer<typeof photoInputSchema>;
const photoInputSchema = z.object({
  mediaId: z.number().int().positive(),
  sortOrder: z.number().int().min(0),
  caption: z.string().max(500).nullable().optional(),
  pairGroupId: z.string().max(36).nullable().optional(),
  pairRole: z.enum(["before", "after"]).nullable().optional(),
});

function validatePairs(photos: PhotoInput[]): string | null {
  const groups = new Map<string, PhotoInput[]>();
  for (const p of photos) {
    if (p.pairGroupId) {
      if (!p.pairRole) return "Paired photos must have a before/after role";
      const arr = groups.get(p.pairGroupId) || [];
      arr.push(p);
      groups.set(p.pairGroupId, arr);
    } else if (p.pairRole) {
      return "pairRole requires pairGroupId";
    }
  }
  for (const [, arr] of Array.from(groups.entries())) {
    if (arr.length !== 2) return "Each before/after pair must contain exactly two photos";
    const roles = arr.map((p) => p.pairRole).sort();
    if (roles[0] !== "after" || roles[1] !== "before") return "Each pair needs one before and one after photo";
  }
  return null;
}

async function verifyShowcaseAccess(id: number, accountId: string) {
  const [row] = await db.select().from(showcases).where(and(eq(showcases.id, id), eq(showcases.accountId, accountId))).limit(1);
  return row || null;
}

// Public image variant URL — resized + EXIF-stripped, never the original.
function publicImgUrl(mediaId: number): string {
  return `/api/public/showcase-img/${mediaId}`;
}

async function loadShowcasePhotoRows(showcaseIds: number[]) {
  if (showcaseIds.length === 0) return [];
  return db
    .select({
      id: showcasePhotos.id,
      showcaseId: showcasePhotos.showcaseId,
      mediaId: showcasePhotos.mediaId,
      sortOrder: showcasePhotos.sortOrder,
      caption: showcasePhotos.caption,
      pairGroupId: showcasePhotos.pairGroupId,
      pairRole: showcasePhotos.pairRole,
    })
    .from(showcasePhotos)
    .where(inArray(showcasePhotos.showcaseId, showcaseIds))
    .orderBy(showcasePhotos.sortOrder);
}

const settingsPatchSchema = z.object({
  portfolioEnabled: z.boolean().optional(),
  portfolioSlug: z
    .string()
    .regex(SLUG_RE, "Slug must be lowercase letters, numbers and dashes")
    .nullable()
    .optional(),
  displayName: z.string().max(120).nullable().optional(),
  logoUrl: z.string().max(1000).nullable().optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).nullable().optional(),
  showMap: z.boolean().optional(),
  contactCtaEnabled: z.boolean().optional(),
  contactCtaLabel: z.string().max(80).nullable().optional(),
  contactCtaUrl: z.string().max(500).nullable().optional(),
  introText: z.string().max(2000).nullable().optional(),
  showcaseTags: z.array(z.string().min(1).max(60)).max(100).optional(),
}).strict();

const showcasePatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  slug: z.string().regex(SLUG_RE).optional(),
  description: z.string().max(5000).nullable().optional(),
  projectId: z.number().int().positive().nullable().optional(),
  projectTypes: z.array(z.string().min(1).max(60)).max(20).optional(),
  productsUsed: z.array(z.string().min(1).max(120)).max(50).optional(),
  status: z.enum(["draft", "published"]).optional(),
  coverMediaId: z.number().int().positive().nullable().optional(),
  displayLat: z.number().min(-90).max(90).nullable().optional(),
  displayLng: z.number().min(-180).max(180).nullable().optional(),
  locationLabel: z.string().max(120).nullable().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerShowcaseRoutes(app: Express): void {
  // ------------------------- Internal (auth) -------------------------------

  app.get("/api/showcases", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const rows = await db
        .select()
        .from(showcases)
        .where(eq(showcases.accountId, accountId))
        .orderBy(desc(showcases.updatedAt));
      const photoRows = await loadShowcasePhotoRows(rows.map((r) => r.id));
      const counts = new Map<number, number>();
      const firstMedia = new Map<number, number>();
      for (const p of photoRows) {
        counts.set(p.showcaseId, (counts.get(p.showcaseId) || 0) + 1);
        if (!firstMedia.has(p.showcaseId)) firstMedia.set(p.showcaseId, p.mediaId);
      }
      // 30-day view counts per showcase
      const since = new Date(Date.now() - 30 * 86400000);
      const viewRows = await db
        .select({ showcaseId: showcaseViews.showcaseId, c: sql<number>`count(*)::int` })
        .from(showcaseViews)
        .where(and(eq(showcaseViews.accountId, accountId), gte(showcaseViews.viewedAt, since)))
        .groupBy(showcaseViews.showcaseId);
      const viewMap = new Map<number | null, number>();
      for (const v of viewRows) viewMap.set(v.showcaseId, Number(v.c));
      res.json(
        rows.map((r) => ({
          ...r,
          photoCount: counts.get(r.id) || 0,
          coverUrl: publicImgUrl(r.coverMediaId || firstMedia.get(r.id) || 0) ,
          coverMediaResolvedId: r.coverMediaId || firstMedia.get(r.id) || null,
          views30d: viewMap.get(r.id) || 0,
        })),
      );
    } catch (e) {
      console.error("[showcases] list failed:", e);
      res.status(500).json({ message: "Failed to fetch showcases" });
    }
  });

  app.post("/api/showcases", requireWriteAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const body = z.object({
        title: z.string().min(1).max(200),
        projectId: z.number().int().positive().nullable().optional(),
      }).parse(req.body);
      if (body.projectId) {
        const [proj] = await db.select({ id: projects.id }).from(projects)
          .where(and(eq(projects.id, body.projectId), eq(projects.accountId, accountId))).limit(1);
        if (!proj) return res.status(403).json({ message: "Project access denied" });
      }
      const slug = await uniqueShowcaseSlug(accountId, body.title);
      const [row] = await db
        .insert(showcases)
        .values({ accountId, title: body.title, slug, projectId: body.projectId ?? null, createdById: req.user.id })
        .returning();
      res.status(201).json(row);
    } catch (e: any) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.message });
      console.error("[showcases] create failed:", e);
      res.status(500).json({ message: "Failed to create showcase" });
    }
  });

  app.get("/api/showcases/analytics", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
      const since = new Date(Date.now() - days * 86400000);
      const perShowcase = await db
        .select({ showcaseId: showcaseViews.showcaseId, c: sql<number>`count(*)::int` })
        .from(showcaseViews)
        .where(and(eq(showcaseViews.accountId, accountId), gte(showcaseViews.viewedAt, since)))
        .groupBy(showcaseViews.showcaseId);
      const daily = await db
        .select({
          day: sql<string>`to_char(${showcaseViews.viewedAt}, 'YYYY-MM-DD')`,
          c: sql<number>`count(*)::int`,
        })
        .from(showcaseViews)
        .where(and(eq(showcaseViews.accountId, accountId), gte(showcaseViews.viewedAt, since)))
        .groupBy(sql`to_char(${showcaseViews.viewedAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${showcaseViews.viewedAt}, 'YYYY-MM-DD')`);
      const portfolioViews = perShowcase.find((r) => r.showcaseId === null)?.c || 0;
      const total = perShowcase.reduce((s, r) => s + Number(r.c), 0);
      res.json({
        days,
        totalViews: total,
        portfolioViews: Number(portfolioViews),
        byShowcase: perShowcase.filter((r) => r.showcaseId !== null).map((r) => ({ showcaseId: r.showcaseId, views: Number(r.c) })),
        daily: daily.map((d) => ({ day: d.day, views: Number(d.c) })),
      });
    } catch (e) {
      console.error("[showcases] analytics failed:", e);
      res.status(500).json({ message: "Failed to fetch analytics" });
    }
  });

  app.get("/api/showcases/:id", requireReadAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
      const row = await verifyShowcaseAccess(id, req.user.accountId);
      if (!row) return res.status(404).json({ message: "Showcase not found" });
      const photos = await loadShowcasePhotoRows([id]);
      const mediaIds = photos.map((p) => p.mediaId);
      const mediaRows = mediaIds.length
        ? await db.select({ id: media.id, url: media.url, mimeType: media.mimeType }).from(media).where(inArray(media.id, mediaIds))
        : [];
      const mediaMap = new Map(mediaRows.map((m) => [m.id, m]));
      res.json({
        ...row,
        photos: photos.map((p) => ({ ...p, url: publicImgUrl(p.mediaId), mimeType: mediaMap.get(p.mediaId)?.mimeType })),
      });
    } catch (e) {
      console.error("[showcases] get failed:", e);
      res.status(500).json({ message: "Failed to fetch showcase" });
    }
  });

  app.patch("/api/showcases/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await verifyShowcaseAccess(id, req.user.accountId);
      if (!existing) return res.status(404).json({ message: "Showcase not found" });
      const patch = showcasePatchSchema.parse(req.body);

      if (patch.projectId) {
        const [proj] = await db.select({ id: projects.id }).from(projects)
          .where(and(eq(projects.id, patch.projectId), eq(projects.accountId, req.user.accountId))).limit(1);
        if (!proj) return res.status(403).json({ message: "Project access denied" });
      }
      if (patch.slug && patch.slug !== existing.slug) {
        const [clash] = await db.select({ id: showcases.id }).from(showcases)
          .where(and(eq(showcases.accountId, req.user.accountId), eq(showcases.slug, patch.slug), ne(showcases.id, id))).limit(1);
        if (clash) return res.status(409).json({ message: "Slug already in use" });
      }
      if (patch.coverMediaId) {
        const [ok] = await db.select({ id: showcasePhotos.id }).from(showcasePhotos)
          .where(and(eq(showcasePhotos.showcaseId, id), eq(showcasePhotos.mediaId, patch.coverMediaId))).limit(1);
        if (!ok) return res.status(400).json({ message: "Cover photo must be one of the showcase's photos" });
      }

      const next = { ...existing, ...patch };
      let publishedAt = existing.publishedAt;
      if (patch.status === "published" && existing.status !== "published") {
        const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(showcasePhotos).where(eq(showcasePhotos.showcaseId, id));
        const problems: string[] = [];
        if (!next.title?.trim()) problems.push("a title");
        if (Number(c) < 1) problems.push("at least one photo");
        if (next.displayLat == null || next.displayLng == null) problems.push("a location");
        if (problems.length) {
          return res.status(400).json({ message: `To publish, add ${problems.join(", ")}.` });
        }
        publishedAt = new Date();
      }
      // Server-side privacy guarantee: never persist precise coords. Obfuscate
      // deterministically (seeded by showcase id) so the pin is stable across saves.
      const coordPatch: { displayLat?: number | null; displayLng?: number | null } = {};
      if (patch.displayLat !== undefined || patch.displayLng !== undefined) {
        const lat = patch.displayLat !== undefined ? patch.displayLat : existing.displayLat;
        const lng = patch.displayLng !== undefined ? patch.displayLng : existing.displayLng;
        if (lat == null || lng == null) {
          coordPatch.displayLat = lat ?? null;
          coordPatch.displayLng = lng ?? null;
        } else {
          const ob = obfuscateLocation(lat, lng, `showcase:${id}`);
          coordPatch.displayLat = ob.lat;
          coordPatch.displayLng = ob.lng;
        }
      }
      const [updated] = await db
        .update(showcases)
        .set({ ...patch, ...coordPatch, publishedAt, updatedAt: new Date() })
        .where(and(eq(showcases.id, id), eq(showcases.accountId, req.user.accountId)))
        .returning();
      res.json(updated);
    } catch (e: any) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.message });
      console.error("[showcases] patch failed:", e);
      res.status(500).json({ message: "Failed to update showcase" });
    }
  });

  app.delete("/api/showcases/:id", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await verifyShowcaseAccess(id, req.user.accountId);
      if (!existing) return res.status(404).json({ message: "Showcase not found" });
      await db.delete(showcases).where(and(eq(showcases.id, id), eq(showcases.accountId, req.user.accountId)));
      res.json({ success: true });
    } catch (e) {
      console.error("[showcases] delete failed:", e);
      res.status(500).json({ message: "Failed to delete showcase" });
    }
  });

  // Replace the full photo set (ordering, captions, pairs) in one call.
  app.put("/api/showcases/:id/photos", requireWriteAccess, async (req: any, res) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await verifyShowcaseAccess(id, req.user.accountId);
      if (!existing) return res.status(404).json({ message: "Showcase not found" });
      const body = z.object({ photos: z.array(photoInputSchema).max(200) }).parse(req.body);
      const pairError = validatePairs(body.photos);
      if (pairError) return res.status(400).json({ message: pairError });

      // Tenant check: every media id must belong to this account via project join.
      const mediaIds = Array.from(new Set(body.photos.map((p) => p.mediaId)));
      if (mediaIds.length) {
        const owned = await db
          .select({ id: media.id })
          .from(media)
          .innerJoin(projects, eq(media.projectId, projects.id))
          .where(and(inArray(media.id, mediaIds), eq(projects.accountId, req.user.accountId), sql`${media.mimeType} LIKE 'image/%'`));
        if (owned.length !== mediaIds.length) {
          return res.status(403).json({ message: "One or more photos are not accessible" });
        }
      }
      await db.transaction(async (tx) => {
        await tx.delete(showcasePhotos).where(eq(showcasePhotos.showcaseId, id));
        if (body.photos.length) {
          await tx.insert(showcasePhotos).values(
            body.photos.map((p) => ({
              showcaseId: id,
              mediaId: p.mediaId,
              sortOrder: p.sortOrder,
              caption: p.caption ?? null,
              pairGroupId: p.pairGroupId ?? null,
              pairRole: p.pairRole ?? null,
            })),
          );
        }
        // Cover must remain a member of the set.
        if (existing.coverMediaId && !mediaIds.includes(existing.coverMediaId)) {
          await tx.update(showcases).set({ coverMediaId: mediaIds[0] ?? null, updatedAt: new Date() }).where(eq(showcases.id, id));
        } else {
          await tx.update(showcases).set({ updatedAt: new Date() }).where(eq(showcases.id, id));
        }
      });
      const photos = await loadShowcasePhotoRows([id]);
      res.json({ photos: photos.map((p) => ({ ...p, url: publicImgUrl(p.mediaId) })) });
    } catch (e: any) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.message });
      console.error("[showcases] photos put failed:", e);
      res.status(500).json({ message: "Failed to update photos" });
    }
  });

  app.get("/api/showcase-settings", requireReadAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const settings = await getOrCreateSettings(accountId);
      const [acct] = await db.select({ name: accounts.name, companyLogoUrl: accounts.companyLogoUrl }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
      res.json({ ...settings, accountName: acct?.name ?? null, accountLogoUrl: acct?.companyLogoUrl ?? null });
    } catch (e) {
      console.error("[showcases] settings get failed:", e);
      res.status(500).json({ message: "Failed to fetch settings" });
    }
  });

  app.get("/api/showcase-settings/slug-check", requireReadAccess, async (req: any, res) => {
    try {
      const slug = String(req.query.slug || "");
      if (!SLUG_RE.test(slug)) return res.json({ available: false, reason: "invalid" });
      const [row] = await db.select({ accountId: showcaseSettings.accountId }).from(showcaseSettings).where(eq(showcaseSettings.portfolioSlug, slug)).limit(1);
      res.json({ available: !row || row.accountId === req.user.accountId });
    } catch (e) {
      res.status(500).json({ message: "Failed to check slug" });
    }
  });

  app.patch("/api/showcase-settings", requireWriteAccess, async (req: any, res) => {
    try {
      const accountId = req.user.accountId;
      if (!accountId) return res.status(403).json({ message: "No account associated" });
      const patch = settingsPatchSchema.parse(req.body);
      const settings = await getOrCreateSettings(accountId);
      if (patch.portfolioSlug !== undefined && patch.portfolioSlug !== null) {
        const [clash] = await db.select({ accountId: showcaseSettings.accountId }).from(showcaseSettings)
          .where(eq(showcaseSettings.portfolioSlug, patch.portfolioSlug)).limit(1);
        if (clash && clash.accountId !== accountId) return res.status(409).json({ message: "That portfolio URL is taken" });
      }
      const enabling = patch.portfolioEnabled === true && !settings.portfolioEnabled;
      const finalSlug = patch.portfolioSlug !== undefined ? patch.portfolioSlug : settings.portfolioSlug;
      if (enabling && !finalSlug) return res.status(400).json({ message: "Set a portfolio URL before enabling" });
      const [updated] = await db
        .update(showcaseSettings)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(showcaseSettings.accountId, accountId))
        .returning();
      res.json(updated);
    } catch (e: any) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.message });
      console.error("[showcases] settings patch failed:", e);
      res.status(500).json({ message: "Failed to update settings" });
    }
  });

  // ------------------------- Public (no auth) -------------------------------

  async function loadPublicPortfolio(slug: string) {
    const [settings] = await db
      .select()
      .from(showcaseSettings)
      .where(and(eq(showcaseSettings.portfolioSlug, slug), eq(showcaseSettings.portfolioEnabled, true)))
      .limit(1);
    if (!settings) return null;
    const [acct] = await db.select({ name: accounts.name, companyLogoUrl: accounts.companyLogoUrl, deletedAt: accounts.deletedAt })
      .from(accounts).where(eq(accounts.id, settings.accountId)).limit(1);
    if (!acct || acct.deletedAt) return null;
    return { settings, account: acct };
  }

  function publicSettingsShape(settings: typeof showcaseSettings.$inferSelect, acct: { name: string; companyLogoUrl: string | null }) {
    return {
      portfolioSlug: settings.portfolioSlug,
      displayName: settings.displayName || acct.name,
      logoUrl: settings.logoUrl || acct.companyLogoUrl,
      brandColor: settings.brandColor,
      showMap: settings.showMap,
      contactCtaEnabled: settings.contactCtaEnabled,
      contactCtaLabel: settings.contactCtaLabel,
      contactCtaUrl: settings.contactCtaUrl,
      introText: settings.introText,
    };
  }

  app.get("/api/public/portfolio/:slug", async (req, res) => {
    try {
      const ctx = await loadPublicPortfolio(req.params.slug);
      if (!ctx) return res.status(404).json({ message: "Portfolio not found" });
      const rows = await db
        .select()
        .from(showcases)
        .where(and(eq(showcases.accountId, ctx.settings.accountId), eq(showcases.status, "published")))
        .orderBy(desc(showcases.publishedAt));
      const photoRows = await loadShowcasePhotoRows(rows.map((r) => r.id));
      const firstMedia = new Map<number, number>();
      const counts = new Map<number, number>();
      for (const p of photoRows) {
        counts.set(p.showcaseId, (counts.get(p.showcaseId) || 0) + 1);
        if (!firstMedia.has(p.showcaseId)) firstMedia.set(p.showcaseId, p.mediaId);
      }
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({
        portfolio: publicSettingsShape(ctx.settings, ctx.account),
        showcases: rows.map((r) => ({
          slug: r.slug,
          title: r.title,
          projectTypes: r.projectTypes,
          locationLabel: r.locationLabel,
          displayLat: r.displayLat,
          displayLng: r.displayLng,
          photoCount: counts.get(r.id) || 0,
          coverUrl: publicImgUrl(r.coverMediaId || firstMedia.get(r.id) || 0),
        })),
      });
    } catch (e) {
      console.error("[showcases] public portfolio failed:", e);
      res.status(500).json({ message: "Failed to load portfolio" });
    }
  });

  app.get("/api/public/portfolio/:slug/:showcaseSlug", async (req, res) => {
    try {
      const ctx = await loadPublicPortfolio(req.params.slug);
      if (!ctx) return res.status(404).json({ message: "Portfolio not found" });
      const [sc] = await db
        .select()
        .from(showcases)
        .where(and(
          eq(showcases.accountId, ctx.settings.accountId),
          eq(showcases.slug, req.params.showcaseSlug),
          eq(showcases.status, "published"),
        ))
        .limit(1);
      if (!sc) return res.status(404).json({ message: "Showcase not found" });
      const photos = await loadShowcasePhotoRows([sc.id]);
      const more = await db
        .select()
        .from(showcases)
        .where(and(eq(showcases.accountId, ctx.settings.accountId), eq(showcases.status, "published"), ne(showcases.id, sc.id)))
        .orderBy(desc(showcases.publishedAt))
        .limit(6);
      const morePhotoRows = await loadShowcasePhotoRows(more.map((m) => m.id));
      const moreFirst = new Map<number, number>();
      for (const p of morePhotoRows) if (!moreFirst.has(p.showcaseId)) moreFirst.set(p.showcaseId, p.mediaId);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json({
        portfolio: publicSettingsShape(ctx.settings, ctx.account),
        showcase: {
          slug: sc.slug,
          title: sc.title,
          description: sc.description,
          projectTypes: sc.projectTypes,
          productsUsed: sc.productsUsed,
          locationLabel: sc.locationLabel,
          displayLat: sc.displayLat,
          displayLng: sc.displayLng,
          publishedAt: sc.publishedAt,
          coverUrl: publicImgUrl(sc.coverMediaId || photos[0]?.mediaId || 0),
          photos: photos.map((p) => ({
            id: p.id,
            url: publicImgUrl(p.mediaId),
            caption: p.caption,
            pairGroupId: p.pairGroupId,
            pairRole: p.pairRole,
            sortOrder: p.sortOrder,
          })),
        },
        moreShowcases: more.map((m) => ({
          slug: m.slug,
          title: m.title,
          locationLabel: m.locationLabel,
          coverUrl: publicImgUrl(m.coverMediaId || moreFirst.get(m.id) || 0),
        })),
      });
    } catch (e) {
      console.error("[showcases] public showcase failed:", e);
      res.status(500).json({ message: "Failed to load showcase" });
    }
  });

  // View recording. The client throttles per browser session (sessionStorage);
  // server additionally caps payload and ignores unknown slugs silently.
  app.post("/api/public/portfolio/:slug/view", async (req, res) => {
    try {
      const ctx = await loadPublicPortfolio(req.params.slug);
      if (!ctx) return res.status(204).end();
      const body = z.object({ showcaseSlug: z.string().max(80).nullable().optional(), referrer: z.string().max(500).nullable().optional() }).parse(req.body ?? {});
      let showcaseId: number | null = null;
      if (body.showcaseSlug) {
        const [sc] = await db.select({ id: showcases.id }).from(showcases)
          .where(and(eq(showcases.accountId, ctx.settings.accountId), eq(showcases.slug, body.showcaseSlug), eq(showcases.status, "published"))).limit(1);
        if (!sc) return res.status(204).end();
        showcaseId = sc.id;
      }
      await db.insert(showcaseViews).values({
        accountId: ctx.settings.accountId,
        showcaseId,
        referrer: body.referrer?.slice(0, 500) ?? null,
      });
      res.status(204).end();
    } catch {
      res.status(204).end();
    }
  });

  // Public image variant: resized + re-encoded via sharp (EXIF/GPS stripped —
  // sharp drops all metadata unless .withMetadata() is called). Only serves
  // media that is part of a PUBLISHED showcase whose account portfolio is
  // ENABLED — prevents id enumeration of private photos.
  app.get("/api/public/showcase-img/:mediaId", async (req, res) => {
    try {
      const mediaId = parseInt(req.params.mediaId);
      if (!Number.isFinite(mediaId) || mediaId <= 0) return res.status(404).end();
      const [row] = await db
        .select({ url: media.url, mimeType: media.mimeType })
        .from(showcasePhotos)
        .innerJoin(showcases, eq(showcasePhotos.showcaseId, showcases.id))
        .innerJoin(showcaseSettings, eq(showcases.accountId, showcaseSettings.accountId))
        .innerJoin(media, eq(showcasePhotos.mediaId, media.id))
        .where(and(
          eq(showcasePhotos.mediaId, mediaId),
          eq(showcaseSettings.portfolioEnabled, true),
          sql`${media.mimeType} LIKE 'image/%'`,
        ))
        .limit(1);
      // Internal editor also uses this URL for drafts — allow when the request
      // is authenticated for the owning account; otherwise require published.
      let allowed = false;
      if (row) {
        const [pub] = await db
          .select({ id: showcasePhotos.id })
          .from(showcasePhotos)
          .innerJoin(showcases, eq(showcasePhotos.showcaseId, showcases.id))
          .innerJoin(showcaseSettings, eq(showcases.accountId, showcaseSettings.accountId))
          .where(and(
            eq(showcasePhotos.mediaId, mediaId),
            eq(showcases.status, "published"),
            eq(showcaseSettings.portfolioEnabled, true),
          ))
          .limit(1);
        allowed = !!pub;
      }
      if (!allowed) {
        // Authenticated fallback: owner account can preview drafts.
        const user = (req as any).user;
        if (user?.accountId) {
          const [own] = await db
            .select({ id: showcasePhotos.id })
            .from(showcasePhotos)
            .innerJoin(showcases, eq(showcasePhotos.showcaseId, showcases.id))
            .where(and(eq(showcasePhotos.mediaId, mediaId), eq(showcases.accountId, user.accountId)))
            .limit(1);
          if (own) allowed = true;
        }
      }
      if (!allowed) return res.status(404).end();

      // Fetch original bytes.
      let urlRow = row;
      if (!urlRow) {
        const [m] = await db.select({ url: media.url, mimeType: media.mimeType }).from(media).where(eq(media.id, mediaId)).limit(1);
        if (!m) return res.status(404).end();
        urlRow = m;
      }
      const w = Math.min(Math.max(parseInt(String(req.query.w || "1600")) || 1600, 200), 2400);
      let raw: Buffer;
      if (isS3Url(urlRow.url)) {
        const key = extractS3KeyFromUrl(urlRow.url);
        if (!key) return res.status(404).end();
        const stream = await getObjectStream(key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
        raw = Buffer.concat(chunks);
      } else {
        const absolute = urlRow.url.startsWith("/")
          ? `${req.protocol}://${req.get("host")}${urlRow.url}`
          : urlRow.url;
        const r = await fetch(absolute);
        if (!r.ok) return res.status(404).end();
        raw = Buffer.from(await r.arrayBuffer());
      }
      const out = await sharp(raw)
        .rotate()
        .resize(w, w * 2, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      res.end(out);
    } catch (e) {
      console.error("[showcases] public img failed:", e);
      res.status(404).end();
    }
  });

  // ---------------------- OG-injected HTML for /p/* -------------------------
  // In production the built index.html is served with injected OpenGraph +
  // schema.org markup so link scrapers unfurl correctly. In dev (no dist
  // build) we fall through to the Vite middleware.
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // Safe JSON-LD serialization: prevents `</script>` breakout from
  // user-controlled fields embedded inside <script> tags.
  const jsonLd = (o: unknown) =>
    JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

  async function renderPHtml(req: any, res: any, next: any) {
    try {
      const distIndex = path.resolve(import.meta.dirname, "public", "index.html");
      if (!fs.existsSync(distIndex)) return next(); // dev — let Vite serve
      const slug = req.params.slug as string;
      const sub = (req.params.showcaseSlug as string | undefined) || undefined;
      let html = fs.readFileSync(distIndex, "utf-8");
      const ctx = await loadPublicPortfolio(slug);
      if (!ctx) return res.status(200).setHeader("Content-Type", "text/html").end(html);

      const base = `${req.protocol}://${req.get("host")}`;
      const p = publicSettingsShape(ctx.settings, ctx.account);
      let title = `${p.displayName} — Project Portfolio`;
      let description = p.introText || `See recent projects by ${p.displayName}.`;
      let image: string | null = null;
      let ldExtra = "";
      let url = `${base}/p/${slug}`;

      if (sub && sub !== "embed") {
        const [sc] = await db.select().from(showcases).where(and(
          eq(showcases.accountId, ctx.settings.accountId),
          eq(showcases.slug, sub),
          eq(showcases.status, "published"),
        )).limit(1);
        if (sc) {
          title = `${sc.title} — ${p.displayName}`;
          description = sc.description?.slice(0, 200) || `${sc.title}${sc.locationLabel ? ` in ${sc.locationLabel}` : ""} by ${p.displayName}.`;
          const photos = await loadShowcasePhotoRows([sc.id]);
          const coverId = sc.coverMediaId || photos[0]?.mediaId;
          if (coverId) image = `${base}${publicImgUrl(coverId)}?w=1200`;
          url = `${base}/p/${slug}/${sc.slug}`;
          ldExtra = `<script type="application/ld+json">${jsonLd({
            "@context": "https://schema.org",
            "@type": "ImageGallery",
            name: sc.title,
            description,
            url,
            image: photos.slice(0, 10).map((ph) => `${base}${publicImgUrl(ph.mediaId)}`),
          })}</script>`;
        }
      } else {
        const [first] = await db.select().from(showcases).where(and(
          eq(showcases.accountId, ctx.settings.accountId),
          eq(showcases.status, "published"),
        )).orderBy(desc(showcases.publishedAt)).limit(1);
        if (first) {
          const photos = await loadShowcasePhotoRows([first.id]);
          const coverId = first.coverMediaId || photos[0]?.mediaId;
          if (coverId) image = `${base}${publicImgUrl(coverId)}?w=1200`;
        }
      }

      const localBusiness = `<script type="application/ld+json">${jsonLd({
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        name: p.displayName,
        url,
        ...(p.logoUrl ? { logo: p.logoUrl } : {}),
        ...(p.contactCtaUrl ? { sameAs: [p.contactCtaUrl] } : {}),
      })}</script>`;

      const tags = [
        `<title>${escapeHtml(title)}</title>`,
        `<meta name="description" content="${escapeHtml(description)}" />`,
        `<meta property="og:title" content="${escapeHtml(title)}" />`,
        `<meta property="og:description" content="${escapeHtml(description)}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:url" content="${escapeHtml(url)}" />`,
        ...(image ? [`<meta property="og:image" content="${escapeHtml(image)}" />`, `<meta name="twitter:card" content="summary_large_image" />`, `<meta name="twitter:image" content="${escapeHtml(image)}" />`] : []),
        `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
        localBusiness,
        ldExtra,
      ].join("\n    ");

      // Replace an existing <title> if present, then inject before </head>.
      html = html.replace(/<title>[\s\S]*?<\/title>/, "");
      html = html.replace("</head>", `    ${tags}\n  </head>`);
      res.status(200).setHeader("Content-Type", "text/html").end(html);
    } catch (e) {
      console.error("[showcases] og html failed:", e);
      next();
    }
  }

  app.get("/p/:slug", renderPHtml);
  app.get("/p/:slug/:showcaseSlug", renderPHtml);
}
