/**
 * AI report generation (Claude, text-only).
 *
 * Turns a photo selection + contractor note into structured report content
 * written into the EXISTING reports tables (report_sections /
 * report_section_photos). No images are sent to the model — media.aiCaption
 * (server/lib/aiCaptions.ts) is the photo input; that is the whole reason
 * the captions exist.
 *
 * Naming trap — three distinct "caption" fields:
 *   media.caption               user-authored, NEVER touched here
 *   media.aiCaption             AI photo caption (INPUT)
 *   reportSectionPhotos.caption photo TITLE in the PDF (OUTPUT)
 *
 * Contract: generateReportContent THROWS on failure (model error, parse
 * failure) — unlike aiCaptions this runs synchronously in a request path
 * and the route must surface a clean 500 with nothing written. Parse
 * failures are reported to Sentry and no partial content is ever written
 * by the caller (the caller wraps all writes in one transaction).
 */
import Anthropic from "@anthropic-ai/sdk";
import { inArray, asc } from "drizzle-orm";
import { db } from "../db";
import { media, comments, aiUsage } from "@shared/schema";
import { sql, and, eq } from "drizzle-orm";
import { Sentry } from "./sentry";

export const AI_REPORT_MODEL = "claude-sonnet-4-6";
// At the 75-photo cap, realistic output is ~2,500 tokens (title + cover +
// sections + per-photo caption/description), so 4000 is comfortable headroom.
// The NON-STREAMING Messages API rejects requests whose max_tokens implies a
// generation long enough to risk a network timeout (live 400s at 8000 with
// 44+ photos). Do NOT raise this without switching to streaming.
export const AI_REPORT_MAX_TOKENS = 4000;
export const AI_REPORT_MONTHLY_LIMIT = 1000;
export const AI_REPORT_FEATURE = "report_generation";

/**
 * Classify an Anthropic APIError for the generate routes' catch-alls.
 * Returns the HTTP status + user-facing message to respond with, or null
 * when the error is not an Anthropic API error the routes should special-
 * case (fall through to the existing generic handling). Slot release is
 * the caller's job and happens BEFORE this — reservation logic unchanged.
 */
export function classifyAnthropicApiError(
  err: unknown,
): { status: number; message: string } | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  if (err.status === 400) {
    // Log the FULL error body — a 400 here is a bug in how we build the
    // request (e.g. max_tokens over the non-streaming limit), never user error.
    try {
      Sentry.captureException(err, {
        tags: { source: "ai_reports" },
        extra: { errorBody: (err as any).error },
      });
    } catch {
      // Sentry must never mask the primary failure.
    }
    return {
      status: 500,
      message:
        "The AI service rejected the request. This is a bug on our end — please try again or contact support.",
    };
  }
  if (err.status === 429 || err.status === 529) {
    return { status: 503, message: "The AI service is busy. Please try again in a moment." };
  }
  return null;
}

export type ReportType = "client_update" | "daily_log" | "progress_recap";
export const REPORT_TYPES: ReportType[] = ["client_update", "daily_log", "progress_recap"];

export type GeneratedPhoto = {
  mediaId: number;
  caption: string; // short title, 3-8 words → reportSectionPhotos.caption
  description: string | null; // one sentence → reportSectionPhotos.description
};
export type GeneratedSection = {
  title: string;
  summary: string | null;
  photos: GeneratedPhoto[];
};
export type GeneratedReportContent = {
  /** AI-suggested report title. Used only when CREATING a report from
   * generation; existing reports keep their user-chosen title. */
  title: string;
  coverDescription: string;
  sections: GeneratedSection[];
  /** Photos the model excluded as not showing project work. Per-generation
   * feedback for the user — never persisted, never written to the report. */
  excludedMediaIds: number[];
};

// Module-scope lazy client (same pattern as aiCaptions.ts).
let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

const TONE_BY_TYPE: Record<ReportType, string> = {
  client_update:
    "This is a CLIENT UPDATE the contractor sends to their customer. Plain and reassuring. Do not use jargon about problems, defects, or issues — describe work performed and progress made.",
  daily_log:
    "This is an internal DAILY LOG. Factual and direct. It may name issues, delays, or problems plainly — it is not customer-facing.",
  progress_recap:
    "This is a PROGRESS RECAP. Status-oriented: what has been completed and what comes next. Keep it organized around progress.",
};

