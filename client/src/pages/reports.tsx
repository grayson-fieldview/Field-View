import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  FileBarChart,
  FileText,
  Send,
  CheckCircle2,
  LayoutTemplate,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { Link } from "wouter";
import type { Report, ReportTemplate, TemplateConfig } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import ReportFormDialog from "@/components/report-form-dialog";

type ReportListItem = Report & {
  project?: { name: string };
  createdBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null };
};

type ReportTemplateWithCount = ReportTemplate & { sectionCount: number };

const statusConfig: Record<string, { label: string; icon: typeof FileText; badgeClass: string }> = {
  draft: { label: "Draft", icon: FileText, badgeClass: "bg-muted text-muted-foreground" },
  submitted: { label: "Submitted", icon: Send, badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  approved: { label: "Approved", icon: CheckCircle2, badgeClass: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
};

type TabKey = "reports" | "templates";

const EMPTY_TEMPLATE_CONFIG: TemplateConfig = {
  version: 1,
  cover: {
    description: null,
    coverConfig: {
      showCoverPhoto: true,
      showCompanyLogo: true,
      showCompanyName: true,
      showCreatorName: true,
      showPhotoCount: true,
      showDateCreated: true,
    },
  },
  sections: [{ title: "Untitled Section", summary: null, sortOrder: 0 }],
};

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("reports");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const { user } = useAuth();
  const { toast } = useToast();
  const canCreate = !!user && user.role !== "restricted";
  const canManageTemplates = !!user && (user.role === "admin" || user.role === "manager");

  const [renameTarget, setRenameTarget] = useState<ReportTemplate | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ReportTemplate | null>(null);

  const { data: allReports, isLoading } = useQuery<ReportListItem[]>({
    queryKey: ["/api/reports"],
  });

  const templatesQuery = useQuery<ReportTemplateWithCount[]>({
    queryKey: ["/api/report-templates"],
    enabled: activeTab === "templates",
  });

  const createTemplate = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/report-templates", {
        title: "Untitled Template",
        templateConfig: EMPTY_TEMPLATE_CONFIG,
      });
      return (await res.json()) as ReportTemplateWithCount;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-templates"] });
      toast({ title: "Template created" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create template", description: error.message, variant: "destructive" });
    },
  });

  const renameTemplate = useMutation({
    mutationFn: async ({ id, title }: { id: number; title: string }) => {
      const res = await apiRequest("PATCH", `/api/report-templates/${id}`, { title });
      return (await res.json()) as ReportTemplate;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-templates"] });
      setRenameTarget(null);
      toast({ title: "Template renamed" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to rename template", description: error.message, variant: "destructive" });
    },
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/report-templates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-templates"] });
      setDeleteTarget(null);
      toast({ title: "Template deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete template", description: error.message, variant: "destructive" });
    },
  });

  const getInitials = (firstName: string | null, lastName: string | null) =>
    `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";

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

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: "reports", label: "All Reports", count: allReports?.length || 0 },
    { key: "templates", label: "Templates", count: templatesQuery.data?.length || 0 },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-reports-title">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">View reports across all projects.</p>
        </div>
        {activeTab === "reports" && canCreate && (
          <Button onClick={() => setIsCreateOpen(true)} data-testid="button-create-report">
            <Plus className="h-4 w-4 mr-2" />
            Create Report
          </Button>
        )}
        {activeTab === "templates" && canManageTemplates && (
          <Button
            onClick={() => createTemplate.mutate()}
            disabled={createTemplate.isPending}
            data-testid="button-create-template"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Template
          </Button>
        )}
      </div>

      <ReportFormDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} />

      <div className="flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`tab-${tab.key}`}
          >
            {tab.label}
            {tab.count > 0 && (
              <Badge variant="secondary" className="ml-2 text-xs no-default-hover-elevate no-default-active-elevate">
                {tab.count}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {activeTab === "reports" && (
        <>
          {(!allReports || allReports.length === 0) ? (
            <Card className="p-12">
              <div className="text-center space-y-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                  <FileBarChart className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold">No reports yet</h3>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  {canCreate ? "Click Create Report to get started." : "Reports will appear here once your team creates them."}
                </p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {allReports.map((report) => {
                const config = statusConfig[report.status] ?? statusConfig.draft;
                return (
                  <Link key={report.id} href={`/reports/${report.id}/edit`}>
                    <Card className="p-4 cursor-pointer hover-elevate" data-testid={`card-report-${report.id}`}>
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                          <config.icon className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold truncate" data-testid={`text-report-title-${report.id}`}>
                              {report.title}
                            </span>
                            <Badge variant="secondary" className={`text-xs shrink-0 no-default-hover-elevate no-default-active-elevate ${config.badgeClass}`}>
                              {config.label}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 mt-1">
                            {report.project && (
                              <span className="text-xs text-muted-foreground">{report.project.name}</span>
                            )}
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
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}

      {activeTab === "templates" && (
        <>
          {templatesQuery.isLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-md" />)}
            </div>
          ) : !templatesQuery.data || templatesQuery.data.length === 0 ? (
            <Card className="p-12" data-testid="card-templates-empty">
              <div className="text-center space-y-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                  <LayoutTemplate className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold">No templates yet</h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto">
                  Templates save the structure of a report (cover settings + section titles) so you can reuse it. Full editing coming in next update.
                </p>
                {canManageTemplates && (
                  <p className="text-sm text-muted-foreground">Click New Template to create one.</p>
                )}
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {templatesQuery.data.map((t) => (
                <Card key={t.id} className="p-4" data-testid={`card-template-${t.id}`}>
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                      <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold truncate" data-testid={`text-template-title-${t.id}`}>
                          {t.title}
                        </span>
                        {canManageTemplates && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 shrink-0"
                                data-testid={`button-template-menu-${t.id}`}
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => {
                                  setRenameValue(t.title);
                                  setRenameTarget(t);
                                }}
                                data-testid={`menuitem-rename-template-${t.id}`}
                              >
                                <Pencil className="h-4 w-4 mr-2" />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setDeleteTarget(t)}
                                className="text-destructive focus:text-destructive"
                                data-testid={`menuitem-delete-template-${t.id}`}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground" data-testid={`text-template-section-count-${t.id}`}>
                          {t.sectionCount} {t.sectionCount === 1 ? "section" : "sections"}
                        </span>
                        <span className="text-xs text-muted-foreground/50">|</span>
                        <span className="text-xs text-muted-foreground">
                          Updated {new Date(t.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <AlertDialog
        open={renameTarget !== null}
        onOpenChange={(open) => { if (!open) setRenameTarget(null); }}
      >
        <AlertDialogContent data-testid="dialog-rename-template">
          <AlertDialogHeader>
            <AlertDialogTitle>Rename template</AlertDialogTitle>
            <AlertDialogDescription>Give this template a new name.</AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="Template name"
            maxLength={200}
            autoFocus
            data-testid="input-rename-template"
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameValue.trim() && renameTarget) {
                renameTemplate.mutate({ id: renameTarget.id, title: renameValue.trim() });
              }
            }}
          />
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={renameTemplate.isPending}
              data-testid="button-cancel-rename-template"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (renameValue.trim() && renameTarget) {
                  renameTemplate.mutate({ id: renameTarget.id, title: renameValue.trim() });
                }
              }}
              disabled={!renameValue.trim() || renameTemplate.isPending}
              data-testid="button-confirm-rename-template"
            >
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent data-testid="dialog-delete-template">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete template?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? `"${deleteTarget.title}" will be permanently removed. Reports created from this template are not affected.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={deleteTemplate.isPending}
              data-testid="button-cancel-delete-template"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) deleteTemplate.mutate(deleteTarget.id);
              }}
              disabled={deleteTemplate.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-template"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
