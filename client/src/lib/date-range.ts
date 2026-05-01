export type DateRangePreset =
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "7d"
  | "30d"
  | "custom";

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  this_week: "This week",
  last_week: "Last week",
  this_month: "This month",
  last_month: "Last month",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  custom: "Custom",
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeekMon(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay();
  const offsetToMon = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + offsetToMon);
  return x;
}

function endOfWeekMon(d: Date): Date {
  const start = startOfWeekMon(d);
  const x = new Date(start);
  x.setDate(x.getDate() + 6);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfMonthLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonthLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

export interface DateRange {
  from: Date;
  to: Date;
}

export function getDateRange(
  preset: DateRangePreset,
  customFrom?: string,
  customTo?: string,
  nowOverride?: Date,
): DateRange {
  const now = nowOverride ?? new Date();
  switch (preset) {
    case "this_week":
      return { from: startOfWeekMon(now), to: endOfWeekMon(now) };
    case "last_week": {
      const lastWeekRef = new Date(startOfWeekMon(now));
      lastWeekRef.setDate(lastWeekRef.getDate() - 7);
      return { from: startOfWeekMon(lastWeekRef), to: endOfWeekMon(lastWeekRef) };
    }
    case "this_month":
      return { from: startOfMonthLocal(now), to: endOfMonthLocal(now) };
    case "last_month": {
      const lastMonthRef = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      return { from: startOfMonthLocal(lastMonthRef), to: endOfMonthLocal(lastMonthRef) };
    }
    case "7d": {
      const from = startOfDay(now);
      from.setDate(from.getDate() - 6);
      return { from, to: endOfDay(now) };
    }
    case "30d": {
      const from = startOfDay(now);
      from.setDate(from.getDate() - 29);
      return { from, to: endOfDay(now) };
    }
    case "custom": {
      const from = customFrom
        ? startOfDay(new Date(`${customFrom}T00:00:00`))
        : startOfWeekMon(now);
      const to = customTo
        ? endOfDay(new Date(`${customTo}T00:00:00`))
        : endOfWeekMon(now);
      return { from, to };
    }
  }
}

export function formatDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