function buildSystemPrompt(reportType: ReportType): string {
  return `You write construction/trade job reports from photo descriptions. ${TONE_BY_TYPE[reportType]}

Rules:
- Never mention missing, absent, unclear, or undescribed source material. Never write phrases like "several images lack descriptions" or "no additional details were provided". Describe only what is present. This is a document the contractor sends to their customer.
- Never describe or attempt to identify people by name or appearance.
- Plain trade language. No marketing adjectives.
- Section count should follow the actual content — do not force a fixed number. A single-trade day may be one section.
- Group photos by work type or area, not strictly by timestamp.
- Never create a section whose purpose is to explain that photos are irrelevant, unrelated, unidentified, or not part of the project.
- Never write a photo caption like "Unidentified photo" or "Unknown image". If you cannot tell what a photo shows, exclude it.

Content guidance: title is a short report title, 3-6 words, naming the work and site. coverDescription is one paragraph, 2-4 sentences. Section titles are short headings in trade language; summaries are 1-2 sentences or null. Photo captions are short titles, 3-8 words; photo descriptions are one sentence or null.
Every photo must either appear exactly once in a section OR be listed in excludedMediaIds. Exclude a photo when it does not show work, materials, conditions, or the site for this job — for example screenshots, app or software interfaces, email or document captures, marketing images, or photos whose subject cannot be determined. Excluding is the correct choice for those; do not include them.
When you are done, call the submit_report tool with the report content.`;
}

// Tool-use is the supported way to force structured output on this model
// (assistant prefill is rejected with a 400). tool_choice forces the call,
// so the shape is guaranteed rather than requested.
const SUBMIT_REPORT_TOOL: Anthropic.Tool = {
  name: "submit_report",
  description: "Submit the structured report content.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      coverDescription: { type: "string" },
      excludedMediaIds: { type: "array", items: { type: "number" } },
      sections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            summary: { type: ["string", "null"] },
            photos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  mediaId: { type: "number" },
                  caption: { type: "string" },
                  description: { type: ["string", "null"] },
                },
                required: ["mediaId", "caption"],
              },
            },
          },
          required: ["title", "photos"],
        },
      },
    },
    required: ["title", "coverDescription", "excludedMediaIds", "sections"],
  },
};

