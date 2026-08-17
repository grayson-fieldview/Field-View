/**
 * Derived report status badge.
 *
 * Precedence: status 'generating' → "Generating"; status 'failed' →
 * "Failed" (outranks Shared — a failed regenerate must be visible even on a
 * previously shared report); shareToken → "Shared"; else "Ready".
 * lastPdfAt is deliberately NOT a badge input anymore.
 */
export type ReportBadge = { label: string; badgeClass: string };

export function getReportBadge(report: {
  status?: string | null;
  shareToken?: string | null;
}): ReportBadge {
  if (report.status === "generating") {
    return { label: "Generating", badgeClass: "bg-muted text-muted-foreground" };
  }
  if (report.status === "failed") {
    return {
      label: "Failed",
      badgeClass: "bg-destructive/10 text-destructive dark:bg-destructive/20",
    };
  }
  if (report.shareToken) {
    return {
      label: "Shared",
      badgeClass: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    };
  }
  return { label: "Ready", badgeClass: "bg-secondary text-secondary-foreground" };
}
