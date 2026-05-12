import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, LayoutTemplate, Plus } from "lucide-react";
import { TemplateSectionEditor } from "@/components/template-section-editor";
import type {
  ChecklistTemplate,
  ChecklistTemplateItem,
  ChecklistTemplateSection,
} from "@shared/schema";

const UNTITLED_KEY = -1;

export default function ChecklistTemplateEditPage({ id }: { id: string }) {
  const templateId = parseInt(id);
  const { toast } = useToast();

  const { data: template, isLoading: tplLoading, isError } = useQuery<ChecklistTemplate>({
    queryKey: ["/api/checklist-templates", templateId],
    enabled: !Number.isNaN(templateId),
  });

  const { data: sections = [], isLoading: secLoading } = useQuery<ChecklistTemplateSection[]>({
    queryKey: ["/api/checklist-templates", templateId, "sections"],
    enabled: !Number.isNaN(templateId),
  });

  const { data: items = [], isLoading: itemsLoading } = useQuery<ChecklistTemplateItem[]>({
    queryKey: ["/api/checklist-templates", templateId, "items"],
    enabled: !Number.isNaN(templateId),
  });

  // ── Inline title/description ─────────────────────────────────────────────
  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const titleSyncedRef = useRef<number | null>(null);
  useEffect(() => {
    if (template && titleSyncedRef.current !== template.id) {
      titleSyncedRef.current = template.id;
      setTitleDraft(template.title);
      setDescDraft(template.description ?? "");
    }
  }, [template]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates", templateId] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates", templateId, "sections"] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates", templateId, "items"] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates"] });
  };

  const patchTemplate = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/checklist-templates/${templateId}`, body);
      return res.json();
    },
    onSuccess: invalidateAll,
    onError: (e: Error) =>
      toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const createSection = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/checklist-templates/${templateId}/sections`, {
        title: "New Section",
        sortOrder: sections.length,
      });
      return res.json();
    },
    onSuccess: invalidateAll,
  });

  const reorderSections = useMutation({
    mutationFn: async (orderedIds: number[]) =>
      apiRequest("POST", `/api/checklist-templates/${templateId}/sections/reorder`, { orderedIds }),
    onSuccess: invalidateAll,
  });

  const reorderItems = useMutation({
    mutationFn: async (orderedIds: number[]) =>
      apiRequest("POST", `/api/checklist-templates/${templateId}/items/reorder`, { orderedIds }),
    onSuccess: invalidateAll,
  });

  // ── Group items by section ───────────────────────────────────────────────
  const grouped = useMemo(() => {
    const m = new Map<number, ChecklistTemplateItem[]>();
    for (const it of items) {
      const k = it.sectionId ?? UNTITLED_KEY;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(it);
    }
    Array.from(m.values()).forEach((arr) =>
      arr.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    );
    return m;
  }, [items]);

  const sortedSections = useMemo(
    () => [...sections].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [sections],
  );

  const moveSection = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= sortedSections.length) return;
    const next = [...sortedSections];
    [next[idx], next[target]] = [next[target], next[idx]];
    reorderSections.mutate(next.map((s) => s.id));
  };

  const moveItemWithinSection = (sectionKey: number, itemId: number, dir: -1 | 1) => {
    // The /items/reorder endpoint reassigns sortOrder = 0..N-1 for *only* the
    // IDs it receives, leaving other items untouched. Sending a section subset
    // would collide with items in other sections (multiple items at sortOrder 0
    // etc.). To stay correct, build the FULL globally-ordered list of every
    // item in the template, swap the two adjacent items inside their section,
    // and post the full list so every row gets a unique, monotonic sortOrder.
    const list = grouped.get(sectionKey) ?? [];
    const localIdx = list.findIndex((it) => it.id === itemId);
    if (localIdx < 0) return;
    const localTarget = localIdx + dir;
    if (localTarget < 0 || localTarget >= list.length) return;

    const fullOrder: ChecklistTemplateItem[] = [];
    // Untitled bucket first (matches render order on the page).
    if (sectionKey === UNTITLED_KEY) {
      const swapped = [...list];
      [swapped[localIdx], swapped[localTarget]] = [swapped[localTarget], swapped[localIdx]];
      fullOrder.push(...swapped);
    } else {
      fullOrder.push(...(grouped.get(UNTITLED_KEY) ?? []));
    }
    for (const sec of sortedSections) {
      const secList = grouped.get(sec.id) ?? [];
      if (sec.id === sectionKey) {
        const swapped = [...secList];
        [swapped[localIdx], swapped[localTarget]] = [swapped[localTarget], swapped[localIdx]];
        fullOrder.push(...swapped);
      } else {
        fullOrder.push(...secList);
      }
    }
    reorderItems.mutate(fullOrder.map((it) => it.id));
  };

  // ── Loading / error ──────────────────────────────────────────────────────
  if (Number.isNaN(templateId)) {
    return (
      <div className="p-12 text-center" data-testid="text-template-bad-id">
        <p className="text-sm text-muted-foreground">Invalid template id.</p>
      </div>
    );
  }

  if (tplLoading || secLoading || itemsLoading) {
    return (
      <div className="p-6 space-y-4 max-w-4xl mx-auto">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !template) {
    return (
      <div className="p-12 text-center" data-testid="text-checklist-template-not-found">
        <p className="text-sm text-muted-foreground">Template not found or you don't have access.</p>
        <Link href="/checklists?tab=templates">
          <Button variant="outline" className="mt-4" data-testid="button-back-to-checklists">
            Back to Checklists
          </Button>
        </Link>
      </div>
    );
  }

  const untitledItems = grouped.get(UNTITLED_KEY) ?? [];

  return (
    <div className="flex flex-col h-full" data-testid="page-checklist-template-edit">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b bg-background sticky top-0 z-10">
        <Link href="/checklists?tab=templates">
          <Button variant="ghost" size="sm" data-testid="button-back-templates">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to Checklists
          </Button>
        </Link>
        <div className="ml-auto text-xs text-muted-foreground">
          {patchTemplate.isPending ? "Saving..." : "Saved"}
        </div>
      </div>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Surface banner — makes it unmistakable that this is the template
              editor, not a per-project checklist. Uses Field View orange as a
              left border + tinted background so a glance is enough. */}
          <div
            className="flex items-start gap-3 rounded-md border border-l-4 bg-orange-50/70 dark:bg-orange-950/20 px-4 py-3"
            style={{ borderLeftColor: "#f09004" }}
            data-testid="banner-template-editor"
          >
            <LayoutTemplate
              className="h-5 w-5 mt-0.5 shrink-0"
              style={{ color: "#f09004" }}
              aria-hidden
            />
            <div className="text-sm">
              <div className="font-semibold text-foreground" data-testid="text-banner-template-title">
                Editing template: {template.title}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Changes here update the template only. They do not affect checklists already created from this template.
              </div>
            </div>
          </div>

          {/* Title + description */}
          <div className="space-y-2">
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const trimmed = titleDraft.trim();
                if (trimmed && trimmed !== template.title) patchTemplate.mutate({ title: trimmed });
                else setTitleDraft(template.title);
              }}
              placeholder="Template title"
              className="text-2xl font-bold tracking-tight border-none px-0 shadow-none focus-visible:ring-0 h-auto py-1"
              data-testid="input-template-title"
            />
            <Textarea
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              onBlur={() => {
                const next = descDraft.trim() ? descDraft : null;
                if ((next ?? "") !== (template.description ?? "")) {
                  patchTemplate.mutate({ description: next });
                }
              }}
              placeholder="Optional description..."
              rows={2}
              className="text-sm border-none px-0 shadow-none focus-visible:ring-0 resize-none bg-transparent"
              data-testid="textarea-template-description"
            />
          </div>

          {/* Untitled bucket — only when it has items */}
          {untitledItems.length > 0 && (
            <TemplateSectionEditor
              templateId={templateId}
              section={null}
              items={untitledItems}
              itemTotal={untitledItems.length}
              canMoveUp={false}
              canMoveDown={false}
              onMoveItem={(itemId, dir) => moveItemWithinSection(UNTITLED_KEY, itemId, dir)}
            />
          )}

          {/* Real sections */}
          {sortedSections.map((sec, idx) => {
            const sectionItems = grouped.get(sec.id) ?? [];
            return (
              <TemplateSectionEditor
                key={sec.id}
                templateId={templateId}
                section={sec}
                items={sectionItems}
                itemTotal={sectionItems.length}
                canMoveUp={idx > 0}
                canMoveDown={idx < sortedSections.length - 1}
                onMoveSectionUp={() => moveSection(idx, -1)}
                onMoveSectionDown={() => moveSection(idx, 1)}
                onMoveItem={(itemId, dir) => moveItemWithinSection(sec.id, itemId, dir)}
              />
            );
          })}

          {/* Empty-state hint when nothing exists at all */}
          {sortedSections.length === 0 && untitledItems.length === 0 && (
            <div
              className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground"
              data-testid="text-template-empty"
            >
              This template is empty. Add a section below, or add an item to start.
            </div>
          )}

          {/* Add-section button */}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => createSection.mutate()}
            disabled={createSection.isPending}
            data-testid="button-add-template-section"
          >
            <Plus className="h-4 w-4 mr-1.5" />
            {createSection.isPending ? "Adding..." : "Add Section"}
          </Button>
        </div>
      </main>
    </div>
  );
}