export async function generateReportContent(input: {
  reportId: number;
  projectId: number;
  mediaIds: number[];
  note?: string;
  reportType: ReportType;
}): Promise<GeneratedReportContent> {
  const { reportId, projectId, mediaIds, note, reportType } = input;

  // Pull the photos; verify ALL belong to the report's project.
  const rows = await db
    .select({ id: media.id, projectId: media.projectId, aiCaption: media.aiCaption, createdAt: media.createdAt })
    .from(media)
    .where(inArray(media.id, mediaIds))
    .orderBy(asc(media.createdAt), asc(media.id));
  if (rows.length !== mediaIds.length || rows.some((r) => r.projectId !== projectId)) {
    throw Object.assign(new Error("One or more photos do not belong to this report's project"), { statusCode: 400 });
  }

  // Human comments per photo.
  const commentRows = await db
    .select({ mediaId: comments.mediaId, content: comments.content })
    .from(comments)
    .where(inArray(comments.mediaId, mediaIds))
    .orderBy(asc(comments.createdAt));
  const commentsByMedia = new Map<number, string[]>();
  for (const c of commentRows) {
    const arr = commentsByMedia.get(c.mediaId) ?? [];
    arr.push(c.content);
    commentsByMedia.set(c.mediaId, arr);
  }

  // Assemble the photo list. Null / 'UNCLEAR' captions are treated as "no
  // description" — the sentinel must never leak into the prompt.
  const photoLines = rows.map((r) => {
    const parts: string[] = [`mediaId ${r.id}`];
    if (r.createdAt) parts.push(`taken ${r.createdAt.toISOString().slice(0, 10)}`);
    const cap = r.aiCaption && r.aiCaption !== "UNCLEAR" ? r.aiCaption : null;
    if (cap) parts.push(`description: ${cap}`);
    const humanComments = commentsByMedia.get(r.id) ?? [];
    if (humanComments.length > 0) parts.push(`comments: ${humanComments.join(" | ")}`);
    return `- ${parts.join(" — ")}`;
  });

  const userText = [
    note?.trim() ? `Contractor's note about the work:\n${note.trim()}` : null,
    `Photos (${rows.length}):`,
    photoLines.join("\n"),
    // Always give the turn an actual request — with an empty note the turn
    // is otherwise a bare data dump and the model may reply conversationally.
    "Produce the report JSON described in your instructions for the photos above.",
  ]
    .filter(Boolean)
    .join("\n\n");

  // Call + extract, retrying ONCE on a missing/invalid tool_use block only.
  // API errors (network, 429s, auth) propagate immediately — they are not
  // retried here. A retry consumes a second API call but NOT a second usage
  // slot; the reservation is per-request, made by the caller before this
  // function runs.
  let parsed: any;
  for (let attempt = 0; ; attempt++) {
    const response = await getClient().messages.create({
      model: AI_REPORT_MODEL,
      max_tokens: AI_REPORT_MAX_TOKENS,
      system: buildSystemPrompt(reportType),
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      tools: [SUBMIT_REPORT_TOOL],
      // Force the tool call — structured output guaranteed, not requested.
      tool_choice: { type: "tool", name: "submit_report" },
    });

    // Truncated output cannot be a complete tool call — name the stop_reason
    // so the ensuing failure is diagnosable. Retry/error handling unchanged.
    if (response.stop_reason === "max_tokens") {
      console.warn(
        `[ai-reports] response truncated at max_tokens (stop_reason=max_tokens, reportId=${reportId}, projectId=${projectId}, attempt=${attempt}) — tool input will likely be missing or invalid`,
      );
    }

    // The tool_use block's .input IS the parsed object — no JSON.parse.
    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "submit_report",
    );

    try {
      if (!toolBlock) throw new Error("no submit_report tool_use block in response");
      parsed = toolBlock.input;
      if (typeof parsed?.coverDescription !== "string" || !Array.isArray(parsed?.sections)) {
        throw new Error("missing coverDescription or sections");
      }
      break; // extracted OK
    } catch (err) {
      if (attempt === 0) {
        console.warn(
          `[ai-reports] parse failure, retrying once (reportId=${reportId}, projectId=${projectId}):`,
          (err as Error)?.message,
        );
        continue; // one identical retry
      }
      try {
        Sentry.captureException(err, {
          tags: { source: "ai_reports" },
          extra: {
            reportId,
            projectId,
            stopReason: response.stop_reason,
            contentTypes: response.content.map((b) => b.type),
          },
        });
      } catch {
        // Sentry must never mask the primary failure.
      }
      throw new Error("AI returned an unreadable response — nothing was changed. Please try again.");
    }
  }

  // Validate + normalize. Drop hallucinated mediaIds; dedupe repeats; append
  // photos that are neither placed nor explicitly excluded to a final
  // "Additional Photos" section.
  const inputIds = new Set(mediaIds);
  const seen = new Set<number>();
  // Model-declared exclusions; ignore ids not in the input set. Resolved
  // AFTER placement below — section placement wins over exclusion.
  const claimedExcluded = new Set<number>(
    (Array.isArray(parsed.excludedMediaIds) ? parsed.excludedMediaIds : [])
      .filter((id: unknown): id is number => typeof id === "number" && inputIds.has(id)),
  );
  const sections: GeneratedSection[] = [];
  for (const s of parsed.sections) {
    if (!s || typeof s.title !== "string") continue;
    const photos: GeneratedPhoto[] = [];
    for (const p of Array.isArray(s.photos) ? s.photos : []) {
      const mid = typeof p?.mediaId === "number" ? p.mediaId : NaN;
      if (!inputIds.has(mid) || seen.has(mid)) continue; // drop hallucinated / duplicate
      seen.add(mid);
      photos.push({
        mediaId: mid,
        caption: typeof p.caption === "string" && p.caption.trim() ? p.caption.trim() : "Photo",
        description: typeof p.description === "string" && p.description.trim() ? p.description.trim() : null,
      });
    }
    if (photos.length > 0 || (typeof s.summary === "string" && s.summary.trim())) {
      sections.push({
        title: s.title.trim() || "Untitled Section",
        summary: typeof s.summary === "string" && s.summary.trim() ? s.summary.trim() : null,
        photos,
      });
    }
  }
  // Placement wins: a photo both placed and listed as excluded is placed.
  const excludedMediaIds = mediaIds.filter((id) => claimedExcluded.has(id) && !seen.has(id));
  const excludedSet = new Set(excludedMediaIds);

  // Guard: an all-excluded generation must not produce an empty report.
  // Thrown as a 400-style error so the route surfaces the message plainly
  // and releases the reserved usage slot (route catch paths handle both).
  if (excludedMediaIds.length === mediaIds.length) {
    throw Object.assign(
      new Error("None of the selected photos showed project work. Try selecting different photos."),
      { statusCode: 400 },
    );
  }

  // Append ONLY photos that are neither placed nor explicitly excluded.
  const missing = mediaIds.filter((id) => !seen.has(id) && !excludedSet.has(id));
  if (missing.length > 0) {
    sections.push({
      title: "Additional Photos",
      summary: null,
      photos: missing.map((mediaId) => ({ mediaId, caption: "Photo", description: null })),
    });
  }

  const title =
    typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Project Report";

  return { title, coverDescription: String(parsed.coverDescription).trim(), sections, excludedMediaIds };
}

