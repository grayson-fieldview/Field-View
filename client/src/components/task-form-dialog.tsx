import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
}

const ASSIGNEE_NONE = "__none__";
const PROJECT_UNSET = "__unset__";

export default function TaskFormDialog({ open, onOpenChange, projectId }: TaskFormDialogProps) {
  const { toast } = useToast();
  const isGlobalMode = projectId === undefined;

  const [selectedProjectId, setSelectedProjectId] = useState<string>(PROJECT_UNSET);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [assigneeId, setAssigneeId] = useState<string>(ASSIGNEE_NONE);
  const [dueDate, setDueDate] = useState<string>("");

  useEffect(() => {
    if (open) {
      setSelectedProjectId(PROJECT_UNSET);
      setTitle("");
      setDescription("");
      setPriority("medium");
      setAssigneeId(ASSIGNEE_NONE);
      setDueDate("");
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
      <DialogContent className="sm:max-w-md">
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
      </DialogContent>
    </Dialog>
  );
}
