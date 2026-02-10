import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  ClipboardList,
  FolderKanban,
  Calendar,
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock,
} from "lucide-react";
import type { Task, Project } from "@shared/schema";

type TaskWithDetails = Task & {
  project?: { name: string };
  assignedTo?: { firstName: string | null; lastName: string | null };
};

type FilterStatus = "all" | "todo" | "in_progress" | "done";

const statusConfig: Record<string, { label: string; icon: typeof Circle; colorClass: string; badgeVariant: "default" | "secondary" | "outline" }> = {
  todo: { label: "To Do", icon: Circle, colorClass: "text-muted-foreground", badgeVariant: "outline" },
  in_progress: { label: "In Progress", icon: Clock, colorClass: "text-primary", badgeVariant: "secondary" },
  done: { label: "Done", icon: CheckCircle2, colorClass: "text-primary", badgeVariant: "default" },
};

const priorityLabels: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  low: { label: "Low", variant: "outline" },
  medium: { label: "Medium", variant: "secondary" },
  high: { label: "High", variant: "destructive" },
  urgent: { label: "Urgent", variant: "destructive" },
};

export default function TasksPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [, navigate] = useLocation();

  const { data: allTasks, isLoading } = useQuery<TaskWithDetails[]>({
    queryKey: ["/api/tasks"],
  });

  const { data: projects } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const updateTask = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      await apiRequest("PATCH", `/api/tasks/${id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
    },
  });

  const filtered = (allTasks || []).filter((t) => {
    const matchesSearch =
      t.title.toLowerCase().includes(search.toLowerCase()) ||
      (t.description || "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || t.status === statusFilter;
    const matchesProject = projectFilter === "all" || t.projectId.toString() === projectFilter;
    return matchesSearch && matchesStatus && matchesProject;
  });

  const statusTabs: { key: FilterStatus; label: string; count: number }[] = [
    { key: "all", label: "All", count: (allTasks || []).length },
    { key: "todo", label: "To Do", count: (allTasks || []).filter(t => t.status === "todo").length },
    { key: "in_progress", label: "In Progress", count: (allTasks || []).filter(t => t.status === "in_progress").length },
    { key: "done", label: "Done", count: (allTasks || []).filter(t => t.status === "done").length },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-tasks-title">Tasks</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage tasks across all projects</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search tasks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="input-search-tasks"
          />
        </div>
        <Select value={projectFilter} onValueChange={setProjectFilter}>
          <SelectTrigger className="w-[180px]" data-testid="select-task-project-filter">
            <SelectValue placeholder="All Projects" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Projects</SelectItem>
            {(projects || []).map((p) => (
              <SelectItem key={p.id} value={p.id.toString()}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {statusTabs.map((tab) => (
          <Button
            key={tab.key}
            variant={statusFilter === tab.key ? "default" : "ghost"}
            onClick={() => setStatusFilter(tab.key)}
            data-testid={`tab-tasks-${tab.key}`}
          >
            {tab.label} ({tab.count})
          </Button>
        ))}
      </div>

      <div className="text-sm text-muted-foreground">
        {filtered.length} task{filtered.length !== 1 ? "s" : ""} found
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3 p-3 border rounded-md">
              <Skeleton className="h-5 w-5 rounded-full shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-6 w-20 rounded-md" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-12">
          <div className="text-center space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
              <ClipboardList className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold" data-testid="text-no-tasks">No tasks found</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {search || statusFilter !== "all" || projectFilter !== "all"
                ? "Try adjusting your search or filters."
                : "Create tasks in your projects to see them here."}
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-1">
          {filtered.map((task) => {
            const config = statusConfig[task.status] || statusConfig.todo;
            const StatusIcon = config.icon;
            return (
              <div
                key={task.id}
                className="flex items-center gap-3 p-3 border rounded-md bg-card hover-elevate cursor-pointer"
                onClick={() => navigate(`/projects/${task.projectId}`)}
                data-testid={`card-task-${task.id}`}
              >
                <Button
                  size="icon"
                  variant="ghost"
                  className={config.colorClass}
                  onClick={(e) => {
                    e.stopPropagation();
                    const nextStatus = task.status === "todo" ? "in_progress" : task.status === "in_progress" ? "done" : "todo";
                    updateTask.mutate({ id: task.id, status: nextStatus });
                  }}
                  data-testid={`button-toggle-task-${task.id}`}
                >
                  <StatusIcon className="h-5 w-5" />
                </Button>

                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${task.status === "done" ? "line-through text-muted-foreground" : ""}`} data-testid={`text-task-title-${task.id}`}>
                    {task.title}
                  </p>
                  <div className="flex items-center gap-2 flex-wrap mt-0.5">
                    {task.project && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <FolderKanban className="h-3 w-3" />
                        {task.project.name}
                      </span>
                    )}
                    {task.assignedTo && (
                      <span className="text-xs text-muted-foreground">
                        {task.assignedTo.firstName} {task.assignedTo.lastName}
                      </span>
                    )}
                    {task.dueDate && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {new Date(task.dueDate).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>

                <Badge variant={config.badgeVariant} className="shrink-0 text-xs" data-testid={`badge-task-status-${task.id}`}>
                  {config.label}
                </Badge>

                <Badge variant={priorityLabels[task.priority]?.variant || "outline"} className="shrink-0 text-xs" data-testid={`badge-task-priority-${task.id}`}>
                  {priorityLabels[task.priority]?.label || task.priority}
                </Badge>

                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
