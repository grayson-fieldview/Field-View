/**
 * AI checklist generation dialog. Deliberately NOT AiGenerateDialog — that
 * component requires projectMedia + reportType. This borrows its inner
 * pattern only: note textarea with VoiceNoteButton in the label row,
 * voiceBusy gating Generate, voiceStopSignal bumped on close so an active
 * recording is force-stopped and discarded.
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Sparkles } from "lucide-react";
import { VoiceNoteButton } from "@/components/report-editor/voice-note-button";

export function ChecklistGenerateDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | number;
  /** Called with the new checklist id after a successful generation. */
  onCreated?: (checklistId: number) => void;
}) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [voiceBusy, setVoiceBusy] = useState(false);
  // Incremented on close so an active recording is force-stopped (discarded).
  const [voiceStopSignal, setVoiceStopSignal] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset inputs whenever the dialog closes (cancel or success).
  useEffect(() => {
    if (!open) {
      setNote("");
      setVoiceBusy(false);
      setErrorMessage(null);
      setVoiceStopSignal((n) => n + 1);
    }
  }, [open]);

  const generate = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/checklists/generate`, {
        note: note.trim(),
      });
      return res.json() as Promise<{ checklistId: number; itemCount: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", String(projectId)] });
      queryClient.invalidateQueries({ queryKey: ["/api/checklists"] });
      onOpenChange(false);
      toast({ title: `Checklist created — ${data.itemCount} items.` });
      if (data?.checklistId) onCreated?.(data.checklistId);
    },
    onError: (error: Error) => {
      // Surface the server message plainly (400 validation, 429 limit, 503).
      // apiRequest throws `${status}: ${rawBody}` where rawBody is usually
      // JSON — parse out .message rather than showing the raw payload.
      const raw = error.message.replace(/^\d{3}:\s*/, "");
      let msg = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.message === "string" && parsed.message) msg = parsed.message;
      } catch {
        // not JSON — show as-is
      }
      setErrorMessage(msg || "Failed to generate checklist");
    },
  });

  const canGenerate = note.trim().length > 0 && !voiceBusy && !generate.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-generate-checklist">
        <DialogHeader>
          <DialogTitle>Generate Checklist with AI</DialogTitle>
          <DialogDescription>
            Record a voice note or type what needs to get done. AI turns it into a checklist.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="checklist-generate-note">Description</Label>
            <VoiceNoteButton
              onTranscript={(text) =>
                setNote((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
              }
              onBusyChange={setVoiceBusy}
              stopSignal={voiceStopSignal}
            />
          </div>
          <Textarea
            id="checklist-generate-note"
            placeholder="Describe what needs to get done"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="min-h-[120px]"
            data-testid="input-generate-checklist-note"
          />
          {errorMessage && (
            <p className="text-sm text-destructive" data-testid="text-generate-checklist-error">
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={generate.isPending}
            data-testid="button-cancel-generate-checklist"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              setErrorMessage(null);
              generate.mutate();
            }}
            disabled={!canGenerate}
            data-testid="button-submit-generate-checklist"
          >
            {generate.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-2" />
                Generate
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
