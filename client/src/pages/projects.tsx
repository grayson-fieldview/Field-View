import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { useLocation } from "wouter";
import {
  Plus,
  Search,
  FolderKanban,
  MapPin,
  Calendar,
  Camera,
  ClipboardList,
} from "lucide-react";
import type { Project } from "@shared/schema";
import { insertProjectSchema } from "@shared/schema";
import { z } from "zod";

const createProjectSchema = insertProjectSchema.extend({
  name: z.string().min(1, "Project name is required"),
});

const statusColors: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  completed: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  on_hold: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  archived: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400",
};

const statusLabels: Record<string, string> = {
  active: "Active",
  completed: "Completed",
  on_hold: "On Hold",
  archived: "Archived",
};

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: projects, isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  const form = useForm({
    resolver: zodResolver(createProjectSchema),
    defaultValues: {
      name: "",
      description: "",
      status: "active" as const,
      address: "",
      latitude: null as number | null,
      longitude: null as number | null,
      color: "#3B82F6",
    },
  });

  const createProject = useMutation({
    mutationFn: async (data: z.infer<typeof createProjectSchema>) => {
      const res = await apiRequest("POST", "/api/projects", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Project created", description: "Your new project is ready." });
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", description: "Logging in again...", variant: "destructive" });
        setTimeout(() => { window.location.href = "/api/login"; }, 500);
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const filtered = (projects || []).filter((p) => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description || "").toLowerCase().includes(search.toLowerCase()) ||
      (p.address || "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const stats = {
    total: projects?.length || 0,
    active: projects?.filter((p) => p.status === "active").length || 0,
    completed: projects?.filter((p) => p.status === "completed").length || 0,
  };

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-projects-title">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your field projects and job sites</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-project">
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Create New Project</DialogTitle>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit((d) => createProject.mutate(d))} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Project Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g., Downtown Office Renovation" {...field} data-testid="input-project-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="description"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Brief description of the project..."
                          {...field}
                          value={field.value || ""}
                          data-testid="input-project-description"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="123 Main St, City, State"
                          {...field}
                          value={field.value || ""}
                          data-testid="input-project-address"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="latitude"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Latitude</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="any"
                            placeholder="40.7128"
                            {...field}
                            value={field.value ?? ""}
                            onChange={(e) => field.onChange(e.target.value ? parseFloat(e.target.value) : null)}
                            data-testid="input-project-lat"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="longitude"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Longitude</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            step="any"
                            placeholder="-74.0060"
                            {...field}
                            value={field.value ?? ""}
                            onChange={(e) => field.onChange(e.target.value ? parseFloat(e.target.value) : null)}
                            data-testid="input-project-lng"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="color"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Color</FormLabel>
                      <FormControl>
                        <div className="flex items-center gap-3">
                          <input
                            type="color"
                            {...field}
                            value={field.value || "#3B82F6"}
                            className="h-9 w-12 rounded-md border cursor-pointer"
                            data-testid="input-project-color"
                          />
                          <span className="text-sm text-muted-foreground">{field.value}</span>
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" className="w-full" disabled={createProject.isPending} data-testid="button-submit-project">
                  {createProject.isPending ? "Creating..." : "Create Project"}
                </Button>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
              <FolderKanban className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold" data-testid="text-stat-total">{stats.total}</p>
              <p className="text-xs text-muted-foreground">Total Projects</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-green-500/10 text-green-600 dark:text-green-400">
              <Camera className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold" data-testid="text-stat-active">{stats.active}</p>
              <p className="text-xs text-muted-foreground">Active Projects</p>
            </div>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <ClipboardList className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold" data-testid="text-stat-completed">{stats.completed}</p>
              <p className="text-xs text-muted-foreground">Completed</p>
            </div>
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
            data-testid="input-search-projects"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]" data-testid="select-status-filter">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="on_hold">On Hold</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="p-5">
              <div className="space-y-3">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-1/2" />
                <div className="flex gap-2 pt-2">
                  <Skeleton className="h-6 w-16" />
                  <Skeleton className="h-6 w-20" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-12">
          <div className="text-center space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
              <FolderKanban className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold" data-testid="text-no-projects">No projects found</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              {search || statusFilter !== "all"
                ? "Try adjusting your search or filter criteria."
                : "Create your first project to start documenting your field work."}
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((project) => (
            <Card
              key={project.id}
              className="p-5 cursor-pointer hover-elevate transition-all duration-200"
              onClick={() => navigate(`/projects/${project.id}`)}
              data-testid={`card-project-${project.id}`}
            >
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: project.color || "#3B82F6" }}
                    />
                    <h3 className="font-semibold truncate">{project.name}</h3>
                  </div>
                  <Badge variant="secondary" className={`shrink-0 text-xs no-default-hover-elevate no-default-active-elevate ${statusColors[project.status]}`}>
                    {statusLabels[project.status]}
                  </Badge>
                </div>

                {project.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">{project.description}</p>
                )}

                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground pt-1">
                  {project.address && (
                    <span className="flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      <span className="truncate max-w-[150px]">{project.address}</span>
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {new Date(project.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
