import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import {
  ClipboardCheck,
  CheckCircle2,
  Clock,
  Circle,
  Plus,
  Trash2,
  X,
  LayoutTemplate,
} from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Checklist, ChecklistTemplate } from "@shared/schema";

type ChecklistWithDetails = Checklist & {
  project?: { name: string };
  assignedTo?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null };
  itemCount: number;
  checkedCount: number;
};

type ChecklistTemplateWithCount = ChecklistTemplate & { itemCount: number };

const statusConfig: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  not_started: { label: "Not Started", icon: Circle, className: "text-muted-foreground" },
  in_progress: { label: "In Progress", icon: Clock, className: "text-amber-500" },
  completed: { label: "Completed", icon: CheckCircle2, className: "text-green-500" },
};

type TabKey = "checklists" | "templates";

export default function ChecklistsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>("checklists");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateItems, setNewTemplateItems] = useState<string[]>([""]);
  const { toast } = useToast();

  const { data: allChecklists, isLoading: checklistsLoading } = useQuery<ChecklistWithDetails[]>({
    queryKey: ["/api/checklists"],
  });

  const { data: templates, isLoading: templatesLoading } = useQuery<ChecklistTemplateWithCount[]>({
    queryKey: ["/api/checklist-templates"],
  });

  const createTemplate = useMutation({
    mutationFn: async () => {
      const items = newTemplateItems.filter(i => i.trim());
      return apiRequest("POST", "/api/checklist-templates", { title: newTemplateName, items });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates"] });
      setNewTemplateName("");
      setNewTemplateItems([""]);
      toast({ title: "Template created" });
    },
    onError: () => {
      toast({ title: "Failed to create template", variant: "destructive" });
    },
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/checklist-templates/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates"] });
      toast({ title: "Template deleted" });
    },
  });

  const getInitials = (firstName: string | null, lastName: string | null) => {
    return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
  };

  const isLoading = activeTab === "checklists" ? checklistsLoading : templatesLoading;

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
    { key: "checklists", label: "All Checklists", count: allChecklists?.length || 0 },
    { key: "templates", label: "Templates", count: templates?.length || 0 },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-checklists-title">Checklists</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage checklists and reusable templates</p>
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

      {activeTab === "checklists" && (
        <>
          {(!allChecklists || allChecklists.length === 0) ? (
            <Card className="p-12">
              <div className="text-center space-y-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                  <ClipboardCheck className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold">No checklists yet</h3>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  Checklists are created within projects. Go to a project to create your first checklist.
                </p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {allChecklists.map((cl) => {
                const config = statusConfig[cl.status] || statusConfig.not_started;
                const StatusIcon = config.icon;
                const progress = cl.itemCount > 0 ? Math.round((cl.checkedCount / cl.itemCount) * 100) : 0;
                return (
                  <Card key={cl.id} className="p-4 hover-elevate" data-testid={`card-checklist-${cl.id}`}>
                    <div className="flex items-start gap-3">
                      <StatusIcon className={`h-5 w-5 mt-0.5 shrink-0 ${config.className}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <Link href={`/projects/${cl.projectId}`}>
                            <span className="text-sm font-semibold hover:underline cursor-pointer" data-testid={`text-checklist-title-${cl.id}`}>
                              {cl.title}
                            </span>
                          </Link>
                          <Badge variant="secondary" className="text-xs shrink-0 no-default-hover-elevate no-default-active-elevate">
                            {cl.checkedCount}/{cl.itemCount} items
                          </Badge>
                        </div>
                        {cl.project && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {cl.project.name}
                          </p>
                        )}
                        {cl.itemCount > 0 && (
                          <div className="mt-2 flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div
                                className="h-full bg-primary rounded-full transition-all"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground">{progress}%</span>
                          </div>
                        )}
                        <div className="flex items-center gap-3 mt-2">
                          {cl.assignedTo && (
                            <div className="flex items-center gap-1.5">
                              <Avatar className="h-5 w-5">
                                <AvatarImage src={cl.assignedTo.profileImageUrl || undefined} />
                                <AvatarFallback className="text-[8px] bg-primary/10 text-primary">
                                  {getInitials(cl.assignedTo.firstName, cl.assignedTo.lastName)}
                                </AvatarFallback>
                              </Avatar>
                              <span className="text-xs text-muted-foreground">
                                {cl.assignedTo.firstName} {cl.assignedTo.lastName}
                              </span>
                            </div>
                          )}
                        </div>
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
            <h3 className="text-sm font-semibold">Create Template</h3>
            <Input
              placeholder="Template name..."
              value={newTemplateName}
              onChange={(e) => setNewTemplateName(e.target.value)}
              data-testid="input-template-name"
            />
            <div className="space-y-2">
              {newTemplateItems.map((item, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
                  <Input
                    placeholder={`Item ${idx + 1}...`}
                    value={item}
                    onChange={(e) => {
                      const updated = [...newTemplateItems];
                      updated[idx] = e.target.value;
                      setNewTemplateItems(updated);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        setNewTemplateItems([...newTemplateItems, ""]);
                      }
                    }}
                    className="flex-1"
                    data-testid={`input-template-item-${idx}`}
                  />
                  {newTemplateItems.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setNewTemplateItems(newTemplateItems.filter((_, i) => i !== idx))}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="text-primary"
                onClick={() => setNewTemplateItems([...newTemplateItems, ""])}
                data-testid="button-add-template-item"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Item
              </Button>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={() => { if (newTemplateName.trim()) createTemplate.mutate(); }}
                disabled={createTemplate.isPending || !newTemplateName.trim()}
                data-testid="button-create-template"
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
                  Create a checklist template above. Templates can be applied when creating checklists in projects.
                </p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {templates.map((t) => (
                <Card key={t.id} className="p-4" data-testid={`card-template-${t.id}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                        <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <span className="text-sm font-semibold" data-testid={`text-template-title-${t.id}`}>{t.title}</span>
                        <p className="text-xs text-muted-foreground">{t.itemCount} item{t.itemCount !== 1 ? "s" : ""}</p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteTemplate.mutate(t.id)}
                      data-testid={`button-delete-template-${t.id}`}
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
