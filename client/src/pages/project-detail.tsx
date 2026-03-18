import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { useAuth } from "@/hooks/use-auth";
import PhotoViewer from "@/components/photo-viewer";
import {
  Upload,
  MapPin,
  Tag,
  MessageSquare,
  Plus,
  ClipboardList,
  CheckCircle2,
  Clock,
  AlertCircle,
  Image as ImageIcon,
  FileText,
  ChevronLeft,
  Star,
  Share2,
  SplitSquareHorizontal,
  MoreHorizontal,
  Users,
  Info,
  ClipboardCheck,
  FileBarChart,
  Circle,
  Trash2,
  Send,
  X,
  Link2,
  Copy,
  Check,
  Mail,
  Eye,
  Grid3X3,
  Grid2X2,
  Square,
  Calendar,
} from "lucide-react";
import { useLocation } from "wouter";
import { LayoutTemplate } from "lucide-react";
import type { Project, Media, Comment, Task, Checklist, ChecklistItem, Report, ChecklistTemplate, ChecklistTemplateItem, ReportTemplate } from "@shared/schema";

type ChecklistWithDetails = Checklist & {
  assignedTo?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null };
  itemCount: number;
  checkedCount: number;
};

type ReportWithDetails = Report & {
  createdBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null };
};

interface ProjectDetailData {
  project: Project;
  media: (Media & { uploadedBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[];
  tasks: (Task & { assignedTo?: { firstName: string | null; lastName: string | null } })[];
  checklists: ChecklistWithDetails[];
  reports: ReportWithDetails[];
}

const taskPriorityColors: Record<string, string> = {
  low: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const taskStatusIcons: Record<string, typeof CheckCircle2> = {
  todo: AlertCircle,
  in_progress: Clock,
  done: CheckCircle2,
};

const checklistStatusConfig: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  not_started: { label: "Not Started", icon: Circle, className: "text-muted-foreground" },
  in_progress: { label: "In Progress", icon: Clock, className: "text-amber-500" },
  completed: { label: "Completed", icon: CheckCircle2, className: "text-green-500" },
};

const reportStatusConfig: Record<string, { label: string; badgeClass: string }> = {
  draft: { label: "Draft", badgeClass: "bg-muted text-muted-foreground" },
  submitted: { label: "Submitted", badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  approved: { label: "Approved", badgeClass: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
};

const reportTypeLabels: Record<string, string> = {
  inspection: "Inspection",
  safety: "Safety",
  progress: "Progress",
  incident: "Incident",
  daily: "Daily",
};

type DetailTab = "photos" | "tasks" | "files" | "checklists" | "reports" | "daily-log";

function BeforeAfterSlider({
  beforeUrl,
  afterUrl,
  beforeLabel,
  afterLabel,
}: {
  beforeUrl: string;
  afterUrl: string;
  beforeLabel: string;
  afterLabel: string;
}) {
  const [sliderPos, setSliderPos] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const handleMove = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    setSliderPos((x / rect.width) * 100);
  }, []);

  const handleMouseDown = useCallback(() => {
    isDragging.current = true;
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isDragging.current) handleMove(e.clientX);
  }, [handleMove]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    handleMove(e.touches[0].clientX);
  }, [handleMove]);

  return (
    <div
      ref={containerRef}
      className="relative w-full aspect-[4/3] rounded-md overflow-hidden cursor-col-resize select-none bg-muted"
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onMouseMove={handleMouseMove}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleMouseUp}
      onClick={(e) => handleMove(e.clientX)}
      data-testid="before-after-slider"
    >
      <img src={afterUrl} alt="After" className="absolute inset-0 w-full h-full object-cover" />
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ width: `${sliderPos}%` }}
      >
        <img
          src={beforeUrl}
          alt="Before"
          className="absolute top-0 left-0 h-full object-cover"
          style={{ width: `${100 / (sliderPos / 100)}%`, maxWidth: "none" }}
        />
      </div>
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg z-10"
        style={{ left: `${sliderPos}%` }}
      >
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-white shadow-md flex items-center justify-center">
          <div className="flex items-center gap-0.5 text-muted-foreground">
            <ChevronLeft className="h-3 w-3" />
            <ChevronLeft className="h-3 w-3 rotate-180" />
          </div>
        </div>
      </div>
      <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/50 text-white text-xs font-medium z-10">
        {beforeLabel}
      </div>
      <div className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-black/50 text-white text-xs font-medium z-10">
        {afterLabel}
      </div>
    </div>
  );
}

