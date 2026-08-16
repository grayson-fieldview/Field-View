/**
 * Derived report status badge — reports.status (draft/submitted/approved)
 * is a dead column nothing reads; the badge reflects real state instead.
 *
 * Precedence: shareToken → "Shared", lastPdfAt → "Exported", else "Draft".
 */
export type ReportBadge = { label: string; badgeClass: string };

export function getReportBadge(report: {
  shareToken?: string | null;
  lastPdfAt?: string | Date | null;
}): ReportBadge {
  if (report.shareToken) {
    return {
      label: "Shared",
      badgeClass: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    };
  }
  if (report.lastPdfAt) {
    return { label: "Exported", badgeClass: "bg-secondary text-secondary-foreground" };
  }
  return { label: "Draft", badgeClass: "bg-muted text-muted-foreground" };
}
