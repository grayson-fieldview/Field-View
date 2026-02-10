import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useLocation, Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import {
  FolderKanban,
  Camera,
  ClipboardList,
  MessageSquare,
  Search,
  Plus,
  Image as ImageIcon,
  ArrowRight,
} from "lucide-react";
import type { Project } from "@shared/schema";
import { insertProjectSchema } from "@shared/schema";
import { z } from "zod";
import { AddressAutocomplete } from "@/components/address-autocomplete";

interface ActivityItem {
  type: "photo" | "task" | "comment";
  id: number;
  timestamp: string;
  userName: string;
  userImage: string | null;
  projectName: string | null;
  projectId: number | null;
  detail: string;
  extra?: { url?: string; status?: string; priority?: string; mediaId?: number };
}

interface ActivityResponse {
  activities: ActivityItem[];
  stats: {
    activeProjects: number;
    totalPhotos: number;
    openTasks: number;
  };
}

interface ProjectWithDetails extends Project {
  photoCount: number;
  recentPhotos: { id: number; url: string }[];
  recentUsers: { firstName: string | null; lastName: string | null; profileImageUrl: string | null }[];
}

const createProjectSchema = insertProjectSchema.extend({
  name: z.string().min(1, "Project name is required"),
});

type FilterTab = "all" | "active" | "completed" | "archived";

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  return `${diffMon}mo ago`;
}

function getInitials(firstName: string | null, lastName: string | null) {
  return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
}

function getInitialsFromName(name: string) {
  const parts = name.trim().split(/\s+/);
  return `${(parts[0] || "")[0] || ""}${(parts[1] || "")[0] || ""}`.toUpperCase() || "U";
}

const activityConfig = {
  photo: { icon: Camera, colorClass: "text-orange-500" },
  task: { icon: ClipboardList, colorClass: "text-blue-500" },
  comment: { icon: MessageSquare, colorClass: "text-green-500" },
} as const;

