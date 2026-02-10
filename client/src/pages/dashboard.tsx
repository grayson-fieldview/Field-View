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

  const kpiItems = [
    { label: "Active Projects", value: stats?.activeProjects, icon: FolderKanban, href: "/projects" },
    { label: "Total Photos", value: stats?.totalPhotos, icon: Camera, href: "/photos" },
    { label: "Open Tasks", value: stats?.openTasks, icon: ClipboardList, href: "/tasks" },
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
          <Card
            key={kpi.label}
            className="cursor-pointer hover-elevate transition-all"
            onClick={() => navigate(kpi.href)}
            data-testid={`card-kpi-${kpi.label.toLowerCase().replace(/\s+/g, "-")}`}
          >
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
                onClick={() => navigate("/projects")}
                data-testid="button-quick-view-projects"
              >
                <FolderKanban className="h-4 w-4 mr-2" />
                View All Projects
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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
          <CardTitle className="text-lg">Recent Projects</CardTitle>
          <Button variant="ghost" asChild data-testid="link-view-all-projects">
            <Link href="/projects">
              View All
              <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {projectsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-md shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : (projects || []).length === 0 ? (
            <div className="text-center py-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted mx-auto mb-2">
                <FolderKanban className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">No projects yet</p>
            </div>
          ) : (
            <div className="space-y-1">
              {(projects || []).filter(p => p.status === "active").slice(0, 5).map((project) => (
                <div
                  key={project.id}
                  className="flex items-center gap-3 p-2 rounded-md cursor-pointer hover-elevate"
                  onClick={() => navigate(`/projects/${project.id}`)}
                  data-testid={`card-project-${project.id}`}
                >
                  <div className="h-10 w-10 rounded-md overflow-hidden shrink-0 bg-muted flex items-center justify-center">
                    {project.recentPhotos.length > 0 ? (
                      <img src={project.recentPhotos[0].url} alt={project.name} className="w-full h-full object-cover" />
                    ) : (
                      <ImageIcon className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium truncate" data-testid={`text-project-name-${project.id}`}>{project.name}</h3>
                    <p className="text-xs text-muted-foreground truncate">{project.address || "No address"}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-muted-foreground">{project.photoCount} photos</span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
