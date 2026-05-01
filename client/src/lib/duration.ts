export function hoursFromInterval(
  clockIn: Date | string,
  clockOut: Date | string | null,
  nowFallback?: Date,
): number {
  const start = typeof clockIn === "string" ? new Date(clockIn) : clockIn;
  const endRaw = clockOut == null ? (nowFallback ?? new Date()) : clockOut;
  const end = typeof endRaw === "string" ? new Date(endRaw) : endRaw;
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return ms / 3_600_000;
}

export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "0h";
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatLocalDateTime(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
