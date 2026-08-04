import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
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
import { useAuth } from "@/hooks/use-auth";
import type { Project } from "@shared/schema";

type AccountUser = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: number;
  /**
   * Optional z-index overrides for when this dialog must stack above a
   * high-z surface (e.g. the photo viewer's z-[100] overlay). BOTH must be
   * raised together — raising only the content leaves the backdrop under
   * the surface, so click-outside hits the surface instead of the dialog.
   */
  overlayClassName?: string;
  contentClassName?: string;
}

const ASSIGNEE_NONE = "__none__";
const PROJECT_UNSET = "__unset__";

export default function TaskFormDialog({ open, onOpenChange, projectId, overlayClassName, contentClassName }: TaskFormDialogProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const isGlobalMode = projectId === undefined;
  // The photo-requirement input renders only for admins (server enforces
  // the same admin-only gate; this is UI gating).
  const canSetPhotoRequirement = (user as any)?.role === "admin";

  const [selectedProjectId, setSelectedProjectId] = useState<string>(PROJECT_UNSET);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [assigneeId, setAssigneeId] = useState<string>(ASSIGNEE_NONE);
  const [dueDate, setDueDate] = useState<string>("");
  const [requiredPhotoCount, setRequiredPhotoCount] = useState<string>("0");

  useEffect(() => {
    if (open) {
      setSelectedProjectId(PROJECT_UNSET);
      setTitle("");
      setDescription("");
      setPriority("medium");
      setAssigneeId(ASSIGNEE_NONE);
      setDueDate("");
      setRequiredPhotoCount("0");
    }
  }, [open]);

  const projectsQuery = useQuery<Project[]>({
    queryKey: ["/api/projects"],
    enabled: open && isGlobalMode,
  });

  // When mounted with a fixed projectId (project-detail's Tasks tab), filter
  // the assignee list to users assignable for that project — restricted users
  // not in project_assignments are dropped server-side. In global mode (the
  // /tasks page picker), we don't know the project until the user picks one,
  // so we intentionally fetch the unfiltered list. Live-refilter on the
  // in-dialog project change is future polish; out of scope here.
  const usersQuery = useQuery<AccountUser[]>({
    queryKey: projectId !== undefined
      ? ["/api/users", { assignableForProjectId: projectId }]
      : ["/api/users"],
    queryFn: async () => {
      const url = projectId !== undefined
        ? `/api/users?assignableForProjectId=${projectId}`
        : "/api/users";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: open,
  });

  const createTask = useMutation({
    mutationFn: async () => {
      const effectiveProjectId = isGlobalMode ? Number(selectedProjectId) : projectId!;
      const body: Record<string, any> = {
        title: title.trim(),
        priority,
      };
      if (description.trim()) body.description = description.trim();
      if (assigneeId !== ASSIGNEE_NONE) body.assignedToId = assigneeId;
      if (dueDate) body.dueDate = new Date(dueDate).toISOString();
      if (canSetPhotoRequirement) {
        const n = parseInt(requiredPhotoCount, 10);
        if (Number.isInteger(n) && n > 0) body.requiredPhotoCount = n;
      }
      const res = await apiRequest("POST", `/api/projects/${effectiveProjectId}/tasks`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
      const effectiveProjectId = isGlobalMode ? Number(selectedProjectId) : projectId!;
      queryClient.invalidateQueries({ queryKey: ["/api/projects", effectiveProjectId] });
      toast({ title: "Task added" });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Failed to create task", description: error.message, variant: "destructive" });
    },
  });

  const titleValid = title.trim().length > 0;
  const projectValid = !isGlobalMode || selectedProjectId !== PROJECT_UNSET;
  const canSubmit = titleValid && projectValid && !createTask.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    createTask.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Composed inline (instead of ui/dialog's DialogContent, which hardcodes
          its own z-50 overlay) so overlayClassName/contentClassName can raise
          BOTH layers above high-z surfaces like the photo viewer. Classes below
          mirror ui/dialog.tsx's DialogOverlay/DialogContent exactly. */}
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
            "sm:max-w-md",
            contentClassName,
          )}
        >
        <DialogHeader>
          <DialogTitle>Add task</DialogTitle>
          <DialogDescription>
            Create a new task{isGlobalMode ? " in any project" : ""}. Only the title is required.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isGlobalMode && (
            <div className="space-y-1.5">
              <Label htmlFor="task-project">Project</Label>
              <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                <SelectTrigger id="task-project" data-testid="select-task-project">
                  <SelectValue placeholder={projectsQuery.isLoading ? "Loading…" : "Select a project"} />
                </SelectTrigger>
                <SelectContent>
                  {(projectsQuery.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              autoFocus
              required
              data-testid="input-task-title"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-description">Description</Label>
            <Textarea
              id="task-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details"
              rows={3}
              data-testid="input-task-description"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-priority">Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger id="task-priority" data-testid="select-task-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-due-date">Due date</Label>
              <Input
                id="task-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                data-testid="input-task-due-date"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="task-assignee">Assignee</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger id="task-assignee" data-testid="select-task-assignee">
                <SelectValue placeholder={usersQuery.isLoading ? "Loading…" : "Unassigned"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ASSIGNEE_NONE}>Unassigned</SelectItem>
                {(usersQuery.data ?? []).map((u) => {
                  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || u.id;
                  return (
                    <SelectItem key={u.id} value={u.id}>{name}</SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          {canSetPhotoRequirement && (
            <div className="space-y-1.5">
              <Label htmlFor="task-required-photos">Required photos to complete</Label>
              <Input
                id="task-required-photos"
                type="number"
                min={0}
                max={100}
                value={requiredPhotoCount}
                onChange={(e) => setRequiredPhotoCount(e.target.value)}
                data-testid="input-task-required-photos"
              />
              <p className="text-xs text-muted-foreground">
                0 = no requirement. The task can't be marked done until this many photos are attached.
              </p>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createTask.isPending}
              data-testid="button-cancel-task"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              data-testid="button-submit-task"
            >
              {createTask.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add task
            </Button>
          </DialogFooter>
        </form>
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
