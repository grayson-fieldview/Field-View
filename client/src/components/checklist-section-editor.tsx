import { useState, useRef, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, GripVertical, Pencil, Check, X, Camera, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { ChecklistFieldInput, type ChecklistFieldType } from "./checklist-field-input";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { uploadChecklistItemPhotos } from "@/lib/upload-checklist-photos";
import type { ChecklistItem, ChecklistSection, ChecklistItemOption, ChecklistItemPhoto, Media } from "@shared/schema";

interface ChecklistSectionEditorProps {
  checklistId: number;
  projectId: string;
  // Optional: when provided, the editor renders its own header with a Delete
  // button (mirrors report-edit's header pattern). onDeleted is called after
  // the server confirms the delete so the parent can collapse the panel.
  onDeleted?: () => void;
}

// Untitled-section sentinel for items with section_id NULL.
const UNTITLED_SECTION_ID = -1;

export function ChecklistSectionEditor({ checklistId, projectId, onDeleted }: ChecklistSectionEditorProps) {
  const { user } = useAuth() as { user?: { id?: string } };
  const { toast } = useToast();
  const currentUserId = user?.id;
  const [confirmDeleteChecklist, setConfirmDeleteChecklist] = useState(false);

  // Stage 2 — client-side filters. Saved per-checklist in component state
  // (intentionally non-persistent; reset on remount). "showOnlyMine" needs the
  // current user id, so we hide the toggle when we don't have one.
  const [hideCompleted, setHideCompleted] = useState(false);
  const [showOnlyMine, setShowOnlyMine] = useState(false);

  const { data: items = [] } = useQuery<ChecklistItem[]>({
    queryKey: ["/api/checklists", checklistId, "items"],
  });
  const { data: sections = [] } = useQuery<ChecklistSection[]>({
    queryKey: ["/api/checklists", checklistId, "sections"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/checklists", checklistId, "items"] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklists", checklistId, "sections"] });
    queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklists"] });
  };

  const patchItem = useMutation({
    mutationFn: async ({ itemId, patch }: { itemId: number; patch: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/checklist-items/${itemId}`, patch);
      return res.json();
    },
    onSuccess: invalidate,
  });

  const deleteItem = useMutation({
    mutationFn: async (itemId: number) => apiRequest("DELETE", `/api/checklist-items/${itemId}`),
    onSuccess: invalidate,
  });

  const createItem = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("POST", `/api/checklists/${checklistId}/items`, body);
      return res.json();
    },
    onSuccess: invalidate,
  });

  const createSection = useMutation({
    mutationFn: async (title: string) => {
      const res = await apiRequest("POST", `/api/checklists/${checklistId}/sections`, {
        title, sortOrder: sections.length,
      });
      return res.json();
    },
    onSuccess: invalidate,
  });

  const updateSection = useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) => {
      const res = await apiRequest("PATCH", `/api/checklist-sections/${id}`, { title });
      return res.json();
    },
    onSuccess: invalidate,
  });

  const deleteSection = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/checklist-sections/${id}`),
    onSuccess: invalidate,
  });

  const deleteChecklist = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/checklists/${checklistId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      setConfirmDeleteChecklist(false);
      toast({ title: "Checklist deleted" });
      onDeleted?.();
    },
    onError: (e: Error) => {
      toast({ title: "Failed to delete checklist", description: e.message, variant: "destructive" });
    },
  });

  // Apply Stage 2 client-side filters BEFORE grouping so per-section counts
  // reflect only the visible subset. The unfiltered total is still reachable
  // via "X visible / Y total" on the toggle bar.
  const filteredItems = useMemo(() => {
    return items.filter((it) => {
      if (hideCompleted && it.completedAt) return false;
      if (showOnlyMine && currentUserId && it.assignedToUserId !== currentUserId) return false;
      return true;
    });
  }, [items, hideCompleted, showOnlyMine, currentUserId]);

  // Group items by section (Untitled bucket for null sectionId).
  const grouped = new Map<number, ChecklistItem[]>();
  for (const it of filteredItems) {
    const k = it.sectionId ?? UNTITLED_SECTION_ID;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(it);
  }
  Array.from(grouped.values()).forEach((arr: ChecklistItem[]) => arr.sort((a, b) => a.sortOrder - b.sortOrder));

  const sortedSections = [...sections].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  // Render order: untitled bucket first if it has items, then real sections.
  const untitledItems = grouped.get(UNTITLED_SECTION_ID) ?? [];

  // Per-section unfiltered counts so AddItemRow can place new items at the
  // tail of the actual list (not the filtered view).
  const sectionItemTotals = useMemo(() => {
    const m = new Map<number, number>();
    let untitledTotal = 0;
    for (const it of items) {
      if (it.sectionId == null) untitledTotal++;
      else m.set(it.sectionId, (m.get(it.sectionId) ?? 0) + 1);
    }
    return { untitledTotal, perSection: m };
  }, [items]);

  return (
    <div className="space-y-4">
      {onDeleted && (
        <div className="flex items-center justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDeleteChecklist(true)}
            data-testid="button-delete-checklist"
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            Delete
          </Button>
        </div>
      )}

      <FilterBar
        hideCompleted={hideCompleted}
        showOnlyMine={showOnlyMine}
        onToggleHideCompleted={setHideCompleted}
        onToggleShowOnlyMine={setShowOnlyMine}
        visible={filteredItems.length}
        total={items.length}
        canFilterMine={!!currentUserId}
      />

      {(untitledItems.length > 0 || (!hideCompleted && !showOnlyMine && sectionItemTotals.untitledTotal > 0)) && (
        <SectionGroup
          checklistId={checklistId}
          projectId={projectId}
          sectionId={null}
          title="Untitled"
          items={untitledItems}
          onPatchItem={(itemId, patch) => patchItem.mutate({ itemId, patch })}
          onDeleteItem={(itemId, label) => {
            if (!confirm(
              `Delete${label ? ` "${label}"` : " this item"}?\n\nThis removes the item from this checklist only. The template (if any) is not affected.`,
            )) return;
            deleteItem.mutate(itemId);
          }}
          onAddItem={(seed) => createItem.mutate({ ...seed, sortOrder: sectionItemTotals.untitledTotal })}
        />
      )}

      {sortedSections.map((sec) => {
        const sectionItems = grouped.get(sec.id) ?? [];
        return (
          <SectionGroup
            key={sec.id}
            checklistId={checklistId}
            projectId={projectId}
            sectionId={sec.id}
            title={sec.title}
            items={sectionItems}
            onPatchItem={(itemId, patch) => patchItem.mutate({ itemId, patch })}
            onDeleteItem={(itemId, label) => {
            if (!confirm(
              `Delete${label ? ` "${label}"` : " this item"}?\n\nThis removes the item from this checklist only. The template (if any) is not affected.`,
            )) return;
            deleteItem.mutate(itemId);
          }}
            onAddItem={(seed) => createItem.mutate({ ...seed, sectionId: sec.id, sortOrder: sectionItemTotals.perSection.get(sec.id) ?? 0 })}
            onRenameSection={(title) => updateSection.mutate({ id: sec.id, title })}
            onDeleteSection={() => {
              const total = sectionItemTotals.perSection.get(sec.id) ?? 0;
              const tail = "\n\nThis only affects this checklist. The template (if any) is not affected.";
              if (total > 0 && !confirm(`Delete "${sec.title}"? Its ${total} item(s) will move to Untitled.${tail}`)) return;
              if (total === 0 && !confirm(`Delete section "${sec.title}"?${tail}`)) return;
              deleteSection.mutate(sec.id);
            }}
          />
        );
      })}

      <AddSectionRow onAdd={(t) => createSection.mutate(t)} />

      <AlertDialog open={confirmDeleteChecklist} onOpenChange={(open) => { if (!open) setConfirmDeleteChecklist(false); }}>
        <AlertDialogContent data-testid="dialog-confirm-delete-checklist">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete checklist?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the checklist and all its sections, items, and recorded responses.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteChecklist.isPending} data-testid="button-cancel-delete-checklist">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (!deleteChecklist.isPending) deleteChecklist.mutate();
              }}
              disabled={deleteChecklist.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-checklist"
            >
              {deleteChecklist.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FilterBar({
  hideCompleted, showOnlyMine, onToggleHideCompleted, onToggleShowOnlyMine,
  visible, total, canFilterMine,
}: {
  hideCompleted: boolean;
  showOnlyMine: boolean;
  onToggleHideCompleted: (v: boolean) => void;
  onToggleShowOnlyMine: (v: boolean) => void;
  visible: number;
  total: number;
  canFilterMine: boolean;
}) {
  const filtering = hideCompleted || showOnlyMine;
  return (
    <div className="flex items-center gap-3 px-1 py-2 border-b border-border/40" data-testid="checklist-filter-bar">
      <button
        type="button"
        onClick={() => onToggleHideCompleted(!hideCompleted)}
        className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors hover-elevate active-elevate-2 ${
          hideCompleted ? "bg-[#1E1E1E] text-white border-[#1E1E1E]" : "bg-background text-muted-foreground border-border"
        }`}
        data-testid="button-filter-hide-completed"
      >
        Hide completed
      </button>
      {canFilterMine && (
        <button
          type="button"
          onClick={() => onToggleShowOnlyMine(!showOnlyMine)}
          className={`text-xs font-medium px-2.5 py-1 rounded-full border transition-colors hover-elevate active-elevate-2 ${
            showOnlyMine ? "bg-[#1E1E1E] text-white border-[#1E1E1E]" : "bg-background text-muted-foreground border-border"
          }`}
          data-testid="button-filter-show-mine"
        >
          Show only my items
        </button>
      )}
      <span className="ml-auto text-xs text-muted-foreground" data-testid="text-filter-counts">
        {filtering ? `${visible} of ${total}` : `${total} item${total === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}

function SectionGroup({
  checklistId, projectId, sectionId, title, items, onPatchItem, onDeleteItem, onAddItem,
  onRenameSection, onDeleteSection,
}: {
  checklistId: number;
  projectId: string;
  sectionId: number | null;
  title: string;
  items: ChecklistItem[];
  onPatchItem: (itemId: number, patch: Record<string, unknown>) => void;
  onDeleteItem: (itemId: number, label?: string) => void;
  onAddItem: (seed: Record<string, unknown>) => void;
  onRenameSection?: (title: string) => void;
  onDeleteSection?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const isReal = sectionId !== null && onRenameSection && onDeleteSection;

  return (
    <div className="space-y-2" data-testid={`section-group-${sectionId ?? "untitled"}`}>
      <div className="flex items-center gap-2 px-1">
        {isReal && <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50" />}
        {renaming && isReal ? (
          <>
            <Input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className="h-7 text-sm font-semibold"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftTitle.trim()) {
                  onRenameSection!(draftTitle.trim());
                  setRenaming(false);
                } else if (e.key === "Escape") {
                  setDraftTitle(title);
                  setRenaming(false);
                }
              }}
              data-testid={`input-section-title-${sectionId}`}
            />
            <Button size="icon" variant="ghost" className="h-7 w-7"
              onClick={() => { if (draftTitle.trim()) { onRenameSection!(draftTitle.trim()); setRenaming(false); } }}
              data-testid={`button-section-save-${sectionId}`}>
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7"
              onClick={() => { setDraftTitle(title); setRenaming(false); }}
              data-testid={`button-section-cancel-${sectionId}`}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground" data-testid={`text-section-title-${sectionId ?? "untitled"}`}>
              {title}
            </span>
            <span className="text-xs text-muted-foreground/70">·</span>
            <span className="text-xs text-muted-foreground/70">
              {items.filter(i => i.completedAt).length}/{items.length}
            </span>
            {isReal && (
              <div className="ml-auto flex items-center gap-0.5">
                <Button size="icon" variant="ghost" className="h-6 w-6"
                  onClick={() => setRenaming(true)}
                  data-testid={`button-section-rename-${sectionId}`}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive"
                  onClick={onDeleteSection}
                  data-testid={`button-section-delete-${sectionId}`}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="space-y-1.5 pl-1">
        {items.map((it) => (
          <ItemRow
            key={it.id}
            item={it}
            projectId={projectId}
            onPatch={(patch) => onPatchItem(it.id, patch)}
            onDelete={() => onDeleteItem(it.id, it.label)}
          />
        ))}
        <AddItemRow onAdd={onAddItem} />
      </div>
    </div>
  );
}

function ItemRow({
  item, projectId, onPatch, onDelete,
}: {
  item: ChecklistItem;
  projectId: string;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(item.label);
  // Sub-panels start collapsed for non-MC items; MC starts expanded so the
  // user notices they need to author options. Auto-open is also handled in
  // the fieldType Select onValueChange below for the in-session type switch.
  const [optionsOpen, setOptionsOpen] = useState(item.fieldType === "multiple_choice");
  const [photosOpen, setPhotosOpen] = useState(false);

  return (
    <div
      className={`group rounded-md border bg-background p-2.5 ${item.completedAt ? "border-[#267D32]/30 bg-[#267D32]/5" : "border-border"}`}
      data-testid={`checklist-item-${item.id}`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 space-y-2">
          {editingLabel ? (
            <Input
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              autoFocus
              onBlur={() => {
                if (labelDraft.trim() && labelDraft !== item.label) onPatch({ label: labelDraft.trim() });
                setEditingLabel(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (labelDraft.trim() && labelDraft !== item.label) onPatch({ label: labelDraft.trim() });
                  setEditingLabel(false);
                } else if (e.key === "Escape") {
                  setLabelDraft(item.label);
                  setEditingLabel(false);
                }
              }}
              className="h-7 text-sm"
              data-testid={`input-item-label-${item.id}`}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingLabel(true)}
              className="text-left text-sm font-medium hover:underline w-full"
              data-testid={`button-item-label-${item.id}`}
            >
              {item.label}
            </button>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={item.fieldType}
              onValueChange={(v) => {
                onPatch({ fieldType: v });
                if (v === "multiple_choice") setOptionsOpen(true);
              }}
            >
              <SelectTrigger className="h-7 w-32 text-xs" data-testid={`select-fieldtype-${item.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes_no">Yes / No</SelectItem>
                <SelectItem value="rating">Rating</SelectItem>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="multiple_choice">Multiple Choice</SelectItem>
              </SelectContent>
            </Select>

            <ChecklistFieldInput
              fieldType={item.fieldType as ChecklistFieldType}
              valueBool={item.valueBool}
              valueRating={item.valueRating}
              valueText={item.valueText}
              selectedOptionId={item.selectedOptionId}
              itemId={item.id}
              onChangeBool={(v) => onPatch({ valueBool: v })}
              onChangeRating={(v) => onPatch({ valueRating: v })}
              onChangeText={(v) => onPatch({ valueText: v })}
              onChangeOption={(v) => onPatch({ selectedOptionId: v })}
            />
          </div>

          {/* Stage 2 — Photos required toggle. Lives between value field and notes. */}
          <div className="flex items-center gap-2">
            <Switch
              checked={item.photosRequired}
              onCheckedChange={(v) => onPatch({ photosRequired: v })}
              data-testid={`switch-photos-required-${item.id}`}
            />
            <span className="text-xs text-muted-foreground">Photo required to complete</span>
          </div>

          {item.fieldType === "multiple_choice" && (
            <CollapsibleSubPanel
              label="Options"
              open={optionsOpen}
              onToggle={() => setOptionsOpen((o) => !o)}
              testIdSuffix={`options-${item.id}`}
            >
              <OptionsEditor itemId={item.id} />
            </CollapsibleSubPanel>
          )}

          <CollapsibleSubPanel
            label="Photos"
            open={photosOpen}
            onToggle={() => setPhotosOpen((o) => !o)}
            testIdSuffix={`photos-${item.id}`}
          >
            <PhotosPanel itemId={item.id} projectId={projectId} />
          </CollapsibleSubPanel>

          <NotesField item={item} onPatch={onPatch} />
        </div>

        <Button
          size="icon" variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
          onClick={onDelete}
          data-testid={`button-delete-item-${item.id}`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function CollapsibleSubPanel({
  label, open, onToggle, testIdSuffix, children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testIdSuffix: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border/40 pt-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid={`button-toggle-${testIdSuffix}`}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
      </button>
      {open && <div className="pt-2">{children}</div>}
    </div>
  );
}

// ─── Options editor (multiple_choice authoring) ──────────────────────────
function OptionsEditor({ itemId }: { itemId: number }) {
  const [draft, setDraft] = useState("");
  const { data: options = [] } = useQuery<ChecklistItemOption[]>({
    queryKey: ["/api/checklist-items", itemId, "options"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-items", itemId, "options"] });
    // The item itself may flip completion (FK SET NULL on delete), so refresh
    // its parent list too. We don't know the checklist id here — invalidate
    // broadly. Cheap and safe.
    queryClient.invalidateQueries({ queryKey: ["/api/checklists"] });
  };

  const createOption = useMutation({
    mutationFn: async (label: string) => {
      const res = await apiRequest("POST", `/api/checklist-items/${itemId}/options`, {
        label, sortOrder: options.length,
      });
      return res.json();
    },
    onSuccess: () => { setDraft(""); invalidate(); },
  });

  const updateOption = useMutation({
    mutationFn: async ({ id, label }: { id: number; label: string }) => {
      const res = await apiRequest("PATCH", `/api/checklist-options/${id}`, { label });
      return res.json();
    },
    onSuccess: invalidate,
  });

  const deleteOption = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/checklist-options/${id}`),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-1.5" data-testid={`options-editor-${itemId}`}>
      {options.length < 2 && (
        <div className="flex items-center gap-1.5 text-xs text-amber-600" data-testid={`warn-options-min-${itemId}`}>
          <AlertTriangle className="h-3 w-3" />
          Add at least 2 options for a usable answer.
        </div>
      )}
      {options.map((opt) => (
        <OptionRow
          key={opt.id}
          option={opt}
          onRename={(label) => updateOption.mutate({ id: opt.id, label })}
          onDelete={() => deleteOption.mutate(opt.id)}
        />
      ))}
      <div className="flex items-center gap-2">
        <Plus className="h-3 w-3 text-muted-foreground/60" />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) createOption.mutate(draft.trim()); }}
          placeholder="Add option..."
          className="h-7 flex-1 text-xs"
          data-testid={`input-add-option-${itemId}`}
        />
        <Button
          size="sm" variant="ghost"
          onClick={() => { if (draft.trim()) createOption.mutate(draft.trim()); }}
          disabled={!draft.trim() || createOption.isPending}
          data-testid={`button-add-option-${itemId}`}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function OptionRow({
  option, onRename, onDelete,
}: { option: ChecklistItemOption; onRename: (label: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(option.label);
  return (
    <div className="flex items-center gap-2" data-testid={`option-row-${option.id}`}>
      {editing ? (
        <>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            onBlur={() => {
              if (draft.trim() && draft !== option.label) onRename(draft.trim());
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { if (draft.trim() && draft !== option.label) onRename(draft.trim()); setEditing(false); }
              else if (e.key === "Escape") { setDraft(option.label); setEditing(false); }
            }}
            className="h-6 flex-1 text-xs"
            data-testid={`input-option-label-${option.id}`}
          />
        </>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-left text-xs flex-1 hover:underline"
          data-testid={`button-option-label-${option.id}`}
        >
          {option.label}
        </button>
      )}
      <Button
        size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-destructive"
        onClick={() => {
          if (confirm(
            `Delete option "${option.label}"?\n\nThis only affects this checklist. The template (if any) is not affected.`,
          )) onDelete();
        }}
        data-testid={`button-delete-option-${option.id}`}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

// ─── Photos panel (per-item attachments) ──────────────────────────────────
function PhotosPanel({ itemId, projectId }: { itemId: number; projectId: string }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: photos = [] } = useQuery<(ChecklistItemPhoto & { media: Media })[]>({
    queryKey: ["/api/checklist-items", itemId, "photos"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-items", itemId, "photos"] });
    // Photo count flips the photos_required gate, so refresh the parent list.
    queryClient.invalidateQueries({ queryKey: ["/api/checklists"] });
  };

  const detach = useMutation({
    mutationFn: async (joinId: number) => apiRequest("DELETE", `/api/checklist-item-photos/${joinId}`),
    onSuccess: invalidate,
  });

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    try {
      const results = await uploadChecklistItemPhotos(Array.from(fileList), projectId, itemId);
      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;
      invalidate();
      if (fail === 0) {
        toast({ title: "Photos attached", description: `${ok} photo${ok === 1 ? "" : "s"} uploaded.` });
      } else {
        toast({
          title: ok > 0 ? "Partial upload" : "Upload failed",
          description: `${ok} succeeded, ${fail} failed.`,
          variant: ok > 0 ? "default" : "destructive",
        });
      }
    } catch (err: any) {
      // Hard failures (network down, unexpected throw) — the helper itself
      // catches per-file errors, but a top-level throw still needs surfacing.
      toast({
        title: "Upload failed",
        description: err?.message || "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2" data-testid={`photos-panel-${itemId}`}>
      {photos.length > 0 && (
        <div className="grid grid-cols-4 gap-1.5">
          {photos.map((p) => (
            <div key={p.id} className="relative group/photo aspect-square rounded overflow-hidden border border-border" data-testid={`photo-thumb-${p.id}`}>
              <img
                src={p.media.url}
                alt={p.media.originalName ?? "Checklist photo"}
                className="w-full h-full object-cover"
                loading="lazy"
              />
              <button
                type="button"
                onClick={() => { if (confirm("Remove this photo from the checklist item?")) detach.mutate(p.id); }}
                className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover/photo:opacity-100 transition-opacity"
                data-testid={`button-detach-photo-${p.id}`}
                aria-label="Remove photo"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
          data-testid={`input-photo-file-${itemId}`}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="text-xs h-7"
          data-testid={`button-attach-photos-${itemId}`}
        >
          <Camera className="h-3 w-3 mr-1.5" />
          {busy ? "Uploading..." : photos.length === 0 ? "Attach photos" : "Add more"}
        </Button>
      </div>
    </div>
  );
}

// Notes use the same 500ms-debounce-on-blur pattern as the text-field input.
function NotesField({
  item, onPatch,
}: { item: ChecklistItem; onPatch: (p: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(!!item.notes);
  const [local, setLocal] = useState(item.notes ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!open && !item.notes) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground hover:text-foreground"
        data-testid={`button-add-notes-${item.id}`}
      >
        + Add notes
      </button>
    );
  }

  const commit = (v: string) => {
    if ((v ?? "") !== (item.notes ?? "")) onPatch({ notes: v.trim() ? v : null });
  };

  return (
    <Textarea
      value={local}
      onChange={(e) => {
        setLocal(e.target.value);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(e.target.value), 500);
      }}
      onBlur={() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        commit(local);
      }}
      placeholder="Notes..."
      rows={2}
      className="text-xs min-h-[40px] resize-y bg-muted/30"
      data-testid={`textarea-notes-${item.id}`}
    />
  );
}

function AddItemRow({ onAdd }: { onAdd: (seed: Record<string, unknown>) => void }) {
  const [label, setLabel] = useState("");
  const [fieldType, setFieldType] = useState<ChecklistFieldType>("yes_no");

  const submit = () => {
    if (!label.trim()) return;
    onAdd({ label: label.trim(), fieldType });
    setLabel("");
  };

  return (
    <div className="flex items-center gap-2 pt-1">
      <Plus className="h-3.5 w-3.5 text-muted-foreground/60" />
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        placeholder="Add item..."
        className="h-7 flex-1 text-sm"
        data-testid="input-add-item"
      />
      <Select value={fieldType} onValueChange={(v) => setFieldType(v as ChecklistFieldType)}>
        <SelectTrigger className="h-7 w-32 text-xs" data-testid="select-add-fieldtype">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="yes_no">Yes / No</SelectItem>
          <SelectItem value="rating">Rating</SelectItem>
          <SelectItem value="text">Text</SelectItem>
          <SelectItem value="multiple_choice">Multiple Choice</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" variant="ghost" onClick={submit} disabled={!label.trim()} data-testid="button-add-item">
        Add
      </Button>
    </div>
  );
}

function AddSectionRow({ onAdd }: { onAdd: (title: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="text-xs" data-testid="button-add-section">
        <Plus className="h-3.5 w-3.5 mr-1" />
        Add Section
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
        placeholder="Section title..."
        className="h-7 flex-1 text-sm"
        onKeyDown={(e) => {
          if (e.key === "Enter" && title.trim()) { onAdd(title.trim()); setTitle(""); setOpen(false); }
          else if (e.key === "Escape") { setTitle(""); setOpen(false); }
        }}
        data-testid="input-new-section-title"
      />
      <Button size="sm" variant="ghost"
        onClick={() => { if (title.trim()) { onAdd(title.trim()); setTitle(""); setOpen(false); } }}
        disabled={!title.trim()}
        data-testid="button-confirm-section"
      >
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setTitle(""); setOpen(false); }}
        data-testid="button-cancel-section">
        Cancel
      </Button>
    </div>
  );
}