/** 'YYYY-MM' for the current month (UTC). */
export function currentPeriodMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Current month's generation count for an account (0 when no row). */
export async function getReportGenerationCount(accountId: string): Promise<number> {
  const [row] = await db
    .select({ count: aiUsage.count })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.accountId, accountId),
        eq(aiUsage.feature, AI_REPORT_FEATURE),
        eq(aiUsage.periodMonth, currentPeriodMonth()),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}

/**
 * Atomically reserve one generation slot BEFORE calling the model.
 * Returns true when admitted (count was < limit and is now incremented);
 * false when the monthly limit is already exhausted. The conditional
 * `setWhere` makes the admission decision atomic — concurrent requests
 * can never push count past the limit (check-then-increment would).
 */
export async function tryReserveReportGeneration(
  accountId: string,
  feature: string = AI_REPORT_FEATURE,
): Promise<{ admitted: boolean; periodMonth: string }> {
  const periodMonth = currentPeriodMonth();
  const rows = await db
    .insert(aiUsage)
    .values({ accountId, feature, periodMonth, count: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.accountId, aiUsage.feature, aiUsage.periodMonth],
      set: { count: sql`${aiUsage.count} + 1`, updatedAt: new Date() },
      setWhere: sql`${aiUsage.count} < ${AI_REPORT_MONTHLY_LIMIT}`,
    })
    .returning({ count: aiUsage.count });
  // With setWhere unmet, ON CONFLICT DO UPDATE updates nothing → no row returned.
  return { admitted: rows.length > 0, periodMonth };
}

/**
 * Compensating release when generation or the DB write fails after a
 * reservation — the user shouldn't be charged a slot for a failed attempt.
 * Never throws (called from catch paths). Takes the RESERVATION's
 * periodMonth (not recomputed) so a request crossing the UTC month
 * boundary releases the month it actually reserved against.
 */
export async function releaseReportGeneration(
  accountId: string,
  periodMonth: string,
  feature: string = AI_REPORT_FEATURE,
): Promise<void> {
  try {
    await db
      .update(aiUsage)
      .set({ count: sql`GREATEST(${aiUsage.count} - 1, 0)`, updatedAt: new Date() })
      .where(
        and(
          eq(aiUsage.accountId, accountId),
          eq(aiUsage.feature, feature),
          eq(aiUsage.periodMonth, periodMonth),
        ),
      );
  } catch (err) {
    console.warn("[ai-reports] failed to release reserved generation slot:", (err as Error)?.message);
    try {
      Sentry.captureException(err, { tags: { source: "ai_reports" }, extra: { accountId } });
    } catch {
      // never throw from a compensation path
    }
  }
}
