import { useState, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowLeft,
  Camera,
  Upload,
  MapPin,
  Calendar,
  Tag,
  MessageSquare,
  Send,
  Plus,
  ClipboardList,
  CheckCircle2,
  Clock,
  AlertCircle,
  X,
  Image as ImageIcon,
} from "lucide-react";
import { useLocation } from "wouter";
import type { Project, Media, Comment, Task } from "@shared/schema";

interface ProjectDetailData {
  project: Project;
  media: (Media & { uploadedBy?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[];
  tasks: (Task & { assignedTo?: { firstName: string | null; lastName: string | null } })[];
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

export default function ProjectDetailPage({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [selectedMedia, setSelectedMedia] = useState<(Media & { comments?: (Comment & { user?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[] }) | null>(null);
  const [newComment, setNewComment] = useState("");
  const [uploadTags, setUploadTags] = useState("");
  const [uploadCaption, setUploadCaption] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<string>("medium");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery<ProjectDetailData>({
    queryKey: ["/api/projects", id],
  });

  const { data: mediaComments } = useQuery<(Comment & { user?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>({
    queryKey: ["/api/media", selectedMedia?.id?.toString() || "", "comments"],
    enabled: !!selectedMedia,
  });

  const uploadMedia = useMutation({
    mutationFn: async (files: FileList) => {
      const formData = new FormData();
      Array.from(files).forEach((f) => formData.append("files", f));
      if (uploadCaption) formData.append("caption", uploadCaption);
      if (uploadTags) formData.append("tags", uploadTags);
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
      setUploadCaption("");
      setUploadTags("");
      toast({ title: "Uploaded", description: "Photos added to the project." });
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", description: "Logging in again...", variant: "destructive" });
        setTimeout(() => { window.location.href = "/api/login"; }, 500);
        return;
      }
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const addComment = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/media/${selectedMedia!.id}/comments`, {
        content: newComment,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/media", selectedMedia?.id?.toString() || "", "comments"] });
      setNewComment("");
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
        toast({ title: "Unauthorized", description: "Logging in again...", variant: "destructive" });
        setTimeout(() => { window.location.href = "/api/login"; }, 500);
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

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 space-y-6 max-w-6xl mx-auto">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-48 rounded-md" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6">
        <Button variant="ghost" onClick={() => navigate("/")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Projects
        </Button>
        <div className="text-center mt-12">
          <h2 className="text-xl font-semibold">Project not found</h2>
        </div>
      </div>
    );
  }

  const { project, media: projectMedia, tasks: projectTasks } = data;

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")} data-testid="button-back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full" style={{ backgroundColor: project.color || "#3B82F6" }} />
              <h1 className="text-2xl font-bold tracking-tight" data-testid="text-project-name">{project.name}</h1>
            </div>
            {project.description && (
              <p className="text-sm text-muted-foreground mt-1 max-w-2xl">{project.description}</p>
            )}
            <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
              {project.address && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {project.address}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Created {new Date(project.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      </div>

      <Tabs defaultValue="photos" className="space-y-4">
        <TabsList data-testid="tabs-project-detail">
          <TabsTrigger value="photos" data-testid="tab-photos">
            <Camera className="h-4 w-4 mr-1.5" />
            Photos ({projectMedia.length})
          </TabsTrigger>
          <TabsTrigger value="tasks" data-testid="tab-tasks">
            <ClipboardList className="h-4 w-4 mr-1.5" />
            Tasks ({projectTasks.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="photos" className="space-y-4">
          <Card className="p-4">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  placeholder="Add a caption..."
                  value={uploadCaption}
                  onChange={(e) => setUploadCaption(e.target.value)}
                  className="flex-1 min-w-[200px]"
                  data-testid="input-upload-caption"
                />
                <Input
                  placeholder="Tags (comma separated)"
                  value={uploadTags}
                  onChange={(e) => setUploadTags(e.target.value)}
                  className="w-[200px]"
                  data-testid="input-upload-tags"
                />
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
          </Card>

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
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {projectMedia.map((item) => (
                <Card
                  key={item.id}
                  className="overflow-visible cursor-pointer hover-elevate group"
                  onClick={() => setSelectedMedia(item)}
                  data-testid={`card-media-${item.id}`}
                >
                  <div className="aspect-square overflow-hidden rounded-t-md">
                    <img
                      src={item.url}
                      alt={item.caption || item.originalName}
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  </div>
                  <div className="p-2.5 space-y-1">
                    {item.caption && (
                      <p className="text-xs font-medium truncate">{item.caption}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-1">
                      {item.tags && item.tags.slice(0, 2).map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(item.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="tasks" className="space-y-4">
          <Card className="p-4">
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
          </Card>

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
                  <Card key={task.id} className="p-4" data-testid={`card-task-${task.id}`}>
                    <div className="flex items-center gap-3">
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
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={!!selectedMedia} onOpenChange={(open) => !open && setSelectedMedia(null)}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Camera className="h-4 w-4" />
              {selectedMedia?.caption || selectedMedia?.originalName || "Photo Detail"}
            </DialogTitle>
          </DialogHeader>
          {selectedMedia && (
            <div className="space-y-4">
              <div className="rounded-md overflow-hidden bg-muted">
                <img
                  src={selectedMedia.url}
                  alt={selectedMedia.caption || ""}
                  className="w-full h-auto max-h-[50vh] object-contain"
                />
              </div>

              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  {new Date(selectedMedia.createdAt).toLocaleString()}
                </span>
                {selectedMedia.latitude && selectedMedia.longitude && (
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5" />
                    {selectedMedia.latitude.toFixed(4)}, {selectedMedia.longitude.toFixed(4)}
                  </span>
                )}
              </div>

              {selectedMedia.tags && selectedMedia.tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                  {selectedMedia.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                  ))}
                </div>
              )}

              <div className="border-t pt-4 space-y-3">
                <h4 className="text-sm font-semibold flex items-center gap-1.5">
                  <MessageSquare className="h-4 w-4" />
                  Comments
                </h4>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {(mediaComments || []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No comments yet.</p>
                  ) : (
                    (mediaComments || []).map((comment) => (
                      <div key={comment.id} className="flex gap-2 text-sm" data-testid={`comment-${comment.id}`}>
                        <div className="shrink-0 h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                          {(comment.user?.firstName || "U")[0]}
                        </div>
                        <div>
                          <span className="font-medium">
                            {comment.user?.firstName} {comment.user?.lastName}
                          </span>
                          <span className="text-muted-foreground ml-2 text-xs">
                            {new Date(comment.createdAt).toLocaleString()}
                          </span>
                          <p className="text-muted-foreground mt-0.5">{comment.content}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Add a comment..."
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newComment.trim()) addComment.mutate();
                    }}
                    data-testid="input-new-comment"
                  />
                  <Button
                    size="icon"
                    onClick={() => { if (newComment.trim()) addComment.mutate(); }}
                    disabled={addComment.isPending || !newComment.trim()}
                    data-testid="button-send-comment"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
