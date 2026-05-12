import { useEffect, useRef, useState } from "react";
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
import {
  Plus, Trash2, GripVertical, ChevronDown, ChevronRight,
  AlertTriangle, ChevronUp, ArrowDown, ArrowUp,
} from "lucide-react";
import type { ChecklistTemplateItem, ChecklistTemplateItemOption } from "@shared/schema";

export type TemplateFieldType = "yes_no" | "rating" | "text" | "multiple_choice";

export interface TemplateItemEditorProps {
  templateId: number;
  item: ChecklistTemplateItem;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

/**
 * Editor for a single template item. Mirrors the per-project ItemRow:
 * inline label, field-type select, photos-required toggle, collapsible
 * options panel for multiple_choice, collapsible notes. Reorder uses
 * arrow buttons (no DnD library installed in the per-project editor —
 * matching that decision rather than introducing a new dependency).
 */
export function TemplateItemEditor({
  templateId, item, canMoveUp, canMoveDown, onMoveUp, onMoveDown,
}: TemplateItemEditorProps) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(item.label);
  const [optionsOpen, setOptionsOpen] = useState(item.fieldType === "multiple_choice");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Keep local draft in sync if the canonical label changes (e.g. another
  // tab editing). Only when not actively editing.
  useEffect(() => {
    if (!editingLabel) setLabelDraft(item.label);
  }, [item.label, editingLabel]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates", templateId, "items"] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates"] });
  };

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/checklist-template-items/${item.id}`, body);
      return res.json();
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/checklist-template-items/${item.id}`),
    onSuccess: () => { setConfirmDelete(false); invalidate(); },
  });

  const commitLabel = () => {
    const trimmed = labelDraft.trim();
    if (trimmed && trimmed !== item.label) patch.mutate({ label: trimmed });
    else setLabelDraft(item.label);
    setEditingLabel(false);
  };

  return (
    <div
      className="group rounded-md border border-border bg-background p-2.5"
      data-testid={`template-item-${item.id}`}
    >
      <div className="flex items-start gap-2">
        <div className="flex flex-col items-center gap-0.5 pt-0.5">
          <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50" />
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          {editingLabel ? (
            <Input
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              autoFocus
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitLabel();
                else if (e.key === "Escape") { setLabelDraft(item.label); setEditingLabel(false); }
              }}
              className="h-7 text-sm"
              data-testid={`input-template-item-label-${item.id}`}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingLabel(true)}
              className="text-left text-sm font-medium hover:underline w-full"
              data-testid={`button-template-item-label-${item.id}`}
            >
              {item.label}
            </button>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={item.fieldType}
              onValueChange={(v) => {
                patch.mutate({ fieldType: v });
                if (v === "multiple_choice") setOptionsOpen(true);
              }}
            >
              <SelectTrigger className="h-7 w-36 text-xs" data-testid={`select-template-fieldtype-${item.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes_no">Yes / No</SelectItem>
                <SelectItem value="rating">Rating</SelectItem>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="multiple_choice">Multiple Choice</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2 ml-auto">
              <Switch
                checked={item.photosRequired}
                onCheckedChange={(v) => patch.mutate({ photosRequired: v })}
                data-testid={`switch-template-photos-required-${item.id}`}
              />
              <span className="text-xs text-muted-foreground">Photo required</span>
            </div>
          </div>

          {item.fieldType === "multiple_choice" && (
            <CollapsibleSubPanel
              label="Options"
              open={optionsOpen}
              onToggle={() => setOptionsOpen((o) => !o)}
              testIdSuffix={`template-options-${item.id}`}
            >
              <TemplateOptionsEditor itemId={item.id} />
            </CollapsibleSubPanel>
          )}

          <NotesField item={item} onPatch={(p) => patch.mutate(p)} />
        </div>

        <div className="flex flex-col gap-0.5">
          <Button
            size="icon" variant="ghost" className="h-6 w-6"
            disabled={!canMoveUp}
            onClick={onMoveUp}
            data-testid={`button-template-item-up-${item.id}`}
            aria-label="Move up"
          >
            <ArrowUp className="h-3 w-3" />
          </Button>
          <Button
            size="icon" variant="ghost" className="h-6 w-6"
            disabled={!canMoveDown}
            onClick={onMoveDown}
            data-testid={`button-template-item-down-${item.id}`}
            aria-label="Move down"
          >
            <ArrowDown className="h-3 w-3" />
          </Button>
          <Button
            size="icon" variant="ghost"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            data-testid={`button-template-item-delete-${item.id}`}
            aria-label="Delete item"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent data-testid={`dialog-template-item-delete-${item.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this item?</AlertDialogTitle>
            <AlertDialogDescription>
              "{item.label}" will be removed from the template. Existing
              project checklists already created from this template won't
              be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-template-item-delete-cancel-${item.id}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => remove.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-template-item-delete-confirm-${item.id}`}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

// ─── Options editor (template-level multiple_choice authoring) ─────────────
function TemplateOptionsEditor({ itemId }: { itemId: number }) {
  const [draft, setDraft] = useState("");
  const { data: options = [] } = useQuery<ChecklistTemplateItemOption[]>({
    queryKey: ["/api/checklist-template-items", itemId, "options"],
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-template-items", itemId, "options"] });
  };

  const createOption = useMutation({
    mutationFn: async (label: string) => {
      const res = await apiRequest("POST", `/api/checklist-template-items/${itemId}/options`, {
        label, sortOrder: options.length,
      });
      return res.json();
    },
    onSuccess: () => { setDraft(""); invalidate(); },
  });

  const updateOption = useMutation({
    mutationFn: async ({ id, label }: { id: number; label: string }) => {
      const res = await apiRequest("PATCH", `/api/checklist-template-options/${id}`, { label });
      return res.json();
    },
    onSuccess: invalidate,
  });

  const deleteOption = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/checklist-template-options/${id}`),
    onSuccess: invalidate,
  });

  const reorder = useMutation({
    mutationFn: async (orderedIds: number[]) =>
      apiRequest("POST", `/api/checklist-template-items/${itemId}/options/reorder`, { orderedIds }),
    onSuccess: invalidate,
  });

  const sorted = [...options].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const moveOption = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= sorted.length) return;
    const nextOrder = [...sorted];
    [nextOrder[idx], nextOrder[target]] = [nextOrder[target], nextOrder[idx]];
    reorder.mutate(nextOrder.map((o) => o.id));
  };

  return (
    <div className="space-y-1.5" data-testid={`template-options-editor-${itemId}`}>
      {sorted.length < 2 && (
        <div className="flex items-center gap-1.5 text-xs text-amber-600" data-testid={`warn-template-options-min-${itemId}`}>
          <AlertTriangle className="h-3 w-3" />
          Add at least 2 options for a usable answer.
        </div>
      )}
      {sorted.map((opt, idx) => (
        <TemplateOptionRow
          key={opt.id}
          option={opt}
          canMoveUp={idx > 0}
          canMoveDown={idx < sorted.length - 1}
          onMoveUp={() => moveOption(idx, -1)}
          onMoveDown={() => moveOption(idx, 1)}
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
          data-testid={`input-template-add-option-${itemId}`}
        />
        <Button
          size="sm" variant="ghost"
          onClick={() => { if (draft.trim()) createOption.mutate(draft.trim()); }}
          disabled={!draft.trim() || createOption.isPending}
          data-testid={`button-template-add-option-${itemId}`}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function TemplateOptionRow({
  option, canMoveUp, canMoveDown, onMoveUp, onMoveDown, onRename, onDelete,
}: {
  option: ChecklistTemplateItemOption;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(option.label);

  useEffect(() => { if (!editing) setDraft(option.label); }, [option.label, editing]);

  return (
    <div className="flex items-center gap-1" data-testid={`template-option-row-${option.id}`}>
      <Button
        size="icon" variant="ghost" className="h-5 w-5"
        disabled={!canMoveUp} onClick={onMoveUp}
        data-testid={`button-template-option-up-${option.id}`}
        aria-label="Move option up"
      >
        <ArrowUp className="h-3 w-3" />
      </Button>
      <Button
        size="icon" variant="ghost" className="h-5 w-5"
        disabled={!canMoveDown} onClick={onMoveDown}
        data-testid={`button-template-option-down-${option.id}`}
        aria-label="Move option down"
      >
        <ArrowDown className="h-3 w-3" />
      </Button>
      {editing ? (
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
          data-testid={`input-template-option-label-${option.id}`}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-left text-xs flex-1 hover:underline"
          data-testid={`button-template-option-label-${option.id}`}
        >
          {option.label}
        </button>
      )}
      <Button
        size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-destructive"
        onClick={() => { if (confirm(`Delete option "${option.label}"?`)) onDelete(); }}
        data-testid={`button-template-option-delete-${option.id}`}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

// 500ms debounce on blur — same pattern as per-project NotesField.
function NotesField({
  item, onPatch,
}: { item: ChecklistTemplateItem; onPatch: (p: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(!!item.notes);
  const [local, setLocal] = useState(item.notes ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setLocal(item.notes ?? ""); }, [item.notes]);

  if (!open && !item.notes) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground hover:text-foreground"
        data-testid={`button-template-add-notes-${item.id}`}
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
      data-testid={`textarea-template-notes-${item.id}`}
    />
  );
}
