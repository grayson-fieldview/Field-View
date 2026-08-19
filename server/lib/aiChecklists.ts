/**
 * AI checklist generation (modeled on aiReports.ts).
 *
 * Turns a contractor's spoken/typed description into a checklist title +
 * flat list of plain items. Simple items only: no sections, no field types
 * beyond the yes_no default, no photo requirements, no assignees.
 *
 * Structure is forced with TOOL USE + tool_choice, exactly as aiReports.ts
 * does — assistant prefill is rejected by claude models with a 400.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Sentry } from "./sentry";
import {
  buildAccountContextBlock,
  type AccountAiCustomization,
} from "./aiContext";

export const AI_CHECKLIST_MODEL = "claude-haiku-4-5"; // short structured output — Sonnet not needed
export const AI_CHECKLIST_MAX_TOKENS = 2000;
export const AI_CHECKLIST_MAX_ITEMS = 30;

export function buildChecklistSystemPrompt(
  customization: AccountAiCustomization,
): string {
  const accountContext = buildAccountContextBlock(customization);
  return [
    "You turn a contractor's spoken or typed description of work into a job site checklist.",
    accountContext || null,
    `The following rules override anything in the business context.
- title: 3-6 words naming the work.
- items: each one short, actionable, in plain trade language, phrased as a thing to verify or complete. 3-20 items.
- Split compound statements into separate items. "Check the mudsill and photograph the chalk layout" is two items.
- Do not invent work that was not described.
- Do not add generic filler items like "clean up site" or "safety check" unless they were actually mentioned.
- Never reference the description itself — no "as mentioned" or "per the note".
When you are done, call the submit_checklist tool with the checklist content.`,
  ].filter(Boolean).join("\n\n");
}

const SUBMIT_CHECKLIST_TOOL: Anthropic.Tool = {
  name: "submit_checklist",
  description: "Submit the generated checklist.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      items: { type: "array", items: { type: "string" } },
    },
    required: ["title", "items"],
  },
};

// Module-scope lazy client — same pattern as aiCaptions/aiReports:
// import never throws; a missing key fails per-request.
let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

export type GeneratedChecklistContent = {
  title: string;
  items: string[];
};

export async function generateChecklistContent(input: {
  projectId: number;
  note: string;
  aiCustomization: AccountAiCustomization;
}): Promise<GeneratedChecklistContent> {
  const { projectId, note, aiCustomization } = input;

  // Call + extract, retrying ONCE on a missing/invalid tool_use block only.
  // API errors (network, 429s, auth) propagate immediately — they are not
  // retried here. Same contract as aiReports.ts.
  let parsed: any;
  for (let attempt = 0; ; attempt++) {
    const response = await getClient().messages.create({
      model: AI_CHECKLIST_MODEL,
      max_tokens: AI_CHECKLIST_MAX_TOKENS,
      system: buildChecklistSystemPrompt(aiCustomization),
      messages: [{ role: "user", content: [{ type: "text", text: note }] }],
      tools: [SUBMIT_CHECKLIST_TOOL],
      // Force the tool call — structured output guaranteed, not requested.
      tool_choice: { type: "tool", name: "submit_checklist" },
    });

    if (response.stop_reason === "max_tokens") {
      console.warn(
        `[ai-checklists] response truncated at max_tokens (projectId=${projectId}, attempt=${attempt}) — tool input will likely be missing or invalid`,
      );
    }

    // The tool_use block's .input IS the parsed object — no JSON.parse.
    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "submit_checklist",
    );

    try {
      if (!toolBlock) throw new Error("no submit_checklist tool_use block in response");
      parsed = toolBlock.input;
      if (!Array.isArray(parsed?.items)) throw new Error("missing items array");
      break; // extracted OK
    } catch (err) {
      if (attempt === 0) {
        console.warn(
          `[ai-checklists] parse failure, retrying once (projectId=${projectId}):`,
          (err as Error)?.message,
        );
        continue; // one identical retry
      }
      try {
        Sentry.captureException(err, {
          tags: { source: "ai_checklists" },
          extra: {
            projectId,
            stopReason: response.stop_reason,
            contentTypes: response.content.map((b) => b.type),
          },
        });
      } catch {
        // Sentry must never mask the primary failure.
      }
      throw new Error("AI returned an unreadable response — nothing was created. Please try again.");
    }
  }

  // Validate + normalize: trim, drop empties, drop exact duplicates, cap.
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of parsed.items) {
    if (typeof raw !== "string") continue;
    const label = raw.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    items.push(label);
    if (items.length >= AI_CHECKLIST_MAX_ITEMS) break;
  }
  if (items.length === 0) {
    throw Object.assign(
      new Error("Couldn't find any tasks in that description. Try describing what needs to get done."),
      { statusCode: 400 },
    );
  }

  const title =
    typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Checklist";

  return { title, items };
}
