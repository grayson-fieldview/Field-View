import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, FileText, Plus, Save } from "lucide-react";
import type { ReportTemplate, TemplateConfig } from "@shared/schema";
import { CoverEditor } from "@/components/report-editor/cover-editor";
import { SectionEditor } from "@/components/report-editor/section-editor";
import { DEFAULT_COVER, type CoverConfig, type Section } from "@/components/report-editor/types";

type DraftSection = {
  clientId: string;
  title: string;
  summary: string | null;
};

type Pane = { kind: "cover" } | { kind: "section"; clientId: string };

function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function TemplateEditPage({ id }: { id: string }) {
  const templateId = parseInt(id);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: template, isLoading, isError } = useQuery<ReportTemplate>({
    queryKey: ["/api/report-templates", templateId],
    enabled: !Number.isNaN(templateId),
  });

  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftCover, setDraftCover] = useState<CoverConfig>(DEFAULT_COVER);
  const [draftSections, setDraftSections] = useState<DraftSection[]>([]);

  const [pane, setPane] = useState<Pane>({ kind: "cover" });
  const [pendingPane, setPendingPane] = useState<Pane | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const lastLoadedTemplateIdRef = useRef<number | null>(null);

  // Initialize draft from server payload exactly once per template id.
  useEffect(() => {
    if (!template) return;
    if (lastLoadedTemplateIdRef.current === template.id && isDirty) return;
    lastLoadedTemplateIdRef.current = template.id;
    setDraftTitle(template.title);
    const cfg = template.templateConfig as TemplateConfig;
    setDraftDescription(cfg?.cover?.description ?? "");
    setDraftCover({
      ...DEFAULT_COVER,
      ...(cfg?.cover?.coverConfig ?? {}),
      coverPhotoMediaId: null,
    });
    setDraftSections(
      (cfg?.sections ?? []).map((s) => ({
        clientId: newClientId(),
        title: s.title,
        summary: s.summary,
      })),
    );
    setIsDirty(false);
  }, [template, isDirty]);

  // beforeunload guard while dirty.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  function markDirty() {
    setIsDirty(true);
  }

  function samePane(a: Pane, b: Pane): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "section" && b.kind === "section") return a.clientId === b.clientId;
    return true;
  }

  function requestPaneSwitch(next: Pane) {
    if (samePane(next, pane)) return;
    if (isDirty) {
      setPendingPane(next);
    } else {
      setPane(next);
    }
  }

  // Build the templateConfig payload for save.
  function buildTemplateConfig(): TemplateConfig {
    const { coverPhotoMediaId, ...coverToggles } = draftCover;
    return {
      version: 1,
      cover: {
        description: draftDescription.trim() ? draftDescription : null,
        coverConfig: coverToggles,
      },
      sections: draftSections.map((s, idx) => ({
        title: s.title.trim() || "Untitled Section",
        summary: s.summary?.trim() ? s.summary : null,
        sortOrder: idx,
      })),
    };
  }

  const saveDraft = useMutation({
    mutationFn: async () => {
      await apiRequest("PATCH", `/api/report-templates/${templateId}`, {
        title: draftTitle.trim() || "Untitled Template",
        templateConfig: buildTemplateConfig(),
      });
    },
    onSuccess: () => {
      setIsDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/report-templates", templateId] });
      queryClient.invalidateQueries({ queryKey: ["/api/report-templates"] });
      toast({ title: "Template saved" });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  function addSection() {
    const clientId = newClientId();
    setDraftSections((prev) => [...prev, { clientId, title: "New Section", summary: null }]);
    setPane({ kind: "section", clientId });
    markDirty();
  }

  function deleteSection(clientId: string) {
    setDraftSections((prev) => prev.filter((s) => s.clientId !== clientId));
    if (pane.kind === "section" && pane.clientId === clientId) {
      setPane({ kind: "cover" });
    }
    markDirty();
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (isError || !template) {
    return (
      <div className="p-12 text-center" data-testid="text-template-not-found">
        <p className="text-sm text-muted-foreground">Template not found or you don't have access.</p>
        <Link href="/reports?tab=templates">
          <Button variant="outline" className="mt-4" data-testid="button-back-to-templates">Back to templates</Button>
        </Link>
      </div>
    );
  }

  const activeIdx = pane.kind === "section" ? draftSections.findIndex((s) => s.clientId === pane.clientId) : -1;
  const activeSection = activeIdx >= 0 ? draftSections[activeIdx] : undefined;

  // Build a synthetic Section for SectionEditor in template mode.
  // Negative integer id makes it obvious in dev tools / test output that
  // these are template-mode synthetic IDs, not real server-issued ones.
  const syntheticSection: Section | undefined = activeSection
    ? ({
        id: -(activeIdx + 1),
        reportId: 0,
        title: activeSection.title,
        summary: activeSection.summary,
        sortOrder: activeIdx,
        createdAt: new Date(),
        updatedAt: new Date(),
        photos: [],
      } as unknown as Section)
    : undefined;

  return (
    <div className="flex flex-col h-full" data-testid="page-template-edit">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b bg-background sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/reports?tab=templates">
            <Button variant="ghost" size="icon" data-testid="button-back-templates">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">Template editor</p>
            <p className="text-sm font-semibold truncate" data-testid="text-template-header-title">{draftTitle || "Untitled Template"}</p>
          </div>
          {isDirty && (
            <span className="text-xs px-2 py-0.5 rounded-md border" data-testid="badge-template-unsaved">Unsaved</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => saveDraft.mutate()}
            disabled={!isDirty || saveDraft.isPending}
            data-testid="button-save-template"
          >
            <Save className="h-4 w-4 mr-1.5" />
            {saveDraft.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[260px_1fr] min-h-0">
        {/* Section list rail */}
        <aside className="border-b md:border-b-0 md:border-r bg-muted/30 p-3 space-y-2 overflow-y-auto" data-testid="rail-template-sections">
          <button
            onClick={() => requestPaneSwitch({ kind: "cover" })}
            className={`w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-colors ${
              pane.kind === "cover" ? "bg-background border" : "hover:bg-background/60"
            }`}
            data-testid="button-pane-cover"
          >
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Cover Page
            </div>
          </button>
          <div className="space-y-1">
            {draftSections.map((s, i) => (
              <button
                key={s.clientId}
                onClick={() => requestPaneSwitch({ kind: "section", clientId: s.clientId })}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                  pane.kind === "section" && pane.clientId === s.clientId ? "bg-background border" : "hover:bg-background/60"
                }`}
                data-testid={`button-pane-template-section-${i}`}
              >
                <span className="truncate">{i + 1}. {s.title || "Untitled Section"}</span>
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full mt-2"
            onClick={addSection}
            disabled={draftSections.length >= 50}
            data-testid="button-add-template-section"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Section
          </Button>
          {draftSections.length >= 50 && (
            <p className="text-xs text-muted-foreground text-center">Max 50 sections per template.</p>
          )}
        </aside>

        {/* Editor pane */}
        <main className="overflow-y-auto p-4 sm:p-6">
          {pane.kind === "cover" && (
            <CoverEditor
              mode="template"
              title={draftTitle}
              description={draftDescription}
              cover={draftCover}
              coverPhotoUrl={null}
              onTitleChange={(v) => { setDraftTitle(v); markDirty(); }}
              onDescriptionChange={(v) => { setDraftDescription(v); markDirty(); }}
              onCoverChange={(c) => { setDraftCover(c); markDirty(); }}
              onPickCoverPhoto={() => { /* no-op in template mode */ }}
              onClearCoverPhoto={() => { /* no-op in template mode */ }}
            />
          )}
          {pane.kind === "section" && activeSection && syntheticSection && (
            <SectionEditor
              mode="template"
              section={syntheticSection}
              onChange={(updates) => {
                setDraftSections((prev) =>
                  prev.map((s) =>
                    s.clientId === activeSection.clientId
                      ? { ...s, ...(updates.title !== undefined ? { title: updates.title } : {}), ...(updates.summary !== undefined ? { summary: updates.summary } : {}) }
                      : s,
                  ),
                );
                markDirty();
              }}
              onPhotoChange={() => { /* no-op in template mode */ }}
              onAddPhotos={() => { /* no-op in template mode */ }}
              onDeletePhoto={() => { /* no-op in template mode */ }}
              onDeleteSection={() => deleteSection(activeSection.clientId)}
            />
          )}
        </main>
      </div>

      {/* Pane-switch unsaved guard — mirrors report-edit.tsx */}
      <AlertDialog open={!!pendingPane} onOpenChange={(open) => { if (!open) setPendingPane(null); }}>
        <AlertDialogContent data-testid="dialog-template-unsaved-pane-switch">
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved edits in the current pane. Save them before switching, or discard to revert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-template-stay">Stay here</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                lastLoadedTemplateIdRef.current = null;
                setIsDirty(false);
                queryClient.invalidateQueries({ queryKey: ["/api/report-templates", templateId] });
                if (pendingPane) setPane(pendingPane);
                setPendingPane(null);
              }}
              data-testid="button-template-discard"
            >
              Discard
            </Button>
            <AlertDialogAction
              onClick={async () => {
                await saveDraft.mutateAsync();
                if (pendingPane) setPane(pendingPane);
                setPendingPane(null);
              }}
              data-testid="button-template-save-and-switch"
            >
              Save & continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
