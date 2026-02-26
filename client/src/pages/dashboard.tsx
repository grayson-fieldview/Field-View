import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { useLocation, Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  AlertTriangle,
  MapPin,
  Clock,
} from "lucide-react";
import type { Project } from "@shared/schema";
import { insertProjectSchema } from "@shared/schema";
import { z } from "zod";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface ActivityItem {
  type: "photo" | "task" | "comment";
  id: number;
  timestamp: string;
  userName: string;
  userImage: string | null;
  projectName: string | null;
  projectId: number | null;
  detail: string;
  extra?: { url?: string; status?: string; priority?: string; mediaId?: number; dueDate?: string | null };
}

interface ActivityResponse {
  activities: ActivityItem[];
  stats: {
    activeProjects: number;
    totalPhotos: number;
    openTasks: number;
    overdueTasks: number;
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

function formatDueDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.ceil((date.getTime() - now.getTime()) / 86400000);
  if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
  if (diffDays === 0) return "Due today";
  if (diffDays === 1) return "Due tomorrow";
  return `Due in ${diffDays}d`;
}

function getInitialsFromName(name: string) {
  const parts = name.trim().split(/\s+/);
  return `${(parts[0] || "")[0] || ""}${(parts[1] || "")[0] || ""}`.toUpperCase() || "U";
}

const activityConfig = {
  photo: { icon: Camera, label: "uploaded a photo" },
  task: { icon: ClipboardList, label: "updated a task" },
  comment: { icon: MessageSquare, label: "left a comment" },
} as const;

const taskStatusBadge: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  todo: { label: "To Do", variant: "outline" },
  in_progress: { label: "In Progress", variant: "secondary" },
  done: { label: "Done", variant: "default" },
};

const priorityBadge: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  low: { label: "Low", variant: "outline" },
  medium: { label: "Medium", variant: "secondary" },
  high: { label: "High", variant: "destructive" },
  urgent: { label: "Urgent", variant: "destructive" },
};

function MiniMap({ projects }: { projects: ProjectWithDetails[] }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  const geoProjects = projects.filter(p => p.latitude && p.longitude && p.status === "active");
  const mapKey = JSON.stringify(geoProjects.map(p => ({ id: p.id, lat: p.latitude, lng: p.longitude })));

  useEffect(() => {
    if (!mapRef.current || geoProjects.length === 0) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const map = L.map(mapRef.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

    const orangeIcon = L.divIcon({
      className: "",
      html: `<div style="width:14px;height:14px;background:#F09000;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.3);"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });

    const bounds = L.latLngBounds([]);
    geoProjects.forEach(p => {
      const latLng = L.latLng(p.latitude!, p.longitude!);
      bounds.extend(latLng);
      L.marker(latLng, { icon: orangeIcon })
        .bindTooltip(p.name, { direction: "top", offset: [0, -8] })
        .addTo(map);
    });

    map.fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
    mapInstanceRef.current = map;

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [mapKey]);

  if (geoProjects.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <MapPin className="h-5 w-5 mx-auto mb-1 opacity-50" />
          <p className="text-xs">No geolocated projects</p>
        </div>
      </div>
    );
  }

  return <div ref={mapRef} className="w-full h-full rounded-md" />;
}

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
        setTimeout(() => { window.location.href = "/login"; }, 500);
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
          <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-dashboard-tagline">
            Your Field Command Center &mdash; Photos, Tasks, Maps & Insights in One View
          </p>
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

      {!activityLoading && stats && stats.overdueTasks > 0 && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-md bg-destructive/10 border border-destructive/20 cursor-pointer"
          onClick={() => navigate("/tasks")}
          data-testid="banner-overdue-tasks"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            <span className="text-sm font-medium">
              {stats.overdueTasks} overdue task{stats.overdueTasks !== 1 ? "s" : ""} need attention
            </span>
          </div>
          <Button variant="outline" size="sm" data-testid="button-view-overdue">
            View Tasks
            <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      )}

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
                    const isTask = activity.type === "task";
                    const taskStatus = isTask ? activity.extra?.status : null;
                    const taskPriority = isTask ? activity.extra?.priority : null;
                    const taskDueDate = isTask ? (activity.extra as any)?.dueDate : null;
                    const isOverdue = taskDueDate && taskStatus !== "done" && new Date(taskDueDate) < new Date();

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
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <div className="flex items-center gap-1">
                              <Icon className="h-3 w-3 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground">{relativeTime(activity.timestamp)}</span>
                            </div>
                            {isTask && taskStatus && (
                              <Badge variant={taskStatusBadge[taskStatus]?.variant || "outline"} className="text-[10px]" data-testid={`badge-activity-status-${activity.id}`}>
                                {taskStatusBadge[taskStatus]?.label || taskStatus}
                              </Badge>
                            )}
                            {isTask && taskPriority && taskPriority !== "medium" && (
                              <Badge variant={priorityBadge[taskPriority]?.variant || "outline"} className="text-[10px]" data-testid={`badge-activity-priority-${activity.id}`}>
                                {priorityBadge[taskPriority]?.label || taskPriority}
                              </Badge>
                            )}
                            {isTask && taskDueDate && (
                              <span className={`text-[10px] flex items-center gap-0.5 ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`} data-testid={`text-activity-due-${activity.id}`}>
                                <Clock className="h-2.5 w-2.5" />
                                {formatDueDate(taskDueDate)}
                              </span>
                            )}
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
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
              <CardTitle className="text-lg">Project Locations</CardTitle>
              <Button variant="ghost" size="sm" asChild data-testid="link-view-map">
                <Link href="/map">
                  <MapPin className="h-3.5 w-3.5 mr-1" />
                  Full Map
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              <div className="h-[200px] rounded-md overflow-hidden bg-muted" data-testid="dashboard-mini-map">
                {projectsLoading ? (
                  <Skeleton className="w-full h-full" />
                ) : (
                  <MiniMap projects={projects || []} />
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Recent Photos</CardTitle>
            </CardHeader>
            <CardContent>
              {activityLoading ? (
                <div className="grid grid-cols-3 gap-2">
                  {[1, 2, 3, 4, 5, 6].map((i) => (
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
                <div className="grid grid-cols-3 gap-2">
                  {recentPhotos.map((photo) => (
                    <div
                      key={photo.id}
                      className="relative group aspect-square rounded-md overflow-hidden bg-muted cursor-pointer"
                      onClick={() => photo.projectId && navigate(`/projects/${photo.projectId}`)}
                      data-testid={`photo-thumb-${photo.id}`}
                    >
                      <img
                        src={photo.extra!.url!}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-colors flex flex-col items-center justify-center" style={{ visibility: "visible" }}>
                        <span className="text-white text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity text-center px-1 truncate max-w-full" data-testid={`text-photo-project-${photo.id}`}>
                          {photo.projectName || ""}
                        </span>
                        <span className="text-white/70 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity" data-testid={`text-photo-user-${photo.id}`}>
                          {photo.userName}
                        </span>
                      </div>
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
