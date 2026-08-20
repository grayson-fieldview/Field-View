/**
 * Shared "Generate with AI" dialog — used by BOTH the report editor
 * (report-edit.tsx, regenerating an existing report) and the project
 * detail Reports tab (project-detail.tsx, create + generate in one step).
 *
 * The two callers differ only in:
 *   - showReplaceWarning: editor only (there's nothing to replace on create)
 *   - what happens on success (re-init draft vs navigate) — owned by the
 *     caller's mutation; this component just collects inputs and calls
 *     onGenerate.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Sparkles } from "lucide-react";
import { VoiceNoteButton } from "./voice-note-button";
import type { Media } from "@shared/schema";
import { formatCreditReset, type AiCredits } from "@/hooks/use-ai-credits";

export type AiReportType = "client_update" | "daily_log" | "progress_recap";

export type AiGenerateParams = {
  mediaIds: number[];
  note?: string;
  reportType: AiReportType;
};

const REPORT_TYPE_OPTIONS = [
  { value: "client_update", label: "Client Update" },
  { value: "daily_log", label: "Daily Log" },
  { value: "progress_recap", label: "Progress Recap" },
] as const;

// 75 = measured-safe ceiling (60s maxDuration) — lockstep with
// generateReportBodySchema and the PDF cap in server/routes.ts.
const MAX_PHOTOS = 75;

export function AiGenerateDialog({
  open,
  onOpenChange,
  projectMedia,
  isPending,
  showReplaceWarning = false,
  credits,
  isCreditsLoading = false,
  creditsUnavailable = false,
  isOutOfCredits = false,
  outOfCreditsResetAt,
  onRetryCredits,
  onGenerate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectMedia: Media[];
  isPending: boolean;
  showReplaceWarning?: boolean;
  credits?: AiCredits;
  isCreditsLoading?: boolean;
  creditsUnavailable?: boolean;
  isOutOfCredits?: boolean;
  outOfCreditsResetAt?: string;
  onRetryCredits?: () => void;
  onGenerate: (params: AiGenerateParams) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [reportType, setReportType] = useState<AiReportType>("client_update");
  const [voiceBusy, setVoiceBusy] = useState(false);
  // Incremented on close so an active recording is force-stopped (discarded).
  const [voiceStopSignal, setVoiceStopSignal] = useState(0);

  // Reset inputs whenever the dialog closes (cancel or success).
  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set());
      setNote("");
      setReportType("client_update");
      setVoiceBusy(false);
      setVoiceStopSignal((n) => n + 1);
    }
  }, [open]);

  function toggleSelection(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll(ids: number[]) {
    setSelectedIds((prev) => (prev.size === ids.length ? new Set() : new Set(ids)));
  }

  const creditsRemaining = (credits?.monthly_remaining ?? 0) + (credits?.purchased_remaining ?? 0);
  const resetAt = formatCreditReset(outOfCreditsResetAt ?? credits?.next_reset_at);
  const creditsBlockGeneration = isCreditsLoading || creditsUnavailable || isOutOfCredits;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isPending) return; // don't close mid-generation
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col" data-testid="dialog-generate-ai">
        <DialogHeader>
          <DialogTitle>Generate report with AI</DialogTitle>
          <DialogDescription>
            Select photos, add a note, and pick a report type. Generation takes 10–30 seconds.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto -mx-6 px-6 space-y-4">
          {isCreditsLoading && (
            <div
              className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground flex items-center gap-2"
              data-testid="text-ai-credits-loading"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading AI credits...
            </div>
          )}

          {creditsUnavailable && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive flex items-center justify-between gap-3"
              role="alert"
              data-testid="text-ai-credits-unavailable"
            >
              <span>AI credits are temporarily unavailable.</span>
              {onRetryCredits && (
                <Button type="button" variant="outline" size="sm" onClick={onRetryCredits}>
                  Retry
                </Button>
              )}
            </div>
          )}

          {credits &&
            !isCreditsLoading &&
            !creditsUnavailable &&
            (!isOutOfCredits || creditsRemaining === 0) && (
            <div
              className="rounded-md border bg-muted/40 px-3 py-2 text-sm"
              data-testid="text-ai-credits-remaining"
            >
              <span className="font-medium">
                {creditsRemaining} AI credit{creditsRemaining === 1 ? "" : "s"} remaining
              </span>
              <span className="text-muted-foreground">
                {" "}({credits.monthly_remaining} monthly, {credits.purchased_remaining} purchased)
              </span>
            </div>
          )}

          {isOutOfCredits && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              role="alert"
              data-testid="text-ai-credits-exhausted"
            >
              <p className="font-medium">You&apos;re out of AI credits.</p>
              <p className="mt-0.5">
                {resetAt
                  ? `Your monthly credits reset ${resetAt}.`
                  : "Retry the credit check to see your next reset time."}
              </p>
            </div>
          )}

          {showReplaceWarning && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="text-ai-replace-warning">
              Generating replaces ALL existing sections in this report. Your cover settings are kept, but the cover description is rewritten.
            </div>
          )}

          {/* Report type */}
          <div>
            <p className="text-sm font-medium mb-2">Report type</p>
            <div className="flex flex-wrap gap-2">
              {REPORT_TYPE_OPTIONS.map((t) => (
                <Button
                  key={t.value}
                  type="button"
                  size="sm"
                  variant={reportType === t.value ? "default" : "outline"}
                  onClick={() => setReportType(t.value)}
                  data-testid={`button-report-type-${t.value}`}
                >
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Note */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">Note (optional)</p>
              <VoiceNoteButton
                stopSignal={voiceStopSignal}
                onBusyChange={setVoiceBusy}
                onTranscript={(text) =>
                  // APPEND, never replace — someone may type, record, type more.
                  setNote((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text))
                }
              />
            </div>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Describe the work — what was done, anything worth flagging"
              rows={3}
              data-testid="input-ai-note"
            />
          </div>

          {/* Photo multi-select */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium">
                Photos <span className="text-muted-foreground font-normal">({selectedIds.size} selected, max {MAX_PHOTOS})</span>
              </p>
              {projectMedia.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleSelectAll(projectMedia.slice(0, MAX_PHOTOS).map((m) => m.id))}
                  data-testid="button-ai-select-all"
                >
                  {selectedIds.size === Math.min(projectMedia.length, MAX_PHOTOS) ? "Clear all" : "Select all"}
                </Button>
              )}
            </div>
            {projectMedia.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">This project has no photos yet.</p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {projectMedia.map((m) => {
                  const checked = selectedIds.has(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleSelection(m.id)}
                      className={`relative aspect-square rounded-md overflow-hidden border-2 transition-colors ${
                        checked ? "border-primary" : "border-transparent"
                      }`}
                      data-testid={`button-ai-pick-media-${m.id}`}
                    >
                      <img src={m.url} alt="" className="object-cover w-full h-full" />
                      {checked && (
                        <div className="absolute top-1 right-1 bg-primary text-primary-foreground text-xs rounded-full h-5 w-5 flex items-center justify-center">
                          ✓
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            data-testid="button-cancel-ai"
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              onGenerate({
                mediaIds: Array.from(selectedIds),
                note: note.trim() || undefined,
                reportType,
              })
            }
            disabled={
              selectedIds.size === 0 ||
              selectedIds.size > MAX_PHOTOS ||
              isPending ||
              voiceBusy ||
              creditsBlockGeneration
            }
            data-testid="button-confirm-ai"
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Generating... this takes 10–30s
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-1.5" />
                Generate ({selectedIds.size} photo{selectedIds.size === 1 ? "" : "s"})
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
