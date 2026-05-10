import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Star } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ChecklistItemOption } from "@shared/schema";

export type ChecklistFieldType = "yes_no" | "rating" | "text" | "multiple_choice";

export interface ChecklistFieldInputProps {
  fieldType: ChecklistFieldType;
  valueBool: boolean | null;
  valueRating: number | null;
  valueText: string | null;
  selectedOptionId: number | null;
  itemId: number;
  onChangeBool: (next: boolean | null) => void;
  onChangeRating: (next: number | null) => void;
  onChangeText: (next: string) => void;
  onChangeOption: (next: number | null) => void;
  disabled?: boolean;
}

export function ChecklistFieldInput({
  fieldType, valueBool, valueRating, valueText, selectedOptionId, itemId,
  onChangeBool, onChangeRating, onChangeText, onChangeOption, disabled,
}: ChecklistFieldInputProps) {
  if (fieldType === "yes_no") {
    return (
      <div className="flex items-center gap-1.5" data-testid={`field-yesno-${itemId}`}>
        <PillButton
          label="Yes"
          selected={valueBool === true}
          selectedClassName="bg-[#267D32] text-white border-[#267D32]"
          onClick={() => onChangeBool(valueBool === true ? null : true)}
          disabled={disabled}
          testId={`button-yes-${itemId}`}
        />
        <PillButton
          label="No"
          selected={valueBool === false}
          selectedClassName="bg-red-600 text-white border-red-600"
          onClick={() => onChangeBool(valueBool === false ? null : false)}
          disabled={disabled}
          testId={`button-no-${itemId}`}
        />
      </div>
    );
  }

  if (fieldType === "rating") {
    return (
      <div className="flex items-center gap-0.5" data-testid={`field-rating-${itemId}`}>
        {[1, 2, 3, 4, 5].map((n) => {
          const filled = valueRating !== null && n <= valueRating;
          return (
            <button
              key={n}
              type="button"
              disabled={disabled}
              // Click already-selected star to clear (set to null).
              onClick={() => onChangeRating(valueRating === n ? null : n)}
              className={cn(
                "p-0.5 hover-elevate active-elevate-2 rounded-sm",
                disabled && "opacity-50 cursor-not-allowed",
              )}
              data-testid={`button-star-${itemId}-${n}`}
              aria-label={`${n} star${n === 1 ? "" : "s"}`}
            >
              <Star
                className={cn(
                  "h-5 w-5 transition-colors",
                  filled ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40",
                )}
              />
            </button>
          );
        })}
      </div>
    );
  }

  if (fieldType === "multiple_choice") {
    return (
      <MultipleChoiceField
        itemId={itemId}
        selectedOptionId={selectedOptionId}
        onChangeOption={onChangeOption}
        disabled={disabled}
      />
    );
  }

  // text
  return (
    <DebouncedTextField
      itemId={itemId}
      value={valueText ?? ""}
      onCommit={onChangeText}
      disabled={disabled}
    />
  );
}

// Lazy fetch — most items in a long checklist are not multiple_choice, so we
// avoid prefetching options. The PATCH endpoint validates option ownership
// server-side regardless of what this component renders.
function MultipleChoiceField({
  itemId, selectedOptionId, onChangeOption, disabled,
}: {
  itemId: number;
  selectedOptionId: number | null;
  onChangeOption: (next: number | null) => void;
  disabled?: boolean;
}) {
  const { data: options = [], isLoading } = useQuery<ChecklistItemOption[]>({
    queryKey: ["/api/checklist-items", itemId, "options"],
  });
  if (isLoading) {
    return <span className="text-xs text-muted-foreground" data-testid={`field-mc-loading-${itemId}`}>Loading...</span>;
  }
  if (options.length === 0) {
    return (
      <span className="text-xs text-amber-600" data-testid={`field-mc-empty-${itemId}`}>
        No options defined
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap" data-testid={`field-mc-${itemId}`}>
      {options.map((opt) => {
        const selected = selectedOptionId === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            // Click already-selected option to clear (set to null).
            onClick={() => onChangeOption(selected ? null : opt.id)}
            className={cn(
              "px-3 py-1 text-xs font-medium rounded-full border transition-colors hover-elevate active-elevate-2",
              selected
                ? "bg-[#F09000] text-white border-[#F09000]"
                : "bg-background text-muted-foreground border-border",
              disabled && "opacity-50 cursor-not-allowed",
            )}
            data-testid={`button-mc-option-${itemId}-${opt.id}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function PillButton({
  label, selected, selectedClassName, onClick, disabled, testId,
}: {
  label: string;
  selected: boolean;
  selectedClassName: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "px-3 py-1 text-xs font-medium rounded-full border transition-colors hover-elevate active-elevate-2",
        selected ? selectedClassName : "bg-background text-muted-foreground border-border",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      {label}
    </button>
  );
}

// 500ms debounce on text edits — without it, typing "Hello" fires 5 PATCHes.
// Also commits on blur so a typed value lands immediately if the user moves on.
function DebouncedTextField({
  itemId, value, onCommit, disabled,
}: { itemId: number; value: string; onCommit: (v: string) => void; disabled?: boolean }) {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = useRef(value);

  // External value changes (other client, mutation success) sync into local
  // unless the user is mid-edit (local !== lastCommitted).
  useEffect(() => {
    if (local === lastCommitted.current) {
      setLocal(value);
      lastCommitted.current = value;
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const schedule = (next: string) => {
    setLocal(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next !== lastCommitted.current) {
        lastCommitted.current = next;
        onCommit(next);
      }
    }, 500);
  };

  const flush = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (local !== lastCommitted.current) {
      lastCommitted.current = local;
      onCommit(local);
    }
  };

  return (
    <Textarea
      value={local}
      onChange={(e) => schedule(e.target.value)}
      onBlur={flush}
      disabled={disabled}
      placeholder="Type response..."
      rows={2}
      className="text-sm min-h-[60px] resize-y"
      data-testid={`textarea-text-${itemId}`}
    />
  );
}
