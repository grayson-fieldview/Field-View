import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Trash2, GripVertical, Pencil, Check, X, ArrowUp, ArrowDown,
} from "lucide-react";
import { TemplateItemEditor, type TemplateFieldType } from "./template-item-editor";
import type { ChecklistTemplateItem, ChecklistTemplateSection } from "@shared/schema";

export interface TemplateSectionEditorProps {
  templateId: number;
  /** null when this is the synthetic "Untitled" bucket. */
  section: ChecklistTemplateSection | null;
  items: ChecklistTemplateItem[];
  /** Total real items (unfiltered) in this section, for sortOrder placement. */
  itemTotal: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveSectionUp?: () => void;
  onMoveSectionDown?: () => void;
  onMoveItem: (itemId: number, dir: -1 | 1) => void;
}

/**
 * Section card for the template editor. Items render inside; a footer
 * row creates new items with an inline field-type picker. Untitled
 * bucket (section === null) hides rename/delete/reorder controls.
 */
export function TemplateSectionEditor({
  templateId, section, items, itemTotal,
  canMoveUp, canMoveDown, onMoveSectionUp, onMoveSectionDown, onMoveItem,
}: TemplateSectionEditorProps) {
  const isReal = section !== null;
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(section?.title ?? "Untitled");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<TemplateFieldType>("yes_no");

  useEffect(() => {
    if (!renaming) setDraftTitle(section?.title ?? "Untitled");
  }, [section?.title, renaming]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates", templateId, "items"] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates", templateId, "sections"] });
    queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates"] });
  };

  const renameSection = useMutation({
    mutationFn: async (title: string) => {
      if (!section) return;
      const res = await apiRequest("PATCH", `/api/checklist-template-sections/${section.id}`, { title });
      return res.json();
    },
    onSuccess: invalidate,
  });

  const deleteSection = useMutation({
    mutationFn: async () => {
      if (!section) return;
      return apiRequest("DELETE", `/api/checklist-template-sections/${section.id}`);
    },
    onSuccess: () => { setConfirmDelete(false); invalidate(); },
  });

  const createItem = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        label: newLabel.trim() || "Untitled item",
        fieldType: newType,
        sortOrder: itemTotal,
      };
      if (section) body.sectionId = section.id;
      const res = await apiRequest("POST", `/api/checklist-templates/${templateId}/items`, body);
      return res.json();
    },
    onSuccess: () => { setNewLabel(""); invalidate(); },
  });

  const commitRename = () => {
    const trimmed = draftTitle.trim();
    if (trimmed && section && trimmed !== section.title) renameSection.mutate(trimmed);
    else setDraftTitle(section?.title ?? "Untitled");
    setRenaming(false);
  };

  const sortedItems = [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  return (
    <div
      className="rounded-lg border border-border bg-card p-3 space-y-3"
      data-testid={`template-section-${section?.id ?? "untitled"}`}
    >
      {/* Section header */}
      <div className="flex items-center gap-2">
        {isReal && <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50" />}

        {renaming && isReal ? (
          <>
            <Input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              autoFocus
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") {
                  setDraftTitle(section?.title ?? "Untitled");
                  setRenaming(false);
                }
              }}
              className="h-7 text-sm font-semibold flex-1"
              data-testid={`input-template-section-title-${section!.id}`}
            />
            <Button size="icon" variant="ghost" className="h-7 w-7"
              onMouseDown={(e) => e.preventDefault()}
              onClick={commitRename}
              data-testid={`button-template-section-save-${section!.id}`}>
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setDraftTitle(section?.title ?? "Untitled"); setRenaming(false); }}
              data-testid={`button-template-section-cancel-${section!.id}`}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            <span
              className="text-sm font-semibold tracking-wide"
              data-testid={`text-template-section-title-${section?.id ?? "untitled"}`}
            >
              {section?.title ?? "Untitled"}
            </span>
            <span className="text-xs text-muted-foreground/70">·</span>
            <span className="text-xs text-muted-foreground/70" data-testid={`text-template-section-count-${section?.id ?? "untitled"}`}>
              {sortedItems.length} item{sortedItems.length === 1 ? "" : "s"}
            </span>

            {isReal && (
              <div className="ml-auto flex items-center gap-0.5">
                <Button size="icon" variant="ghost" className="h-7 w-7"
                  disabled={!canMoveUp}
                  onClick={onMoveSectionUp}
                  data-testid={`button-template-section-up-${section!.id}`}
                  aria-label="Move section up">
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7"
                  disabled={!canMoveDown}
                  onClick={onMoveSectionDown}
                  data-testid={`button-template-section-down-${section!.id}`}
                  aria-label="Move section down">
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7"
                  onClick={() => setRenaming(true)}
                  data-testid={`button-template-section-rename-${section!.id}`}
                  aria-label="Rename section">
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive"
                  onClick={() => setConfirmDelete(true)}
                  data-testid={`button-template-section-delete-${section!.id}`}
                  aria-label="Delete section">
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Items */}
      <div className="space-y-2 pl-1">
        {sortedItems.map((it, idx) => (
          <TemplateItemEditor
            key={it.id}
            templateId={templateId}
            item={it}
            canMoveUp={idx > 0}
            canMoveDown={idx < sortedItems.length - 1}
            onMoveUp={() => onMoveItem(it.id, -1)}
            onMoveDown={() => onMoveItem(it.id, 1)}
          />
        ))}

        {/* Add-item footer */}
        <div className="flex items-center gap-2 pt-1">
          <Plus className="h-3.5 w-3.5 text-muted-foreground/60" />
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createItem.mutate();
            }}
            placeholder="Add item..."
            className="h-7 flex-1 text-sm"
            data-testid={`input-template-add-item-${section?.id ?? "untitled"}`}
          />
          <Select value={newType} onValueChange={(v) => setNewType(v as TemplateFieldType)}>
            <SelectTrigger className="h-7 w-32 text-xs" data-testid={`select-template-add-fieldtype-${section?.id ?? "untitled"}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="yes_no">Yes / No</SelectItem>
              <SelectItem value="rating">Rating</SelectItem>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="multiple_choice">Multiple Choice</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm" variant="ghost"
            onClick={() => createItem.mutate()}
            disabled={createItem.isPending}
            data-testid={`button-template-add-item-${section?.id ?? "untitled"}`}
          >
            Add
          </Button>
        </div>
      </div>

      {/* Section delete confirm */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent data-testid={`dialog-template-section-delete-${section?.id ?? "untitled"}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this section?</AlertDialogTitle>
            <AlertDialogDescription>
              {sortedItems.length > 0
                ? `"${section?.title}" will be deleted. Its ${sortedItems.length} item(s) will move to Untitled.`
                : `"${section?.title}" has no items and will be removed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid={`button-template-section-delete-cancel-${section?.id ?? "untitled"}`}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteSection.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid={`button-template-section-delete-confirm-${section?.id ?? "untitled"}`}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