export default function ProjectDetailPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<DetailTab>("photos");
  const [selectedMedia, setSelectedMedia] = useState<(Media & { uploadedBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } }) | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<string>("medium");
  const [newChecklistTitle, setNewChecklistTitle] = useState("");
  const [newChecklistItems, setNewChecklistItems] = useState<string[]>([""]);
  const [newReportTitle, setNewReportTitle] = useState("");
  const [newReportType, setNewReportType] = useState("inspection");
  const [expandedChecklist, setExpandedChecklist] = useState<number | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [shareStep, setShareStep] = useState<"options" | "link">("options");
  const [shareIncludeMetadata, setShareIncludeMetadata] = useState(false);
  const [shareIncludeDescriptions, setShareIncludeDescriptions] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [compareMode, setCompareMode] = useState(false);
  const [comparePhotos, setComparePhotos] = useState<[number | null, number | null]>([null, null]);
  const [showCompareDialog, setShowCompareDialog] = useState(false);
  const [showProjectInfo, setShowProjectInfo] = useState(false);
  const [photoSize, setPhotoSize] = useState<"small" | "medium" | "large">("medium");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery<ProjectDetailData>({
    queryKey: ["/api/projects", id],
  });

  const { data: checklistTemplates } = useQuery<(ChecklistTemplate & { itemCount: number })[]>({
    queryKey: ["/api/checklist-templates"],
  });

  const { data: reportTemplates } = useQuery<ReportTemplate[]>({
    queryKey: ["/api/report-templates"],
  });

  const uploadMedia = useMutation({
    mutationFn: async (files: FileList) => {
      const formData = new FormData();
      Array.from(files).forEach((f) => formData.append("files", f));
      const res = await fetch(`/api/projects/${id}/media`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"], exact: true });
      toast({ title: "Uploaded", description: "Photos added to the project." });
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", description: "Logging in again...", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const addTask = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${id}/tasks`, {
        title: newTaskTitle,
        priority: newTaskPriority,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
      setNewTaskTitle("");
      toast({ title: "Task added" });
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateTaskStatus = useMutation({
    mutationFn: async ({ taskId, status }: { taskId: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/tasks/${taskId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
    },
  });

  const applyChecklistTemplate = useCallback(async (templateId: number) => {
    try {
      const res = await apiRequest("GET", `/api/checklist-templates/${templateId}/items`);
      const items: ChecklistTemplateItem[] = await res.json();
      const template = checklistTemplates?.find(t => t.id === templateId);
      if (template) {
        setNewChecklistTitle(template.title);
        setNewChecklistItems(items.length > 0 ? items.map(i => i.label) : [""]);
        toast({ title: `Template "${template.title}" applied` });
      }
    } catch (error) {
      if (isUnauthorizedError(error as Error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Failed to load template", variant: "destructive" });
    }
  }, [checklistTemplates, toast]);

  const applyReportTemplate = useCallback((templateId: number) => {
    const template = reportTemplates?.find(t => t.id === templateId);
    if (template) {
      setNewReportTitle(template.title);
      setNewReportType(template.type);
      toast({ title: `Template "${template.title}" applied` });
    }
  }, [reportTemplates, toast]);

  const createChecklist = useMutation({
    mutationFn: async () => {
      const items = newChecklistItems.filter(i => i.trim());
      const res = await apiRequest("POST", `/api/projects/${id}/checklists`, {
        title: newChecklistTitle,
        items,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/checklists"] });
      setNewChecklistTitle("");
      setNewChecklistItems([""]);
      toast({ title: "Checklist created" });
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createReport = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${id}/reports`, {
        title: newReportTitle,
        type: newReportType,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports"] });
      setNewReportTitle("");
      toast({ title: "Report created" });
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateReportStatus = useMutation({
    mutationFn: async ({ reportId, status }: { reportId: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/reports/${reportId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/reports"] });
    },
  });

  const deleteProject = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["/api/projects", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"], exact: true });
      window.location.href = "/";
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const createGallery = useMutation({
    mutationFn: async (params: { mediaIds: number[]; includeMetadata: boolean; includeDescriptions: boolean }) => {
      const res = await apiRequest("POST", "/api/galleries", {
        projectId: Number(id),
        mediaIds: params.mediaIds,
        includeMetadata: params.includeMetadata,
        includeDescriptions: params.includeDescriptions,
      });
      return res.json();
    },
    onSuccess: (data) => {
      const url = `${window.location.origin}/gallery/${data.token}`;
      setShareLink(url);
      setShareStep("link");
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const toggleSelection = useCallback((mediaId: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(mediaId)) next.delete(mediaId);
      else next.add(mediaId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((allMedia: { id: number }[]) => {
    if (selectedIds.size === allMedia.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allMedia.map(m => m.id)));
    }
  }, [selectedIds.size]);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const openShareDialog = useCallback(() => {
    setShareStep("options");
    setShareIncludeMetadata(false);
    setShareIncludeDescriptions(false);
    setShareLink("");
    setLinkCopied(false);
    setShowShareDialog(true);
  }, []);

  const handleGetLink = useCallback(() => {
    createGallery.mutate({
      mediaIds: Array.from(selectedIds),
      includeMetadata: shareIncludeMetadata,
      includeDescriptions: shareIncludeDescriptions,
    });
  }, [selectedIds, shareIncludeMetadata, shareIncludeDescriptions, createGallery]);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toast({ title: "Failed to copy", variant: "destructive" });
    }
  }, [shareLink, toast]);

  const getInitials = (firstName: string | null, lastName: string | null) => {
    return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
  };

  const groupMediaByDate = (mediaItems: ProjectDetailData["media"]) => {
    const groups: Record<string, ProjectDetailData["media"]> = {};
    for (const item of mediaItems) {
      const date = new Date(item.createdAt);
      const key = date.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    }
    return Object.entries(groups);
  };

  const formatPhotoTime = (date: string | Date) => {
    return new Date(date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  };

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-6 max-w-full">
        <Skeleton className="h-6 w-32" />
        <div className="flex gap-4">
          <Skeleton className="h-20 w-20 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="aspect-square rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/")}
          data-testid="button-back"
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Projects
        </Button>
        <div className="text-center mt-12">
          <h2 className="text-xl font-semibold">Project not found</h2>
        </div>
      </div>
    );
  }

  const { project, media: projectMedia, tasks: projectTasks, checklists: projectChecklists, reports: projectReports } = data;
  const groupedMedia = groupMediaByDate(projectMedia);

  const uniqueUsers = new Map<string, { firstName: string | null; lastName: string | null; profileImageUrl: string | null }>();
  projectMedia.forEach((m) => {
    if (m.uploadedBy && m.uploadedById) {
      uniqueUsers.set(m.uploadedById, m.uploadedBy);
    }
  });
  const projectUsers = Array.from(uniqueUsers.values());

  const tabs: { key: DetailTab; label: string; count: number }[] = [
    { key: "photos", label: "Photos", count: projectMedia.length },
    { key: "tasks", label: "Tasks", count: projectTasks.length },
    { key: "checklists", label: "Checklists", count: projectChecklists.length },
    { key: "reports", label: "Reports", count: projectReports.length },
    { key: "files", label: "Files", count: 0 },
    { key: "daily-log", label: "Daily Log", count: 0 },
  ];

  const todoCount = projectTasks.filter(t => t.status === "todo").length;
  const inProgressCount = projectTasks.filter(t => t.status === "in_progress").length;
  const doneCount = projectTasks.filter(t => t.status === "done").length;
  const checklistProgress = projectChecklists.length > 0
    ? Math.round(projectChecklists.reduce((acc, cl) => acc + (cl.itemCount > 0 ? cl.checkedCount / cl.itemCount : 0), 0) / projectChecklists.length * 100)
    : 0;

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0">
        <div className="px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/")}
            data-testid="button-back"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Projects
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" data-testid="button-star">
              <Star className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowProjectInfo(!showProjectInfo)}
              data-testid="button-project-info-toggle"
            >
              <Info className="h-4 w-4 mr-1.5" />
              Details
            </Button>
            <Button variant="ghost" size="sm" data-testid="button-share">
              <Share2 className="h-4 w-4 mr-1.5" />
              Share
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" data-testid="button-more">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setShowDeleteDialog(true)}
                  data-testid="menu-item-delete-project"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="px-4 sm:px-6 pb-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight truncate" data-testid="text-project-name">
                {project.name}
              </h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                {project.address && (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(project.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
                    data-testid="link-project-address"
                  >
                    <MapPin className="h-3 w-3 shrink-0" />
                    <span className="underline-offset-2 hover:underline">{project.address}</span>
                  </a>
                )}
                <span className="text-sm text-muted-foreground flex items-center gap-1" data-testid="text-project-created">
                  <Calendar className="h-3 w-3 shrink-0" />
                  Created {new Date(project.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Card className="px-3 py-1.5 flex items-center gap-2" data-testid="stat-project-photos">
                <ImageIcon className="h-3.5 w-3.5 text-primary" />
                <span className="text-sm font-semibold">{projectMedia.length}</span>
                <span className="text-xs text-muted-foreground">Photos</span>
              </Card>
              <Card className="px-3 py-1.5 flex items-center gap-2" data-testid="stat-project-tasks">
                <ClipboardList className="h-3.5 w-3.5 text-primary" />
                <span className="text-sm font-semibold">{projectTasks.length}</span>
                <span className="text-xs text-muted-foreground">Tasks</span>
              </Card>
              {projectChecklists.length > 0 && (
                <Card className="px-3 py-1.5 flex items-center gap-2" data-testid="stat-project-checklists">
                  <ClipboardCheck className="h-3.5 w-3.5 text-[#267D32]" />
                  <span className="text-sm font-semibold">{checklistProgress}%</span>
                  <span className="text-xs text-muted-foreground">Checklists</span>
                </Card>
              )}
              {projectUsers.length > 0 && (
                <div className="flex items-center -space-x-1.5">
                  {projectUsers.slice(0, 4).map((u, i) => (
                    <Avatar key={i} className="h-7 w-7 border-2 border-background">
                      <AvatarImage src={u.profileImageUrl || undefined} />
                      <AvatarFallback className="text-[9px] bg-primary/10 text-primary">
                        {getInitials(u.firstName, u.lastName)}
                      </AvatarFallback>
                    </Avatar>
                  ))}
                  {projectUsers.length > 4 && (
                    <div className="h-7 w-7 rounded-full bg-muted border-2 border-background flex items-center justify-center">
                      <span className="text-[9px] font-medium text-muted-foreground">+{projectUsers.length - 4}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {showProjectInfo && (
            <Card className="mt-4 p-4" data-testid="project-info-panel">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Description</h3>
                  <p className="text-sm">{project.description || "No description added."}</p>
                </div>
                <div className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</h3>
                  <Badge variant={project.status === "active" ? "default" : "secondary"}>
                    {project.status === "active" ? "Active" : project.status === "completed" ? "Completed" : "On Hold"}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Task Progress</h3>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-muted-foreground">{todoCount} open</span>
                    <span className="text-amber-600 dark:text-amber-400">{inProgressCount} active</span>
                    <span className="text-green-600 dark:text-green-400">{doneCount} done</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Team ({projectUsers.length})</h3>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {projectUsers.length > 0 ? (
                      projectUsers.map((u, i) => (
                        <span key={i} className="text-sm text-muted-foreground">{u.firstName} {u.lastName}{i < projectUsers.length - 1 ? "," : ""}</span>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">No team members yet</span>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        <div className="overflow-auto flex-1">
          <div className="px-4 sm:px-6 pt-4 pb-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {tabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                    activeTab === tab.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover-elevate"
                  }`}
                  data-testid={`tab-${tab.key}`}
                >
                  {tab.label}
                  {tab.count > 0 && (
                    <span className={`ml-1.5 text-xs ${activeTab === tab.key ? "text-primary-foreground/70" : "text-muted-foreground/60"}`}>
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {activeTab === "photos" && (
            <div className="px-4 sm:px-6 py-4 space-y-6">
              {selectionMode && (
                <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-md bg-primary/10 border border-primary/20">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="ghost" size="icon" onClick={exitSelectionMode} data-testid="button-exit-selection">
                      <X className="h-4 w-4" />
                    </Button>
                    <span className="text-sm font-medium" data-testid="text-selected-count">
                      {selectedIds.size} Selected
                    </span>
                    <Button variant="outline" size="sm" onClick={() => toggleSelectAll(projectMedia)} data-testid="button-select-all">
                      {selectedIds.size === projectMedia.length ? "Deselect All" : "Select All"}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      onClick={openShareDialog}
                      disabled={selectedIds.size === 0}
                      data-testid="button-share-selected"
                    >
                      <Share2 className="h-4 w-4 mr-2" />
                      Share
                    </Button>
                  </div>
                </div>
              )}

              {compareMode && (
                <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                  <div className="flex flex-wrap items-center gap-3">
                    <Button variant="ghost" size="icon" onClick={() => { setCompareMode(false); setComparePhotos([null, null]); }} data-testid="button-exit-compare">
                      <X className="h-4 w-4" />
                    </Button>
                    <SplitSquareHorizontal className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                    <span className="text-sm font-medium">
                      {comparePhotos[0] === null
                        ? "Select the BEFORE photo"
                        : comparePhotos[1] === null
                          ? "Now select the AFTER photo"
                          : "Ready to compare"}
                    </span>
                    {comparePhotos[0] !== null && (
                      <Badge variant="secondary">
                        {comparePhotos[1] !== null ? "2" : "1"} of 2 selected
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {comparePhotos[0] !== null && comparePhotos[1] !== null && (
                      <Button
                        onClick={() => setShowCompareDialog(true)}
                        data-testid="button-open-compare"
                      >
                        <SplitSquareHorizontal className="h-4 w-4 mr-2" />
                        View Comparison
                      </Button>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" data-testid="button-filter-start-date">
                    Start Date
                  </Button>
                  <Button variant="outline" size="sm" data-testid="button-filter-end-date">
                    End Date
                  </Button>
                  <Button variant="outline" size="sm" data-testid="button-filter-users">
                    Users
                  </Button>
                  <Button variant="outline" size="sm" data-testid="button-filter-groups">
                    Groups
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center border rounded-md" data-testid="photo-size-toggle">
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`rounded-none rounded-l-md ${photoSize === "small" ? "toggle-elevate toggle-elevated" : ""}`}
                      onClick={() => setPhotoSize("small")}
                      data-testid="button-photo-size-small"
                    >
                      <Grid3X3 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`rounded-none border-l border-r ${photoSize === "medium" ? "toggle-elevate toggle-elevated" : ""}`}
                      onClick={() => setPhotoSize("medium")}
                      data-testid="button-photo-size-medium"
                    >
                      <Grid2X2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`rounded-none rounded-r-md ${photoSize === "large" ? "toggle-elevate toggle-elevated" : ""}`}
                      onClick={() => setPhotoSize("large")}
                      data-testid="button-photo-size-large"
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  </div>
                  {!selectionMode && !compareMode && projectMedia.length >= 2 && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setCompareMode(true);
                        setComparePhotos([null, null]);
                      }}
                      data-testid="button-enter-compare"
                    >
                      <SplitSquareHorizontal className="h-4 w-4 mr-2" />
                      Compare
                    </Button>
                  )}
                  {!selectionMode && projectMedia.length > 0 && (
                    <Button
                      variant="outline"
                      onClick={() => setSelectionMode(true)}
                      data-testid="button-enter-selection"
                    >
                      <Check className="h-4 w-4 mr-2" />
                      Select
                    </Button>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) uploadMedia.mutate(e.target.files);
                    }}
                    data-testid="input-file-upload"
                  />
                  <Button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadMedia.isPending}
                    data-testid="button-upload-photos"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    {uploadMedia.isPending ? "Uploading..." : "Upload Photos"}
                  </Button>
                </div>
              </div>

              {projectMedia.length === 0 ? (
                <Card className="p-12">
                  <div className="text-center space-y-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                      <ImageIcon className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold">No photos yet</h3>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                      Upload your first photos to start documenting this project.
                    </p>
                  </div>
                </Card>
              ) : (
                <div className="space-y-6">
                  {groupedMedia.map(([date, items]) => (
                    <div key={date}>
                      <div className="flex items-center gap-2 mb-3">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-muted-foreground/30"
                          checked={items.every(item => selectedIds.has(item.id))}
                          onChange={() => {
                            const allSelected = items.every(item => selectedIds.has(item.id));
                            setSelectedIds(prev => {
                              const next = new Set(prev);
                              if (allSelected) {
                                items.forEach(item => next.delete(item.id));
                              } else {
                                items.forEach(item => next.add(item.id));
                              }
                              return next;
                            });
                            if (!selectionMode) setSelectionMode(true);
                          }}
                          data-testid={`checkbox-date-group-${date}`}
                        />
                        <h3 className="text-sm font-semibold" data-testid={`text-date-group-${date}`}>{date}</h3>
                      </div>
                      <div className={`grid gap-3 ${photoSize === "small" ? "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8" : photoSize === "large" ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"}`}>
                        {items.map((item) => {
                          const isSelected = selectedIds.has(item.id);
                          return (
                            <div
                              key={item.id}
                              className="cursor-pointer group"
                              onClick={() => {
                                if (compareMode) {
                                  if (comparePhotos[0] === null) {
                                    setComparePhotos([item.id, null]);
                                  } else if (comparePhotos[1] === null && item.id !== comparePhotos[0]) {
                                    setComparePhotos([comparePhotos[0], item.id]);
                                  }
                                } else if (selectionMode) {
                                  toggleSelection(item.id);
                                } else {
                                  setSelectedMedia(item);
                                }
                              }}
                              data-testid={`card-media-${item.id}`}
                            >
                              <div className={`aspect-[4/3] rounded-md overflow-hidden bg-muted relative ${selectionMode && isSelected ? "ring-2 ring-primary ring-offset-2" : ""} ${compareMode && (comparePhotos[0] === item.id || comparePhotos[1] === item.id) ? "ring-2 ring-blue-500 ring-offset-2" : ""}`}>
                                <img
                                  src={item.url}
                                  alt={item.caption || item.originalName}
                                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                />
                                {selectionMode && (
                                  <div className="absolute top-2 left-2">
                                    <div className={`h-6 w-6 rounded-md border-2 flex items-center justify-center transition-colors ${isSelected ? "bg-primary border-primary" : "bg-black/30 border-white/70"}`} data-testid={`checkbox-media-${item.id}`}>
                                      {isSelected && <Check className="h-4 w-4 text-primary-foreground" />}
                                    </div>
                                  </div>
                                )}
                                {compareMode && comparePhotos[0] === item.id && (
                                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-blue-600 text-white text-xs font-semibold">
                                    Before
                                  </div>
                                )}
                                {compareMode && comparePhotos[1] === item.id && (
                                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-blue-600 text-white text-xs font-semibold">
                                    After
                                  </div>
                                )}
                                {item.uploadedBy && !selectionMode && (
                                  <div className="absolute bottom-2 right-2">
                                    <Avatar className="h-7 w-7 border-2 border-white">
                                      <AvatarImage src={item.uploadedBy.profileImageUrl || undefined} />
                                      <AvatarFallback className="text-[9px] bg-primary text-primary-foreground">
                                        {getInitials(item.uploadedBy.firstName, item.uploadedBy.lastName)}
                                      </AvatarFallback>
                                    </Avatar>
                                  </div>
                                )}
                              </div>
                              <div className="mt-1.5 space-y-0.5">
                                <p className="text-xs text-muted-foreground">
                                  {formatPhotoTime(item.createdAt)}
                                  {item.uploadedBy && (
                                    <span>
                                      {" "}&middot; {item.uploadedBy.firstName} {item.uploadedBy.lastName}
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {projectMedia.length > 0 && (
                    <p className="text-center text-sm text-muted-foreground py-4">
                      No more photos to load!
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === "tasks" && (
            <div className="px-4 sm:px-6 py-4 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  placeholder="Add a new task..."
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  className="flex-1 min-w-[200px]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTaskTitle.trim()) addTask.mutate();
                  }}
                  data-testid="input-new-task"
                />
                <Select value={newTaskPriority} onValueChange={setNewTaskPriority}>
                  <SelectTrigger className="w-[120px]" data-testid="select-task-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  onClick={() => { if (newTaskTitle.trim()) addTask.mutate(); }}
                  disabled={addTask.isPending || !newTaskTitle.trim()}
                  data-testid="button-add-task"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Task
                </Button>
              </div>

              {projectTasks.length === 0 ? (
                <Card className="p-12">
                  <div className="text-center space-y-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                      <ClipboardList className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold">No tasks yet</h3>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                      Add tasks to track work items for this project.
                    </p>
                  </div>
                </Card>
              ) : (
                <div className="space-y-2">
                  {projectTasks.map((task) => {
                    const StatusIcon = taskStatusIcons[task.status] || AlertCircle;
                    return (
                      <Card key={task.id} className="flex items-center gap-3 p-3" data-testid={`card-task-${task.id}`}>
                        <Select
                          value={task.status}
                          onValueChange={(status) => updateTaskStatus.mutate({ taskId: task.id, status })}
                        >
                          <SelectTrigger className="w-auto border-0 p-0 h-auto shadow-none" data-testid={`select-task-status-${task.id}`}>
                            <StatusIcon className={`h-5 w-5 ${task.status === "done" ? "text-green-500" : task.status === "in_progress" ? "text-amber-500" : "text-muted-foreground"}`} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="todo">To Do</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="done">Done</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium ${task.status === "done" ? "line-through text-muted-foreground" : ""}`}>
                            {task.title}
                          </p>
                        </div>
                        <Badge variant="secondary" className={`text-xs shrink-0 no-default-hover-elevate no-default-active-elevate ${taskPriorityColors[task.priority]}`}>
                          {task.priority}
                        </Badge>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "checklists" && (
            <div className="px-4 sm:px-6 py-4 space-y-4">
              <Card className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Create Checklist</h3>
                  {checklistTemplates && checklistTemplates.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" data-testid="button-apply-checklist-template">
                          <LayoutTemplate className="h-3.5 w-3.5 mr-1.5" />
                          Use Template
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {checklistTemplates.map((t) => (
                          <DropdownMenuItem
                            key={t.id}
                            onClick={() => applyChecklistTemplate(t.id)}
                            data-testid={`menu-apply-checklist-template-${t.id}`}
                          >
                            <LayoutTemplate className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                            {t.title}
                            <Badge variant="secondary" className="ml-auto text-xs no-default-hover-elevate no-default-active-elevate">{t.itemCount}</Badge>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                <Input
                  placeholder="Checklist title..."
                  value={newChecklistTitle}
                  onChange={(e) => setNewChecklistTitle(e.target.value)}
                  data-testid="input-new-checklist-title"
                />
                <div className="space-y-2">
                  {newChecklistItems.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <Circle className="h-4 w-4 text-muted-foreground shrink-0" />
                      <Input
                        placeholder={`Item ${idx + 1}...`}
                        value={item}
                        onChange={(e) => {
                          const updated = [...newChecklistItems];
                          updated[idx] = e.target.value;
                          setNewChecklistItems(updated);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            setNewChecklistItems([...newChecklistItems, ""]);
                          }
                        }}
                        className="flex-1"
                        data-testid={`input-checklist-item-${idx}`}
                      />
                      {newChecklistItems.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setNewChecklistItems(newChecklistItems.filter((_, i) => i !== idx))}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-primary"
                    onClick={() => setNewChecklistItems([...newChecklistItems, ""])}
                    data-testid="button-add-checklist-item"
                  >
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add Item
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() => { if (newChecklistTitle.trim()) createChecklist.mutate(); }}
                    disabled={createChecklist.isPending || !newChecklistTitle.trim()}
                    data-testid="button-create-checklist"
                  >
                    <ClipboardCheck className="h-4 w-4 mr-2" />
                    Create Checklist
                  </Button>
                </div>
              </Card>

              {projectChecklists.length === 0 ? (
                <Card className="p-12">
                  <div className="text-center space-y-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                      <ClipboardCheck className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold">No checklists yet</h3>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                      Create a checklist above to start tracking items for this project.
                    </p>
                  </div>
                </Card>
              ) : (
                <div className="space-y-2">
                  {projectChecklists.map((cl) => {
                    const config = checklistStatusConfig[cl.status] || checklistStatusConfig.not_started;
                    const StatusIcon = config.icon;
                    const progress = cl.itemCount > 0 ? Math.round((cl.checkedCount / cl.itemCount) * 100) : 0;
                    const isExpanded = expandedChecklist === cl.id;
                    return (
                      <ChecklistCard
                        key={cl.id}
                        checklist={cl}
                        config={config}
                        StatusIcon={StatusIcon}
                        progress={progress}
                        isExpanded={isExpanded}
                        onToggle={() => setExpandedChecklist(isExpanded ? null : cl.id)}
                        getInitials={getInitials}
                        projectId={id}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "reports" && (
            <div className="px-4 sm:px-6 py-4 space-y-4">
              <Card className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Create Report</h3>
                  {reportTemplates && reportTemplates.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" data-testid="button-apply-report-template">
                          <LayoutTemplate className="h-3.5 w-3.5 mr-1.5" />
                          Use Template
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {reportTemplates.map((t) => (
                          <DropdownMenuItem
                            key={t.id}
                            onClick={() => applyReportTemplate(t.id)}
                            data-testid={`menu-apply-report-template-${t.id}`}
                          >
                            <LayoutTemplate className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                            {t.title}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Input
                    placeholder="Report title..."
                    value={newReportTitle}
                    onChange={(e) => setNewReportTitle(e.target.value)}
                    className="flex-1 min-w-[200px]"
                    data-testid="input-new-report-title"
                  />
                  <Select value={newReportType} onValueChange={setNewReportType}>
                    <SelectTrigger className="w-[160px]" data-testid="select-report-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inspection">Inspection</SelectItem>
                      <SelectItem value="safety">Safety</SelectItem>
                      <SelectItem value="progress">Progress</SelectItem>
                      <SelectItem value="incident">Incident</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={() => { if (newReportTitle.trim()) createReport.mutate(); }}
                    disabled={createReport.isPending || !newReportTitle.trim()}
                    data-testid="button-create-report"
                  >
                    <FileBarChart className="h-4 w-4 mr-2" />
                    Create Report
                  </Button>
                </div>
              </Card>

              {projectReports.length === 0 ? (
                <Card className="p-12">
                  <div className="text-center space-y-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                      <FileBarChart className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <h3 className="text-lg font-semibold">No reports yet</h3>
                    <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                      Create your first inspection or project report above.
                    </p>
                  </div>
                </Card>
              ) : (
                <div className="space-y-2">
                  {projectReports.map((report) => {
                    const config = reportStatusConfig[report.status] || reportStatusConfig.draft;
                    return (
                      <Card key={report.id} className="p-4" data-testid={`card-report-${report.id}`}>
                        <div className="flex items-start gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted shrink-0">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-sm font-semibold" data-testid={`text-report-title-${report.id}`}>
                                {report.title}
                              </span>
                              <Badge variant="secondary" className={`text-xs shrink-0 no-default-hover-elevate no-default-active-elevate ${config.badgeClass}`}>
                                {config.label}
                              </Badge>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate">
                                {reportTypeLabels[report.type] || report.type}
                              </Badge>
                              <span className="text-xs text-muted-foreground">
                                {new Date(report.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              </span>
                            </div>
                            {report.createdBy && (
                              <div className="flex items-center gap-1.5 mt-2">
                                <Avatar className="h-5 w-5">
                                  <AvatarImage src={report.createdBy.profileImageUrl || undefined} />
                                  <AvatarFallback className="text-[8px] bg-primary/10 text-primary">
                                    {getInitials(report.createdBy.firstName, report.createdBy.lastName)}
                                  </AvatarFallback>
                                </Avatar>
                                <span className="text-xs text-muted-foreground">
                                  {report.createdBy.firstName} {report.createdBy.lastName}
                                </span>
                              </div>
                            )}
                            <div className="flex items-center gap-2 mt-3">
                              <Select
                                value={report.status}
                                onValueChange={(status) => updateReportStatus.mutate({ reportId: report.id, status })}
                              >
                                <SelectTrigger className="w-[130px]" data-testid={`select-report-status-${report.id}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="draft">Draft</SelectItem>
                                  <SelectItem value="submitted">Submitted</SelectItem>
                                  <SelectItem value="approved">Approved</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "files" && (
            <div className="px-4 sm:px-6 py-4">
              <Card className="p-12">
                <div className="text-center space-y-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted mx-auto">
                    <FileText className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold">No files yet</h3>
                  <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                    Files and documents for this project will appear here.
                  </p>
                </div>
              </Card>
            </div>
          )}

          {activeTab === "daily-log" && (
            <DailyLogTab projectId={id} />
          )}
        </div>
      </div>

      {selectedMedia && (
        <PhotoViewer
          media={selectedMedia}
          allMedia={projectMedia}
          project={project}
          tasks={projectTasks}
          onClose={() => setSelectedMedia(null)}
          onNavigate={(m) => setSelectedMedia(m)}
        />
      )}

      <Dialog open={showShareDialog} onOpenChange={setShowShareDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share Gallery of Selected Photos</DialogTitle>
            <DialogDescription>
              {shareStep === "options"
                ? `Share ${selectedIds.size} selected photo${selectedIds.size !== 1 ? "s" : ""} as a gallery link.`
                : "Your gallery link is ready to share."}
            </DialogDescription>
          </DialogHeader>

          {shareStep === "options" ? (
            <div className="space-y-4">
              <label className="flex items-center gap-3 cursor-pointer" data-testid="toggle-include-metadata">
                <button
                  type="button"
                  role="switch"
                  aria-checked={shareIncludeMetadata}
                  onClick={() => setShareIncludeMetadata(!shareIncludeMetadata)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${shareIncludeMetadata ? "bg-primary" : "bg-muted"}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow-lg transition-transform ${shareIncludeMetadata ? "translate-x-4" : "translate-x-0"}`} />
                </button>
                <span className="text-sm">Include who, when, and where the photo was taken</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer" data-testid="toggle-include-descriptions">
                <button
                  type="button"
                  role="switch"
                  aria-checked={shareIncludeDescriptions}
                  onClick={() => setShareIncludeDescriptions(!shareIncludeDescriptions)}
                  className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${shareIncludeDescriptions ? "bg-primary" : "bg-muted"}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-background shadow-lg transition-transform ${shareIncludeDescriptions ? "translate-x-4" : "translate-x-0"}`} />
                </button>
                <span className="text-sm">Include photo descriptions</span>
              </label>
              <div className="flex justify-end pt-2">
                <Button
                  onClick={handleGetLink}
                  disabled={createGallery.isPending}
                  data-testid="button-get-link"
                >
                  <Link2 className="h-4 w-4 mr-2" />
                  {createGallery.isPending ? "Creating..." : "Get Link"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 p-2 rounded-md border bg-muted/50 min-w-0 overflow-hidden max-w-full">
                <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm min-w-0 flex-1 break-all line-clamp-2" data-testid="text-share-link">{shareLink}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={handleCopyLink}
                  data-testid="button-copy-link"
                >
                  {linkCopied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                  {linkCopied ? "Copied" : "Copy Link"}
                </Button>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => window.open(`mailto:?subject=Photo Gallery - ${project.name}&body=View the photo gallery: ${encodeURIComponent(shareLink)}`, "_blank")}
                  data-testid="button-share-email"
                >
                  <Mail className="h-4 w-4 mr-2" />
                  Email
                </Button>
                <Button
                  onClick={() => window.open(shareLink, "_blank")}
                  data-testid="button-view-gallery"
                >
                  <Eye className="h-4 w-4 mr-2" />
                  View Gallery
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Project</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{project.name}"? This will permanently remove the project and all its photos, tasks, checklists, and reports. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => deleteProject.mutate()}
              disabled={deleteProject.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteProject.isPending ? "Deleting..." : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showCompareDialog} onOpenChange={setShowCompareDialog}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SplitSquareHorizontal className="h-5 w-5" />
              Before / After Comparison
            </DialogTitle>
            <DialogDescription>
              Drag the slider to compare the two photos
            </DialogDescription>
          </DialogHeader>
          {comparePhotos[0] !== null && comparePhotos[1] !== null && (() => {
            const beforePhoto = projectMedia.find((m) => m.id === comparePhotos[0]);
            const afterPhoto = projectMedia.find((m) => m.id === comparePhotos[1]);
            if (!beforePhoto || !afterPhoto) return null;
            return (
              <div className="space-y-4">
                <BeforeAfterSlider
                  beforeUrl={beforePhoto.url}
                  afterUrl={afterPhoto.url}
                  beforeLabel={`Before - ${new Date(beforePhoto.createdAt).toLocaleDateString()}`}
                  afterLabel={`After - ${new Date(afterPhoto.createdAt).toLocaleDateString()}`}
                />
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="space-y-1">
                    <p className="font-medium">Before</p>
                    <p className="text-muted-foreground">{beforePhoto.caption || beforePhoto.originalName}</p>
                    <p className="text-xs text-muted-foreground">{new Date(beforePhoto.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium">After</p>
                    <p className="text-muted-foreground">{afterPhoto.caption || afterPhoto.originalName}</p>
                    <p className="text-xs text-muted-foreground">{new Date(afterPhoto.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                  </div>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface DailyLogData {
  date: string;
  project: { id: number; name: string; address: string | null };
  summary: {
    photosUploaded: number;
    tasksCompleted: number;
    tasksInProgress: number;
    tasksCreated: number;
    commentsAdded: number;
    activeTeamMembers: number;
    teamMembers: string[];
  };
  photos: { id: number; url: string; caption: string | null; originalName: string; uploadedBy: string; time: string }[];
  tasks: { id: number; title: string; status: string; priority: string; assignedTo: string | null }[];
  comments: { id: number; content: string; by: string; time: string }[];
}

function DailyLogTab({ projectId }: { projectId: string }) {
  const [logDate, setLogDate] = useState(new Date().toISOString().split("T")[0]);

  const { data: log, isLoading } = useQuery<DailyLogData>({
    queryKey: ["/api/projects", projectId, "daily-log", logDate],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/daily-log?date=${logDate}`);
      if (!res.ok) throw new Error("Failed to fetch daily log");
      return res.json();
    },
  });

  const goDay = (offset: number) => {
    const d = new Date(logDate);
    d.setDate(d.getDate() + offset);
    setLogDate(d.toISOString().split("T")[0]);
  };

  const formattedDate = new Date(logDate + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const isToday = logDate === new Date().toISOString().split("T")[0];

  const taskStatusLabel: Record<string, string> = { todo: "To Do", in_progress: "In Progress", done: "Done" };
  const taskPriorityBadge: Record<string, string> = {
    low: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  };

  if (isLoading) {
    return (
      <div className="px-4 sm:px-6 py-4 space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-48" />
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-4 space-y-6" data-testid="daily-log-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => goDay(-1)} data-testid="button-prev-day">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-center min-w-[180px]">
            <p className="text-sm font-semibold" data-testid="text-daily-log-date">{formattedDate}</p>
            {isToday && <p className="text-xs text-primary font-medium">Today</p>}
          </div>
          <Button variant="outline" size="icon" onClick={() => goDay(1)} disabled={isToday} data-testid="button-next-day">
            <ChevronLeft className="h-4 w-4 rotate-180" />
          </Button>
        </div>
        <Input
          type="date"
          value={logDate}
          onChange={(e) => setLogDate(e.target.value)}
          className="w-[160px]"
          data-testid="input-daily-log-date"
        />
      </div>

      {log && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Card className="p-3 text-center" data-testid="stat-photos-uploaded">
              <p className="text-xl font-bold">{log.summary.photosUploaded}</p>
              <p className="text-xs text-muted-foreground">Photos</p>
            </Card>
            <Card className="p-3 text-center" data-testid="stat-tasks-completed">
              <p className="text-xl font-bold text-green-600 dark:text-green-400">{log.summary.tasksCompleted}</p>
              <p className="text-xs text-muted-foreground">Completed</p>
            </Card>
            <Card className="p-3 text-center" data-testid="stat-tasks-in-progress">
              <p className="text-xl font-bold text-amber-600 dark:text-amber-400">{log.summary.tasksInProgress}</p>
              <p className="text-xs text-muted-foreground">In Progress</p>
            </Card>
            <Card className="p-3 text-center" data-testid="stat-tasks-created">
              <p className="text-xl font-bold">{log.summary.tasksCreated}</p>
              <p className="text-xs text-muted-foreground">New Tasks</p>
            </Card>
            <Card className="p-3 text-center" data-testid="stat-comments-added">
              <p className="text-xl font-bold">{log.summary.commentsAdded}</p>
              <p className="text-xs text-muted-foreground">Comments</p>
            </Card>
            <Card className="p-3 text-center" data-testid="stat-team-members">
              <p className="text-xl font-bold">{log.summary.activeTeamMembers}</p>
              <p className="text-xs text-muted-foreground">Team Active</p>
            </Card>
          </div>

          {log.summary.teamMembers.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Active team:</span>
              {log.summary.teamMembers.map((name) => (
                <Badge key={name} variant="secondary">{name}</Badge>
              ))}
            </div>
          )}

          {log.photos.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ImageIcon className="h-4 w-4 text-primary" />
                Photos Uploaded ({log.photos.length})
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {log.photos.map((photo) => (
                  <div key={photo.id} className="space-y-1">
                    <div className="aspect-[4/3] rounded-md overflow-hidden bg-muted">
                      <img src={photo.url} alt={photo.caption || photo.originalName} className="w-full h-full object-cover" />
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <p className="text-xs text-muted-foreground truncate">{photo.uploadedBy}</p>
                      <p className="text-xs text-muted-foreground shrink-0">{photo.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {log.tasks.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ClipboardList className="h-4 w-4 text-primary" />
                Task Activity ({log.tasks.length})
              </h3>
              <div className="space-y-2">
                {log.tasks.map((task) => (
                  <Card key={task.id} className="p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm truncate">{task.title}</span>
                        <Badge variant="outline" className={taskPriorityBadge[task.priority] || ""}>
                          {task.priority}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {task.assignedTo && <span className="text-xs text-muted-foreground">{task.assignedTo}</span>}
                        <Badge variant="secondary">{taskStatusLabel[task.status] || task.status}</Badge>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {log.comments.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-primary" />
                Comments ({log.comments.length})
              </h3>
              <div className="space-y-2">
                {log.comments.map((comment) => (
                  <Card key={comment.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium">{comment.by}</p>
                        <p className="text-sm text-muted-foreground mt-0.5">{comment.content}</p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{comment.time}</span>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {log.photos.length === 0 && log.tasks.length === 0 && log.comments.length === 0 && (
            <Card className="p-8">
              <div className="text-center space-y-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted mx-auto">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                </div>
                <h3 className="text-base font-semibold">No activity</h3>
                <p className="text-sm text-muted-foreground">No photos, tasks, or comments were recorded on this day.</p>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function ChecklistCard({
  checklist,
  config,
  StatusIcon,
  progress,
  isExpanded,
  onToggle,
  getInitials,
  projectId,
}: {
  checklist: ChecklistWithDetails;
  config: { label: string; icon: typeof CheckCircle2; className: string };
  StatusIcon: typeof CheckCircle2;
  progress: number;
  isExpanded: boolean;
  onToggle: () => void;
  getInitials: (firstName: string | null, lastName: string | null) => string;
  projectId: string;
}) {
  const { data: items } = useQuery<ChecklistItem[]>({
    queryKey: ["/api/checklists", checklist.id.toString(), "items"],
    enabled: isExpanded,
  });

  const toggleItem = useMutation({
    mutationFn: async ({ itemId, checked }: { itemId: number; checked: boolean }) => {
      const res = await apiRequest("PATCH", `/api/checklist-items/${itemId}`, { checked });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists", checklist.id.toString(), "items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
    },
  });

  const addItem = useMutation({
    mutationFn: async (label: string) => {
      const res = await apiRequest("POST", `/api/checklists/${checklist.id}/items`, {
        label,
        sortOrder: (items?.length || 0),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/checklists", checklist.id.toString(), "items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
    },
  });

  const [newItemLabel, setNewItemLabel] = useState("");

  return (
    <Card className="p-4" data-testid={`card-checklist-${checklist.id}`}>
      <div className="flex items-start gap-3 cursor-pointer" onClick={onToggle}>
        <StatusIcon className={`h-5 w-5 mt-0.5 shrink-0 ${config.className}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold" data-testid={`text-checklist-title-${checklist.id}`}>
              {checklist.title}
            </span>
            <Badge variant="secondary" className="text-xs shrink-0 no-default-hover-elevate no-default-active-elevate">
              {checklist.checkedCount}/{checklist.itemCount}
            </Badge>
          </div>
          {checklist.itemCount > 0 && (
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
          {checklist.assignedTo && (
            <div className="flex items-center gap-1.5 mt-2">
              <Avatar className="h-5 w-5">
                <AvatarImage src={checklist.assignedTo.profileImageUrl || undefined} />
                <AvatarFallback className="text-[8px] bg-primary/10 text-primary">
                  {getInitials(checklist.assignedTo.firstName, checklist.assignedTo.lastName)}
                </AvatarFallback>
              </Avatar>
              <span className="text-xs text-muted-foreground">
                {checklist.assignedTo.firstName} {checklist.assignedTo.lastName}
              </span>
            </div>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className="mt-3 pl-8 space-y-2 border-t pt-3" onClick={(e) => e.stopPropagation()}>
          {items?.map((item) => (
            <label key={item.id} className="flex items-center gap-2 cursor-pointer" data-testid={`checklist-item-${item.id}`}>
              <input
                type="checkbox"
                checked={item.checked}
                onChange={() => toggleItem.mutate({ itemId: item.id, checked: !item.checked })}
                className="h-4 w-4 rounded border-muted-foreground/30"
              />
              <span className={`text-sm ${item.checked ? "line-through text-muted-foreground" : ""}`}>
                {item.label}
              </span>
            </label>
          ))}
          <div className="flex items-center gap-2 mt-2">
            <Input
              placeholder="Add item..."
              value={newItemLabel}
              onChange={(e) => setNewItemLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newItemLabel.trim()) {
                  addItem.mutate(newItemLabel.trim());
                  setNewItemLabel("");
                }
              }}
              className="flex-1"
              data-testid={`input-add-item-${checklist.id}`}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (newItemLabel.trim()) {
                  addItem.mutate(newItemLabel.trim());
                  setNewItemLabel("");
                }
              }}
              disabled={!newItemLabel.trim()}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