export default function DashboardPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: activityData, isLoading: activityLoading } = useQuery<ActivityResponse>({
    queryKey: ["/api/activity"],
  });

  const { data: projects, isLoading: projectsLoading } = useQuery<ProjectWithDetails[]>({
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
      color: "#F09000",
    },
  });

  const handleAddressSelect = useCallback((result: { address: string; latitude: number; longitude: number }) => {
    form.setValue("address", result.address);
    form.setValue("latitude", result.latitude);
    form.setValue("longitude", result.longitude);
  }, [form]);

  const handleAddressTextChange = useCallback((text: string) => {
    form.setValue("address", text);
    form.setValue("latitude", null);
    form.setValue("longitude", null);
  }, [form]);

  const createProject = useMutation({
    mutationFn: async (data: z.infer<typeof createProjectSchema>) => {
      const res = await apiRequest("POST", "/api/projects", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
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

  const stats = activityData?.stats;
  const activities = activityData?.activities || [];
  const recentPhotos = activities.filter((a) => a.type === "photo" && a.extra?.url).slice(0, 6);

  const filtered = (projects || []).filter((p) => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description || "").toLowerCase().includes(search.toLowerCase()) ||
      (p.address || "").toLowerCase().includes(search.toLowerCase());
    const matchesTab = activeTab === "all" || p.status === activeTab;
    return matchesSearch && matchesTab;
  });

  const formatDate = (date: string | Date) => {
    const d = new Date(date);
    return `Last updated ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  };

  const tabs: { key: FilterTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "active", label: "Active" },
    { key: "completed", label: "Completed" },
    { key: "archived", label: "Archived" },
  ];

  const kpiItems = [
    { label: "Active Projects", value: stats?.activeProjects, icon: FolderKanban },
    { label: "Total Photos", value: stats?.totalPhotos, icon: Camera },
    { label: "Open Tasks", value: stats?.openTasks, icon: ClipboardList },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight" data-testid="text-dashboard-title">
            Welcome back{user?.firstName ? `, ${user.firstName}` : ""}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Your command center overview</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-project-header">
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest(".pac-container")) {
              e.preventDefault();
            }
          }}>
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
                        <AddressAutocomplete
                          value={field.value || ""}
                          onChange={handleAddressSelect}
                          onTextChange={handleAddressTextChange}
                          placeholder="Search for an address..."
                          data-testid="input-project-address"
                        />
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
        {kpiItems.map((kpi) => (
          <Card key={kpi.label} data-testid={`card-kpi-${kpi.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{kpi.label}</CardTitle>
              <kpi.icon className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              {activityLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <p className="text-3xl font-bold" data-testid={`text-kpi-${kpi.label.toLowerCase().replace(/\s+/g, "-")}`}>
                  {kpi.value ?? 0}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {activityLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex items-start gap-3">
                      <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-20" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : activities.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm text-muted-foreground">No recent activity</p>
                </div>
              ) : (
                <div className="space-y-1 max-h-[400px] overflow-y-auto pr-1">
                  {activities.map((activity) => {
                    const config = activityConfig[activity.type];
                    const Icon = config.icon;
                    return (
                      <div
                        key={`${activity.type}-${activity.id}`}
                        className="flex items-start gap-3 p-2 rounded-md"
                        data-testid={`activity-item-${activity.type}-${activity.id}`}
                      >
                        <Avatar className="h-8 w-8 shrink-0">
                          <AvatarImage src={activity.userImage || undefined} />
                          <AvatarFallback className="text-[10px] bg-primary/10 text-primary">
                            {getInitialsFromName(activity.userName)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm leading-snug">
                            <span className="font-medium">{activity.userName}</span>{" "}
                            <span className="text-muted-foreground">{activity.detail}</span>
                            {activity.projectName && (
                              <span className="text-muted-foreground">
                                {" "}in{" "}
                                <Link
                                  href={`/projects/${activity.projectId}`}
                                  className="font-medium text-foreground"
                                  data-testid={`link-activity-project-${activity.id}`}
                                >
                                  {activity.projectName}
                                </Link>
                              </span>
                            )}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Icon className={`h-3 w-3 ${config.colorClass}`} />
                            <span className="text-xs text-muted-foreground">{relativeTime(activity.timestamp)}</span>
                          </div>
                        </div>
                        {activity.type === "photo" && activity.extra?.url && (
                          <div className="h-10 w-14 rounded-md overflow-hidden shrink-0 bg-muted">
                            <img
                              src={activity.extra.url}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Recent Photos</CardTitle>
            </CardHeader>
            <CardContent>
              {activityLoading ? (
                <div className="grid grid-cols-2 gap-2">
                  {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="aspect-square rounded-md" />
                  ))}
                </div>
              ) : recentPhotos.length === 0 ? (
                <div className="text-center py-8">
                  <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted mx-auto mb-2">
                    <Camera className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">No photos yet</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {recentPhotos.map((photo) => (
                    <div
                      key={photo.id}
                      className="aspect-square rounded-md overflow-hidden bg-muted"
                      data-testid={`photo-thumb-${photo.id}`}
                    >
                      <img
                        src={photo.extra!.url!}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => setDialogOpen(true)}
                data-testid="button-quick-new-project"
              >
                <Plus className="h-4 w-4 mr-2" />
                New Project
              </Button>
              <Button
                className="w-full justify-start"
                variant="outline"
                onClick={() => navigate("/photos")}
                data-testid="button-quick-view-photos"
              >
                <Camera className="h-4 w-4 mr-2" />
                View All Photos
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-xl font-bold tracking-tight" data-testid="text-projects-section-title">Projects</h2>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Find a project..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
              data-testid="input-search-projects"
            />
          </div>
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                activeTab === tab.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover-elevate"
              }`}
              data-testid={`tab-filter-${tab.key}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {projectsLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 p-4 border rounded-md">
                <Skeleton className="h-16 w-16 rounded-md shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-4 w-72" />
                </div>
                <div className="hidden md:flex gap-2">
                  <Skeleton className="h-16 w-20 rounded-md" />
                  <Skeleton className="h-16 w-20 rounded-md" />
                  <Skeleton className="h-16 w-20 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="border rounded-md p-12">
            <div className="text-center space-y-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                <FolderKanban className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold" data-testid="text-no-projects">No projects found</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                {search || activeTab !== "all"
                  ? "Try adjusting your search or filter criteria."
                  : "Create your first project to start documenting your field work."}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((project) => (
              <div
                key={project.id}
                className="flex items-center gap-4 p-3 sm:p-4 border rounded-md cursor-pointer hover-elevate transition-all bg-card"
                onClick={() => navigate(`/projects/${project.id}`)}
                data-testid={`card-project-${project.id}`}
              >
                <div className="h-14 w-14 sm:h-16 sm:w-16 rounded-md overflow-hidden shrink-0 bg-muted flex items-center justify-center">
                  {project.recentPhotos.length > 0 ? (
                    <img
                      src={project.recentPhotos[0].url}
                      alt={project.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-0.5">
                  <h3 className="font-semibold text-sm sm:text-base truncate" data-testid={`text-project-name-${project.id}`}>
                    {project.name}
                  </h3>
                  <p className="text-xs sm:text-sm text-muted-foreground truncate">
                    {project.address || "No address"}
                  </p>
                  <p className="text-xs text-muted-foreground/70">
                    {formatDate(project.updatedAt)}
                  </p>
                </div>

                <div className="hidden sm:flex items-center gap-6 shrink-0">
                  <div className="text-center min-w-[50px]">
                    <p className="text-xs text-muted-foreground">Photos</p>
                    <p className="text-lg font-bold" data-testid={`text-photo-count-${project.id}`}>
                      {project.photoCount}
                    </p>
                  </div>

                  <div className="text-center min-w-[70px]">
                    <p className="text-xs text-muted-foreground mb-1">Recent Users</p>
                    <div className="flex items-center justify-center gap-0.5">
                      {project.recentUsers.length > 0 ? (
                        project.recentUsers.map((u, i) => (
                          <Avatar key={i} className="h-6 w-6 border-2 border-card">
                            <AvatarImage src={u.profileImageUrl || undefined} />
                            <AvatarFallback className="text-[9px] bg-primary/10 text-primary">
                              {getInitials(u.firstName, u.lastName)}
                            </AvatarFallback>
                          </Avatar>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground/50">--</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="hidden lg:flex items-center gap-1.5 shrink-0">
                  {project.recentPhotos.slice(0, 4).map((photo) => (
                    <div key={photo.id} className="h-16 w-20 rounded-md overflow-hidden bg-muted">
                      <img
                        src={photo.url}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ))}
                  {project.recentPhotos.length === 0 && (
                    <div className="h-16 w-20 rounded-md bg-muted flex items-center justify-center">
                      <ImageIcon className="h-4 w-4 text-muted-foreground/40" />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
