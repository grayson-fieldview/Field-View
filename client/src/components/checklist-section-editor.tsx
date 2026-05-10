import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, GripVertical, Pencil, Check, X } from "lucide-react";
import { ChecklistFieldInput, type ChecklistFieldType } from "./checklist-field-input";
import type { ChecklistItem, ChecklistSection } from "@shared/schema";

interface ChecklistSectionEditorProps {
  checklistId: number;
  projectId: string;
}

// Untitled-section sentinel for items with section_id NULL.
const UNTITLED_SECTION_ID = -1;

export function ChecklistSectionEditor({ checklistId, projectId }: ChecklistSectionEditorProps) {
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

  // Group items by section (Untitled bucket for null sectionId).
  const grouped = new Map<number, ChecklistItem[]>();
  for (const it of items) {
    const k = it.sectionId ?? UNTITLED_SECTION_ID;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(it);
  }
  Array.from(grouped.values()).forEach((arr: ChecklistItem[]) => arr.sort((a, b) => a.sortOrder - b.sortOrder));

  const sortedSections = [...sections].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  // Render order: untitled bucket first if it has items, then real sections.
  const untitledItems = grouped.get(UNTITLED_SECTION_ID) ?? [];

  return (
    <div className="space-y-4">
      {untitledItems.length > 0 && (
        <SectionGroup
          checklistId={checklistId}
          sectionId={null}
          title="Untitled"
          items={untitledItems}
          onPatchItem={(itemId, patch) => patchItem.mutate({ itemId, patch })}
          onDeleteItem={(itemId) => deleteItem.mutate(itemId)}
          onAddItem={(seed) => createItem.mutate({ ...seed, sortOrder: untitledItems.length })}
        />
      )}

      {sortedSections.map((sec) => {
        const sectionItems = grouped.get(sec.id) ?? [];
        return (
          <SectionGroup
            key={sec.id}
            checklistId={checklistId}
            sectionId={sec.id}
            title={sec.title}
            items={sectionItems}
            onPatchItem={(itemId, patch) => patchItem.mutate({ itemId, patch })}
            onDeleteItem={(itemId) => deleteItem.mutate(itemId)}
            onAddItem={(seed) => createItem.mutate({ ...seed, sectionId: sec.id, sortOrder: sectionItems.length })}
            onRenameSection={(title) => updateSection.mutate({ id: sec.id, title })}
            onDeleteSection={() => {
              if (sectionItems.length > 0 && !confirm(`Delete "${sec.title}"? Its ${sectionItems.length} item(s) will move to Untitled.`)) return;
              if (sectionItems.length === 0 && !confirm(`Delete section "${sec.title}"?`)) return;
              deleteSection.mutate(sec.id);
            }}
          />
        );
      })}

      <AddSectionRow onAdd={(t) => createSection.mutate(t)} />
    </div>
  );
}

function SectionGroup({
  checklistId, sectionId, title, items, onPatchItem, onDeleteItem, onAddItem,
  onRenameSection, onDeleteSection,
}: {
  checklistId: number;
  sectionId: number | null;
  title: string;
  items: ChecklistItem[];
  onPatchItem: (itemId: number, patch: Record<string, unknown>) => void;
  onDeleteItem: (itemId: number) => void;
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
            onPatch={(patch) => onPatchItem(it.id, patch)}
            onDelete={() => onDeleteItem(it.id)}
          />
        ))}
        <AddItemRow onAdd={onAddItem} />
      </div>
    </div>
  );
}

function ItemRow({
  item, onPatch, onDelete,
}: {
  item: ChecklistItem;
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(item.label);

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

          <div className="flex items-center gap-2">
            <Select
              value={item.fieldType}
              onValueChange={(v) => onPatch({ fieldType: v })}
            >
              <SelectTrigger className="h-7 w-28 text-xs" data-testid={`select-fieldtype-${item.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="yes_no">Yes / No</SelectItem>
                <SelectItem value="rating">Rating</SelectItem>
                <SelectItem value="text">Text</SelectItem>
              </SelectContent>
            </Select>

            <ChecklistFieldInput
              fieldType={item.fieldType as ChecklistFieldType}
              valueBool={item.valueBool}
              valueRating={item.valueRating}
              valueText={item.valueText}
              itemId={item.id}
              onChangeBool={(v) => onPatch({ valueBool: v })}
              onChangeRating={(v) => onPatch({ valueRating: v })}
              onChangeText={(v) => onPatch({ valueText: v })}
            />
          </div>

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
        <SelectTrigger className="h-7 w-24 text-xs" data-testid="select-add-fieldtype">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="yes_no">Yes / No</SelectItem>
          <SelectItem value="rating">Rating</SelectItem>
          <SelectItem value="text">Text</SelectItem>
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

