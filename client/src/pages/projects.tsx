import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { useLocation } from "wouter";
import {
  Plus,
  Search,
  FolderKanban,
  Image as ImageIcon,
} from "lucide-react";
import type { Project } from "@shared/schema";
import { insertProjectSchema } from "@shared/schema";
import { z } from "zod";
import { AddressAutocomplete } from "@/components/address-autocomplete";

interface ProjectWithDetails extends Project {
  photoCount: number;
  recentPhotos: { id: number; url: string }[];
  recentUsers: { firstName: string | null; lastName: string | null; profileImageUrl: string | null }[];
}

const createProjectSchema = insertProjectSchema.extend({
  name: z.string().min(1, "Project name is required"),
});

type FilterTab = "all" | "active" | "completed" | "archived";

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<FilterTab>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: projects, isLoading } = useQuery<ProjectWithDetails[]>({
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
    console.log("[FORM] handleAddressSelect sets address+lat+lng atomically", result);
    form.setValue("address", result.address, { shouldValidate: true, shouldDirty: true });
    form.setValue("latitude", result.latitude, { shouldDirty: true });
    form.setValue("longitude", result.longitude, { shouldDirty: true });
  }, [form]);

  const handleAddressTextChange = useCallback((text: string) => {
    console.log("[FORM] handleAddressTextChange (manual typing) clears lat/lng", text);
    form.setValue("address", text, { shouldDirty: true });
    form.setValue("latitude", null);
    form.setValue("longitude", null);
  }, [form]);

  const createProject = useMutation({
    mutationFn: async (data: z.infer<typeof createProjectSchema>) => {
      console.log("[SUBMIT] outgoing payload", data);
      const res = await apiRequest("POST", "/api/projects", data);
      return res.json();
    },
    onSuccess: (data: { id: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects"] });
      setDialogOpen(false);
      form.reset();
      toast({ title: "Project created", description: "Your new project is ready." });
      navigate(`/projects/${data.id}`);
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

  const filtered = (projects || []).filter((p) => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description || "").toLowerCase().includes(search.toLowerCase()) ||
      (p.address || "").toLowerCase().includes(search.toLowerCase());
    const matchesTab = activeTab === "all" || p.status === activeTab;
    return matchesSearch && matchesTab;
  });

  const getInitials = (firstName: string | null, lastName: string | null) => {
    return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
  };

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

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight" data-testid="text-projects-title">Projects</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-new-project">
              <Plus className="h-4 w-4 mr-2" />
              Create
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Create New Project</DialogTitle>
              <DialogDescription className="sr-only">Fill in the details to create a new project.</DialogDescription>
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

      <div className="flex items-center gap-1">
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

      {isLoading ? (
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
  );
}
