import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ClipboardCheck,
  CheckCircle2,
  Clock,
  Circle,
  Plus,
  Trash2,
  Pencil,
  LayoutTemplate,
} from "lucide-react";
import { Link, useLocation } from "wouter";
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

function readTabFromSearch(): TabKey {
  if (typeof window === "undefined") return "checklists";
  return new URLSearchParams(window.location.search).get("tab") === "templates"
    ? "templates"
    : "checklists";
}

export default function ChecklistsPage() {
  const [location, navigate] = useLocation();
  // Honor ?tab=templates so back-links from the editor land on the right tab.
  const [activeTab, setActiveTab] = useState<TabKey>(() => readTabFromSearch());

  // Re-sync when the URL changes (back/forward, programmatic nav). wouter's
  // useLocation only tracks the path, not the search string, so we also
  // listen to popstate to catch ?tab= flips.
  useEffect(() => {
    setActiveTab(readTabFromSearch());
    const onPop = () => setActiveTab(readTabFromSearch());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [location]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChecklistTemplateWithCount | null>(null);
  const { toast } = useToast();

  const { data: allChecklists, isLoading: checklistsLoading } = useQuery<ChecklistWithDetails[]>({
    queryKey: ["/api/checklists"],
  });

  const { data: templates, isLoading: templatesLoading } = useQuery<ChecklistTemplateWithCount[]>({
    queryKey: ["/api/checklist-templates"],
  });

  const createTemplate = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/checklist-templates", {
        title: newTemplateName.trim(),
      });
      return res.json();
    },
    onSuccess: (created: { id: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates"] });
      setNewTemplateName("");
      setCreateOpen(false);
      toast({ title: "Template created" });
      // Drop the user straight into the rich editor.
      navigate(`/checklist-templates/${created.id}/edit`);
    },
    onError: () => {
      toast({ title: "Failed to create template", variant: "destructive" });
    },
  });

  const deleteTemplate = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/checklist-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklist-templates"] });
      setDeleteTarget(null);
      toast({ title: "Template deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete template", variant: "destructive" });
    },
  });

  const getInitials = (firstName: string | null, lastName: string | null) =>
    `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";

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
          <div className="flex justify-end">
            <Button
              onClick={() => setCreateOpen(true)}
              data-testid="button-new-template"
            >
              <Plus className="h-4 w-4 mr-1.5" />
              New Template
            </Button>
          </div>

          {(!templates || templates.length === 0) ? (
            <Card className="p-12">
              <div className="text-center space-y-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                  <LayoutTemplate className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="text-lg font-semibold">No templates yet</h3>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  Click "New Template" above to author a reusable checklist template with sections, items, and field types.
                </p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              {templates.map((t) => (
                <Card
                  key={t.id}
                  className="p-4 hover-elevate"
                  data-testid={`card-template-${t.id}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <Link
                      href={`/checklist-templates/${t.id}/edit`}
                      className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
                      data-testid={`link-template-${t.id}`}
                    >
                      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                        <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <span className="text-sm font-semibold" data-testid={`text-template-title-${t.id}`}>{t.title}</span>
                        <p className="text-xs text-muted-foreground">{t.itemCount} item{t.itemCount !== 1 ? "s" : ""}</p>
                      </div>
                    </Link>
                    <div className="flex items-center gap-1 shrink-0">
                      <Link href={`/checklist-templates/${t.id}/edit`}>
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid={`button-edit-template-${t.id}`}
                          aria-label="Edit template"
                        >
                          <Pencil className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(t)}
                        data-testid={`button-delete-template-${t.id}`}
                        aria-label="Delete template"
                      >
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* New template dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) { setCreateOpen(false); setNewTemplateName(""); } }}>
        <DialogContent data-testid="dialog-new-template">
          <DialogHeader>
            <DialogTitle>New Template</DialogTitle>
            <DialogDescription>
              Give your template a name. You'll add sections and items on the next screen.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Template name..."
            value={newTemplateName}
            onChange={(e) => setNewTemplateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newTemplateName.trim() && !createTemplate.isPending) {
                createTemplate.mutate();
              }
            }}
            autoFocus
            data-testid="input-new-template-name"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setCreateOpen(false); setNewTemplateName(""); }}
              disabled={createTemplate.isPending}
              data-testid="button-new-template-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => createTemplate.mutate()}
              disabled={!newTemplateName.trim() || createTemplate.isPending}
              data-testid="button-new-template-create"
            >
              {createTemplate.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent data-testid="dialog-delete-template">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this template?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteTarget?.title}" will be permanently deleted. Project checklists already created from this template are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-template-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTarget) deleteTemplate.mutate(deleteTarget.id); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-delete-template-confirm"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
