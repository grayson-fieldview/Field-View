import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import {
  FileBarChart,
  FileText,
  Send,
  CheckCircle2,
} from "lucide-react";
import { Link } from "wouter";
import type { Report } from "@shared/schema";

type ReportWithDetails = Report & {
  project?: { name: string };
  createdBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null };
};

const statusConfig: Record<string, { label: string; icon: typeof FileText; badgeClass: string }> = {
  draft: { label: "Draft", icon: FileText, badgeClass: "bg-muted text-muted-foreground" },
  submitted: { label: "Submitted", icon: Send, badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  approved: { label: "Approved", icon: CheckCircle2, badgeClass: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
};

const reportTypeLabels: Record<string, string> = {
  inspection: "Inspection Report",
  safety: "Safety Report",
  progress: "Progress Report",
  incident: "Incident Report",
  daily: "Daily Report",
};

export default function ReportsPage() {
  const { data: allReports, isLoading } = useQuery<ReportWithDetails[]>({
    queryKey: ["/api/reports"],
  });

  const getInitials = (firstName: string | null, lastName: string | null) => {
    return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
  };

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-4 max-w-4xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-reports-title">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">View inspection and project reports across all projects</p>
        </div>
      </div>

      {(!allReports || allReports.length === 0) ? (
        <Card className="p-12">
          <div className="text-center space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
              <FileBarChart className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold">No reports yet</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Reports are created within projects. Go to a project to create your first report.
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {allReports.map((report) => {
            const config = statusConfig[report.status] || statusConfig.draft;
            return (
              <Card key={report.id} className="p-4 hover-elevate" data-testid={`card-report-${report.id}`}>
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                    <config.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <Link href={`/projects/${report.projectId}`}>
                        <span className="text-sm font-semibold hover:underline cursor-pointer" data-testid={`text-report-title-${report.id}`}>
                          {report.title}
                        </span>
                      </Link>
                      <Badge variant="secondary" className={`text-xs shrink-0 no-default-hover-elevate no-default-active-elevate ${config.badgeClass}`}>
                        {config.label}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      {report.project && (
                        <span className="text-xs text-muted-foreground">{report.project.name}</span>
                      )}
                      <span className="text-xs text-muted-foreground/50">|</span>
                      <span className="text-xs text-muted-foreground">{reportTypeLabels[report.type] || report.type}</span>
                      <span className="text-xs text-muted-foreground/50">|</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(report.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                      </span>
                    </div>
                    {report.createdBy && (
                      <div className="flex items-center gap-1.5 mt-2">
                        <Avatar className="h-5 w-5">
                          <AvatarImage src={report.createdBy.profileImageUrl || undefined} />
                          <AvatarFallback className="text-[8px] bg-primary/10 text-primary">
                            {getInitials(report.createdBy.firstName, report.createdBy.lastName)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-xs text-muted-foreground">
                          {report.createdBy.firstName} {report.createdBy.lastName}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
