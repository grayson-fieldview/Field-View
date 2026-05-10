import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import type { Project, Report } from "@shared/schema";

interface ReportFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: number;
}

const PROJECT_UNSET = "__unset__";
const MAX_DESCRIPTION = 2000;

export default function ReportFormDialog({ open, onOpenChange, projectId }: ReportFormDialogProps) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const isGlobalMode = projectId === undefined;

  const [selectedProjectId, setSelectedProjectId] = useState<string>(PROJECT_UNSET);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open) {
      setSelectedProjectId(PROJECT_UNSET);
      setTitle("");
      setDescription("");
    }
  }, [open]);

  const projectsQuery = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    enabled: open && isGlobalMode,
  });

  const createReport = useMutation({
    mutationFn: async () => {
      const effectiveProjectId = isGlobalMode ? Number(selectedProjectId) : projectId!;
      const body: Record<string, any> = { title: title.trim() };
      if (description.trim()) body.description = description.trim();
      const res = await apiRequest("POST", `/api/projects/${effectiveProjectId}/reports`, body);
      return (await res.json()) as Report;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports"] });
      const effectiveProjectId = isGlobalMode ? Number(selectedProjectId) : projectId!;
      queryClient.invalidateQueries({ queryKey: ["/api/projects", effectiveProjectId] });
      toast({ title: "Report created" });
      onOpenChange(false);
      navigate(`/reports/${created.id}/edit`);
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Failed to create report", description: error.message, variant: "destructive" });
    },
  });

  const titleValid = title.trim().length > 0;
  const projectValid = !isGlobalMode || selectedProjectId !== PROJECT_UNSET;
  const descriptionValid = description.length <= MAX_DESCRIPTION;
  const hasNoProjects = isGlobalMode && projectsQuery.data?.length === 0;
  const canSubmit = titleValid && projectValid && descriptionValid && !hasNoProjects && !createReport.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    createReport.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create report</DialogTitle>
          <DialogDescription>
            Create a draft and you'll be taken to the editor to add sections, photos, and a cover page.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isGlobalMode && (
            <div className="space-y-1.5">
              <Label htmlFor="report-project">Project</Label>
              {hasNoProjects ? (
                <p className="text-sm text-muted-foreground" data-testid="text-no-projects-warning">
                  You don't have any projects yet.{" "}
                  <Link href="/projects" className="text-primary underline" data-testid="link-create-project">
                    Create one first.
                  </Link>
                </p>
              ) : (
                <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                  <SelectTrigger id="report-project" data-testid="select-report-project">
                    <SelectValue placeholder={projectsQuery.isLoading ? "Loading…" : "Select a project"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(projectsQuery.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="report-title">Title</Label>
            <Input
              id="report-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Site visit — Oct 14"
              autoFocus
              required
              maxLength={200}
              data-testid="input-report-title"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="report-description">Description</Label>
            <Textarea
              id="report-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional summary shown on the cover page"
              rows={3}
              maxLength={MAX_DESCRIPTION}
              data-testid="input-report-description"
            />
            <p className="text-xs text-muted-foreground text-right">
              {description.length}/{MAX_DESCRIPTION}
            </p>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createReport.isPending}
              data-testid="button-cancel-report"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              data-testid="button-submit-report"
            >
              {createReport.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create report
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
