import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { ArrowLeft, FileText, FileDown, Image as ImageIcon, Loader2, Plus, Save, Trash2 } from "lucide-react";
import type { Media, Report, ReportSection, ReportSectionPhoto } from "@shared/schema";

type Pane = { kind: "cover" } | { kind: "section"; id: number };

type CoverConfig = {
  showCoverPhoto: boolean;
  showCompanyLogo: boolean;
  showCompanyName: boolean;
  showCreatorName: boolean;
  showPhotoCount: boolean;
  showDateCreated: boolean;
  coverPhotoMediaId: number | null;
};

type SectionPhoto = ReportSectionPhoto & { media: Media };
type Section = ReportSection & { photos: SectionPhoto[] };
type ReportTree = Report & { sections: Section[] };

const DEFAULT_COVER: CoverConfig = {
  showCoverPhoto: true,
  showCompanyLogo: true,
  showCompanyName: true,
  showCreatorName: true,
  showPhotoCount: true,
  showDateCreated: true,
  coverPhotoMediaId: null,
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
};

export default function ReportEditPage({ id }: { id: string }) {
  const reportId = parseInt(id);
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: report, isLoading, isError } = useQuery<ReportTree>({
    queryKey: ["/api/reports", reportId],
    enabled: !Number.isNaN(reportId),
  });

  // Local draft state — initialized once per report load.
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftCover, setDraftCover] = useState<CoverConfig>(DEFAULT_COVER);
  const [draftSections, setDraftSections] = useState<Section[]>([]);

  const [pane, setPane] = useState<Pane>({ kind: "cover" });
  const [pendingPane, setPendingPane] = useState<Pane | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [pickerSectionId, setPickerSectionId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [isCoverPickerOpen, setIsCoverPickerOpen] = useState(false);
  const [pickedCoverId, setPickedCoverId] = useState<number | null>(null);
  const [confirmDeleteSection, setConfirmDeleteSection] = useState<number | null>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [confirmDeletePhoto, setConfirmDeletePhoto] = useState<number | null>(null);
  const lastLoadedReportIdRef = useRef<number | null>(null);

  // Initialize draft from server payload exactly once per report id.
  useEffect(() => {
    if (!report) return;
    if (lastLoadedReportIdRef.current === report.id && isDirty) return;
    lastLoadedReportIdRef.current = report.id;
    setDraftTitle(report.title);
    setDraftDescription(report.description ?? "");
    setDraftCover({ ...DEFAULT_COVER, ...((report.coverConfig as Partial<CoverConfig>) ?? {}) });
    setDraftSections(report.sections.map((s) => ({ ...s, photos: [...s.photos] })));
    setIsDirty(false);
  }, [report, isDirty]);

  // Pull project media for the photo picker (and cover photo selection).
  const { data: projectBundle } = useQuery<{ media: Media[] }>({
    queryKey: ["/api/projects", report?.projectId],
    enabled: !!report?.projectId,
  });
  const projectMedia: Media[] = projectBundle?.media ?? [];

  // ─── Unsaved-change guard: beforeunload only (sidebar nav is a known limitation) ─
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

  function requestPaneSwitch(next: Pane) {
    if (samePane(next, pane)) return;
    if (isDirty) {
      setPendingPane(next);
    } else {
      setPane(next);
    }
  }

  function samePane(a: Pane, b: Pane) {
    if (a.kind !== b.kind) return false;
    if (a.kind === "section" && b.kind === "section") return a.id === b.id;
    return true;
  }

  // ─── Mutations ────────────────────────────────────────────────────────────
  const saveDraft = useMutation({
    mutationFn: async () => {
      // Always-PATCH the report. Cheap and idempotent on the server.
      await apiRequest("PATCH", `/api/reports/${reportId}`, {
        title: draftTitle.trim() || "Untitled Report",
        description: draftDescription.trim() ? draftDescription : null,
        coverConfig: draftCover,
      });
      // PATCH each section + photo (also idempotent). Sequential to keep API load predictable.
      for (const s of draftSections) {
        await apiRequest("PATCH", `/api/sections/${s.id}`, {
          title: s.title.trim() || "Untitled Section",
          summary: s.summary?.trim() ? s.summary : null,
        });
        for (const p of s.photos) {
          await apiRequest("PATCH", `/api/section-photos/${p.id}`, {
            caption: p.caption?.trim() ? p.caption : null,
            description: p.description?.trim() ? p.description : null,
          });
        }
      }
    },
    onSuccess: () => {
      setIsDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/reports", reportId] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports"] });
      toast({ title: "Draft saved" });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const addSection = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/reports/${reportId}/sections`, {
        title: "New Section",
        summary: null,
      });
      return res.json() as Promise<ReportSection>;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports", reportId] });
      setDraftSections((prev) => [...prev, { ...created, photos: [] }]);
      setPane({ kind: "section", id: created.id });
      toast({ title: "Section added" });
    },
    onError: (e: Error) => toast({ title: "Failed to add section", description: e.message, variant: "destructive" }),
  });

  const deleteSection = useMutation({
    mutationFn: async (sectionId: number) => {
      await apiRequest("DELETE", `/api/sections/${sectionId}`);
    },
    onSuccess: (_d, sectionId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports", reportId] });
      setDraftSections((prev) => prev.filter((s) => s.id !== sectionId));
      if (pane.kind === "section" && pane.id === sectionId) setPane({ kind: "cover" });
      toast({ title: "Section deleted" });
    },
    onError: (e: Error) => toast({ title: "Failed to delete section", description: e.message, variant: "destructive" }),
  });

  const addPhotos = useMutation({
    mutationFn: async ({ sectionId, mediaIds }: { sectionId: number; mediaIds: number[] }) => {
      await apiRequest("POST", `/api/sections/${sectionId}/photos`, { mediaIds });
      // Refetch the full tree so we get the new photos joined with media (presigned URLs).
      await queryClient.invalidateQueries({ queryKey: ["/api/reports", reportId] });
      const fresh = await queryClient.fetchQuery<ReportTree>({ queryKey: ["/api/reports", reportId] });
      return fresh;
    },
    onSuccess: (fresh) => {
      // Surgically merge the active section's fresh photos into the draft so
      // we don't clobber unsaved title/summary/caption edits in other sections.
      if (fresh) {
        setDraftSections((prev) =>
          prev.map((s) => {
            const f = fresh.sections.find((fs) => fs.id === s.id);
            return f ? { ...s, photos: f.photos } : s;
          }),
        );
      }
      setIsPickerOpen(false);
      setPicked(new Set());
      setPickerSectionId(null);
      toast({ title: "Photos added" });
    },
    onError: (e: Error) => toast({ title: "Failed to add photos", description: e.message, variant: "destructive" }),
  });

  const deletePhoto = useMutation({
    mutationFn: async (photoId: number) => {
      await apiRequest("DELETE", `/api/section-photos/${photoId}`);
    },
    onSuccess: (_d, photoId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports", reportId] });
      setDraftSections((prev) =>
        prev.map((s) => ({ ...s, photos: s.photos.filter((p) => p.id !== photoId) })),
      );
      toast({ title: "Photo removed" });
    },
    onError: (e: Error) => toast({ title: "Failed to remove photo", description: e.message, variant: "destructive" }),
  });

  const deleteReport = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/reports/${reportId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports"] });
      navigate("/reports");
    },
    onError: (e: Error) => toast({ title: "Failed to delete report", description: e.message, variant: "destructive" }),
  });

  // ─── Render ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (isError || !report) {
    return (
      <div className="p-12 text-center" data-testid="text-report-not-found">
        <p className="text-sm text-muted-foreground">Report not found or you don't have access.</p>
        <Link href="/reports"><Button variant="outline" className="mt-4" data-testid="button-back-to-reports">Back to reports</Button></Link>
      </div>
    );
  }

  const activeSection = pane.kind === "section" ? draftSections.find((s) => s.id === pane.id) : undefined;

  return (
    <div className="flex flex-col h-full" data-testid="page-report-edit">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b bg-background sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link href={`/projects/${report.projectId}`}>
            <Button variant="ghost" size="icon" data-testid="button-back-project">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">Report editor</p>
            <p className="text-sm font-semibold truncate" data-testid="text-report-header-title">{draftTitle || "Untitled Report"}</p>
          </div>
          <Badge variant="secondary" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid="badge-report-status">
            {STATUS_LABEL[report.status] ?? report.status}
          </Badge>
          {isDirty && (
            <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid="badge-unsaved">
              Unsaved
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteSection(-1)} data-testid="button-delete-report">
            <Trash2 className="h-4 w-4 mr-1.5" />
            Delete
          </Button>
          <Button onClick={() => saveDraft.mutate()} disabled={!isDirty || saveDraft.isPending} data-testid="button-save-draft">
            <Save className="h-4 w-4 mr-1.5" />
            {saveDraft.isPending ? "Saving..." : "Save Draft"}
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              setIsGeneratingPdf(true);
              try {
                if (isDirty) {
                  try {
                    await saveDraft.mutateAsync();
                  } catch {
                    // saveDraft.onError already surfaced a "Save failed" toast.
                    setIsGeneratingPdf(false);
                    return;
                  }
                }
                const res = await fetch(`/api/reports/${reportId}/pdf`, {
                  method: "POST",
                  credentials: "include",
                });
                if (!res.ok) {
                  const body = await res.json().catch(() => ({ message: "PDF generation failed" }));
                  throw new Error(body.message || "PDF generation failed");
                }
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const slug = (draftTitle || "report")
                  .replace(/[^a-z0-9]+/gi, "-")
                  .toLowerCase()
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 50) || "report";
                const dateStr = new Date().toISOString().slice(0, 10);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${slug}-${dateStr}.pdf`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } catch (e) {
                toast({
                  title: "Couldn't generate PDF",
                  description: (e as Error).message,
                  variant: "destructive",
                });
              } finally {
                setIsGeneratingPdf(false);
              }
            }}
            disabled={isGeneratingPdf || saveDraft.isPending}
            data-testid="button-generate-pdf"
          >
            {isGeneratingPdf ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <FileDown className="h-4 w-4 mr-1.5" />
            )}
            {isGeneratingPdf ? "Generating..." : "Generate PDF"}
          </Button>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[260px_1fr] min-h-0">
        {/* Section list rail */}
        <aside className="border-b md:border-b-0 md:border-r bg-muted/30 p-3 space-y-2 overflow-y-auto" data-testid="rail-sections">
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
                key={s.id}
                onClick={() => requestPaneSwitch({ kind: "section", id: s.id })}
                className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                  pane.kind === "section" && pane.id === s.id ? "bg-background border" : "hover:bg-background/60"
                }`}
                data-testid={`button-pane-section-${s.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{i + 1}. {s.title || "Untitled Section"}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{s.photos.length}</span>
                </div>
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full mt-2"
            onClick={() => addSection.mutate()}
            disabled={addSection.isPending}
            data-testid="button-add-section"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            Add Section
          </Button>
        </aside>

        {/* Editor pane */}
        <main className="overflow-y-auto p-4 sm:p-6">
          {pane.kind === "cover" && (
            <CoverEditor
              title={draftTitle}
              description={draftDescription}
              cover={draftCover}
              coverPhotoUrl={
                draftCover.coverPhotoMediaId
                  ? projectMedia.find((m) => m.id === draftCover.coverPhotoMediaId)?.url ?? null
                  : null
              }
              onTitleChange={(v) => { setDraftTitle(v); markDirty(); }}
              onDescriptionChange={(v) => { setDraftDescription(v); markDirty(); }}
              onCoverChange={(c) => { setDraftCover(c); markDirty(); }}
              onPickCoverPhoto={() => {
                setPickedCoverId(draftCover.coverPhotoMediaId);
                setIsCoverPickerOpen(true);
              }}
              onClearCoverPhoto={() => {
                setDraftCover({ ...draftCover, coverPhotoMediaId: null });
                markDirty();
              }}
            />
          )}
          {pane.kind === "section" && activeSection && (
            <SectionEditor
              section={activeSection}
              onChange={(updates) => {
                setDraftSections((prev) => prev.map((s) => (s.id === activeSection.id ? { ...s, ...updates } : s)));
                markDirty();
              }}
              onPhotoChange={(photoId, updates) => {
                setDraftSections((prev) =>
                  prev.map((s) =>
                    s.id !== activeSection.id
                      ? s
                      : { ...s, photos: s.photos.map((p) => (p.id === photoId ? { ...p, ...updates } : p)) },
                  ),
                );
                markDirty();
              }}
              onAddPhotos={() => {
                setPickerSectionId(activeSection.id);
                setPicked(new Set());
                setIsPickerOpen(true);
              }}
              onDeletePhoto={(photoId) => setConfirmDeletePhoto(photoId)}
              onDeleteSection={() => setConfirmDeleteSection(activeSection.id)}
            />
          )}
        </main>
      </div>

      {/* Pane-switch unsaved guard */}
      <AlertDialog open={!!pendingPane} onOpenChange={(open) => { if (!open) setPendingPane(null); }}>
        <AlertDialogContent data-testid="dialog-unsaved-pane-switch">
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved edits in the current pane. Save them before switching, or discard to revert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-stay">Stay here</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                lastLoadedReportIdRef.current = null;
                setIsDirty(false);
                queryClient.invalidateQueries({ queryKey: ["/api/reports", reportId] });
                if (pendingPane) setPane(pendingPane);
                setPendingPane(null);
              }}
              data-testid="button-discard"
            >
              Discard
            </Button>
            <AlertDialogAction
              onClick={async () => {
                await saveDraft.mutateAsync();
                if (pendingPane) setPane(pendingPane);
                setPendingPane(null);
              }}
              data-testid="button-save-and-switch"
            >
              Save & continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Section delete confirm — value -1 means delete-the-whole-report */}
      <AlertDialog open={confirmDeleteSection !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteSection(null); }}>
        <AlertDialogContent data-testid="dialog-confirm-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmDeleteSection === -1 ? "Delete report?" : "Delete section?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeleteSection === -1
                ? "This will permanently remove the report and all its sections and photos."
                : "This will permanently remove the section and its photos from the report."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeleteSection === -1) {
                  deleteReport.mutate();
                } else if (confirmDeleteSection !== null) {
                  deleteSection.mutate(confirmDeleteSection);
                }
                setConfirmDeleteSection(null);
              }}
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Photo delete confirm */}
      <AlertDialog open={confirmDeletePhoto !== null} onOpenChange={(open) => { if (!open) setConfirmDeletePhoto(null); }}>
        <AlertDialogContent data-testid="dialog-confirm-delete-photo">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove photo?</AlertDialogTitle>
            <AlertDialogDescription>The photo will be removed from this section. The original media is not deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-photo">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeletePhoto !== null) deletePhoto.mutate(confirmDeletePhoto);
                setConfirmDeletePhoto(null);
              }}
              data-testid="button-confirm-delete-photo"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Photo picker */}
      <Dialog open={isPickerOpen} onOpenChange={setIsPickerOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col" data-testid="dialog-photo-picker">
          <DialogHeader>
            <DialogTitle>Add photos from project</DialogTitle>
            <DialogDescription>Select photos from this project's media library to add to the section.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto -mx-6 px-6">
            {projectMedia.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">This project has no photos yet.</p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {projectMedia.map((m) => {
                  const checked = picked.has(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        const next = new Set(picked);
                        if (checked) next.delete(m.id); else next.add(m.id);
                        setPicked(next);
                      }}
                      className={`relative aspect-square rounded-md overflow-hidden border-2 transition-colors ${
                        checked ? "border-primary" : "border-transparent"
                      }`}
                      data-testid={`button-pick-media-${m.id}`}
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsPickerOpen(false)} data-testid="button-cancel-picker">Cancel</Button>
            <Button
              onClick={() => {
                if (pickerSectionId !== null && picked.size > 0) {
                  addPhotos.mutate({ sectionId: pickerSectionId, mediaIds: Array.from(picked) });
                }
              }}
              disabled={picked.size === 0 || addPhotos.isPending}
              data-testid="button-confirm-picker"
            >
              {addPhotos.isPending ? "Adding..." : `Add ${picked.size} photo${picked.size === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cover photo picker (single-select) */}
      <Dialog open={isCoverPickerOpen} onOpenChange={setIsCoverPickerOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col" data-testid="dialog-cover-photo-picker">
          <DialogHeader>
            <DialogTitle>Choose cover photo</DialogTitle>
            <DialogDescription>Pick one photo from this project to use as the report's cover image.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto -mx-6 px-6">
            {projectMedia.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">This project has no photos yet.</p>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {projectMedia.map((m) => {
                  const checked = pickedCoverId === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setPickedCoverId(m.id)}
                      className={`relative aspect-square rounded-md overflow-hidden border-2 transition-colors ${
                        checked ? "border-primary" : "border-transparent"
                      }`}
                      data-testid={`button-pick-cover-${m.id}`}
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
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsCoverPickerOpen(false)}
              data-testid="button-cancel-cover-picker"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pickedCoverId !== null) {
                  setDraftCover({ ...draftCover, coverPhotoMediaId: pickedCoverId });
                  markDirty();
                }
                setIsCoverPickerOpen(false);
              }}
              disabled={pickedCoverId === null}
              data-testid="button-confirm-cover-picker"
            >
              Use this photo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Cover editor ────────────────────────────────────────────────────────────
function CoverEditor(props: {
  title: string;
  description: string;
  cover: CoverConfig;
  coverPhotoUrl: string | null;
  onTitleChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onCoverChange: (c: CoverConfig) => void;
  onPickCoverPhoto: () => void;
  onClearCoverPhoto: () => void;
}) {
  const {
    title,
    description,
    cover,
    coverPhotoUrl,
    onTitleChange,
    onDescriptionChange,
    onCoverChange,
    onPickCoverPhoto,
    onClearCoverPhoto,
  } = props;
  const toggles: { key: keyof CoverConfig; label: string }[] = useMemo(() => [
    { key: "showCoverPhoto", label: "Cover photo" },
    { key: "showCompanyLogo", label: "Company logo" },
    { key: "showCompanyName", label: "Company name" },
    { key: "showCreatorName", label: "Created by name" },
    { key: "showPhotoCount", label: "Photo count" },
    { key: "showDateCreated", label: "Date created" },
  ], []);

  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid="pane-cover">
      <div>
        <h2 className="text-lg font-semibold mb-1">Cover Page</h2>
        <p className="text-sm text-muted-foreground">Title and description always render. Toggle which optional fields appear.</p>
      </div>

      <Card className="p-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="cover-title">Title</Label>
          <Input
            id="cover-title"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="Untitled Report"
            data-testid="input-report-title"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cover-description">Description</Label>
          <Textarea
            id="cover-description"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Add a short description of this report (optional)..."
            className="min-h-[100px]"
            data-testid="input-report-description"
          />
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <h3 className="text-sm font-semibold">Show on cover</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {toggles.map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between gap-3 p-3 rounded-md border">
              <Label htmlFor={`toggle-${key}`} className="text-sm font-normal cursor-pointer">{label}</Label>
              <Switch
                id={`toggle-${key}`}
                checked={Boolean(cover[key])}
                onCheckedChange={(checked) => onCoverChange({ ...cover, [key]: checked })}
                data-testid={`switch-${key}`}
              />
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-4 space-y-3" data-testid="card-cover-photo-override">
        <h3 className="text-sm font-semibold">Cover Photo</h3>
        {cover.coverPhotoMediaId && coverPhotoUrl ? (
          <div className="flex items-center gap-3">
            <img
              src={coverPhotoUrl}
              alt="Selected cover"
              className="h-20 w-20 rounded object-cover border"
              data-testid="img-cover-override-thumb"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onPickCoverPhoto}
                data-testid="button-change-cover-photo"
              >
                Change
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearCoverPhoto}
                data-testid="button-clear-cover-photo"
              >
                Use project default
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground flex-1">
              Will use project default cover photo.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onPickCoverPhoto}
              data-testid="button-choose-cover-photo"
            >
              <ImageIcon className="h-4 w-4 mr-1.5" />
              Choose cover photo
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Section editor ──────────────────────────────────────────────────────────
function SectionEditor(props: {
  section: Section;
  onChange: (updates: Partial<Section>) => void;
  onPhotoChange: (photoId: number, updates: Partial<SectionPhoto>) => void;
  onAddPhotos: () => void;
  onDeletePhoto: (photoId: number) => void;
  onDeleteSection: () => void;
}) {
  const { section, onChange, onPhotoChange, onAddPhotos, onDeletePhoto, onDeleteSection } = props;
  return (
    <div className="max-w-3xl mx-auto space-y-6" data-testid={`pane-section-${section.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold mb-1">Section</h2>
          <p className="text-sm text-muted-foreground">Title, summary, and photos with optional captions.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDeleteSection} data-testid="button-delete-section">
          <Trash2 className="h-4 w-4 mr-1.5" />
          Delete section
        </Button>
      </div>

      <Card className="p-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="section-title">Title</Label>
          <Input
            id="section-title"
            value={section.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder="Untitled Section"
            data-testid="input-section-title"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="section-summary">Summary</Label>
          <Textarea
            id="section-summary"
            value={section.summary ?? ""}
            onChange={(e) => onChange({ summary: e.target.value })}
            placeholder="Optional context for this section..."
            className="min-h-[100px]"
            data-testid="input-section-summary"
          />
        </div>
      </Card>

      <Card className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Photos ({section.photos.length})</h3>
          <Button variant="outline" size="sm" onClick={onAddPhotos} data-testid="button-add-photos">
            <Plus className="h-4 w-4 mr-1.5" />
            Add photos
          </Button>
        </div>
        {section.photos.length === 0 ? (
          <div className="text-center py-8 border-2 border-dashed rounded-md">
            <ImageIcon className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No photos in this section yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {section.photos.map((p) => (
              <div key={p.id} className="flex gap-3 p-3 rounded-md border" data-testid={`row-section-photo-${p.id}`}>
                <img src={p.media.url} alt="" className="h-24 w-24 object-cover rounded-md shrink-0" />
                <div className="flex-1 min-w-0 space-y-2">
                  <Input
                    value={p.caption ?? ""}
                    placeholder="Caption (optional)"
                    onChange={(e) => onPhotoChange(p.id, { caption: e.target.value })}
                    data-testid={`input-photo-caption-${p.id}`}
                  />
                  <Textarea
                    value={p.description ?? ""}
                    placeholder="Description (optional)"
                    onChange={(e) => onPhotoChange(p.id, { description: e.target.value })}
                    className="min-h-[60px]"
                    data-testid={`input-photo-description-${p.id}`}
                  />
                </div>
                <Button variant="ghost" size="icon" onClick={() => onDeletePhoto(p.id)} data-testid={`button-delete-photo-${p.id}`}>
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
