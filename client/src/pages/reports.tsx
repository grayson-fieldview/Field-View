import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileBarChart,
  FileText,
  Send,
  CheckCircle2,
  Trash2,
  LayoutTemplate,
} from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Report, ReportTemplate } from "@shared/schema";

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

type TabKey = "reports" | "templates";

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("reports");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateType, setNewTemplateType] = useState("inspection");
  const [newTemplateContent, setNewTemplateContent] = useState("");
  const [newTemplateFindings, setNewTemplateFindings] = useState("");
  const [newTemplateRecommendations, setNewTemplateRecommendations] = useState("");
  const { toast } = useToast();

  const { data: allReports, isLoading: reportsLoading } = useQuery<ReportWithDetails[]>({
    queryKey: ["/api/reports"],
  });

  const { data: templates, isLoading: templatesLoading } = useQuery<ReportTemplate[]>({
    queryKey: ["/api/report-templates"],
  });

  const createTemplate = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/report-templates", {
        title: newTemplateName,
        type: newTemplateType,
        content: newTemplateContent || null,
        findings: newTemplateFindings || null,
        recommendations: newTemplateRecommendations || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-templates"] });
      setNewTemplateName("");
      setNewTemplateType("inspection");
      setNewTemplateContent("");
      setNewTemplateFindings("");
      setNewTemplateRecommendations("");
      toast({ title: "Template created" });
    },
    onError: () => {
      toast({ title: "Failed to create template", variant: "destructive" });
    },
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/report-templates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-templates"] });
      toast({ title: "Template deleted" });
    },
  });

  const getInitials = (firstName: string | null, lastName: string | null) => {
    return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
  };

  const isLoading = activeTab === "reports" ? reportsLoading : templatesLoading;

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
    { key: "templates", label: "Templates", count: templates?.length || 0 },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-reports-title">Reports</h1>
          <p className="text-sm text-muted-foreground mt-1">View reports and manage reusable templates</p>
        </div>
      </div>

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
        </>
      )}

      {activeTab === "templates" && (
        <div className="space-y-4">
          <Card className="p-4 space-y-3">
            <h3 className="text-sm font-semibold">Create Report Template</h3>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                placeholder="Template name..."
                value={newTemplateName}
                onChange={(e) => setNewTemplateName(e.target.value)}
                className="flex-1 min-w-[200px]"
                data-testid="input-report-template-name"
              />
              <Select value={newTemplateType} onValueChange={setNewTemplateType}>
                <SelectTrigger className="w-[160px]" data-testid="select-report-template-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inspection">Inspection</SelectItem>
                  <SelectItem value="safety">Safety</SelectItem>
                  <SelectItem value="progress">Progress</SelectItem>
                  <SelectItem value="incident">Incident</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Textarea
              placeholder="Content template (optional)..."
              value={newTemplateContent}
              onChange={(e) => setNewTemplateContent(e.target.value)}
              className="min-h-[60px]"
              data-testid="input-report-template-content"
            />
            <Textarea
              placeholder="Findings template (optional)..."
              value={newTemplateFindings}
              onChange={(e) => setNewTemplateFindings(e.target.value)}
              className="min-h-[60px]"
              data-testid="input-report-template-findings"
            />
            <Textarea
              placeholder="Recommendations template (optional)..."
              value={newTemplateRecommendations}
              onChange={(e) => setNewTemplateRecommendations(e.target.value)}
              className="min-h-[60px]"
              data-testid="input-report-template-recommendations"
            />
            <div className="flex justify-end">
              <Button
                onClick={() => { if (newTemplateName.trim()) createTemplate.mutate(); }}
                disabled={createTemplate.isPending || !newTemplateName.trim()}
                data-testid="button-create-report-template"
              >
                <LayoutTemplate className="h-4 w-4 mr-2" />
                {createTemplate.isPending ? "Creating..." : "Create Template"}
              </Button>
            </div>
          </Card>

          {(!templates || templates.length === 0) ? (
            <Card className="p-12">
              <div className="text-center space-y-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                  <LayoutTemplate className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold">No templates yet</h3>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  Create a report template above. Templates can be applied when creating reports in projects.
                </p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {templates.map((t) => (
                <Card key={t.id} className="p-4" data-testid={`card-report-template-${t.id}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                        <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <span className="text-sm font-semibold" data-testid={`text-report-template-title-${t.id}`}>{t.title}</span>
                        <p className="text-xs text-muted-foreground">{reportTypeLabels[t.type] || t.type}</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteTemplate.mutate(t.id)}
                      data-testid={`button-delete-report-template-${t.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
