import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import {
  X,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Tag,
  MessageSquare,
  PlusCircle,
  ClipboardList,
  Pencil,
  Maximize2,
  Download,
  Undo2,
  Trash2,
} from "lucide-react";
import type { Media, Comment, Task, Project } from "@shared/schema";

type MediaWithUser = Media & {
  uploadedBy?: {
    firstName: string | null;
    lastName: string | null;
    profileImageUrl: string | null;
  };
};

type CommentWithUser = Comment & {
  user?: {
    firstName: string | null;
    lastName: string | null;
    profileImageUrl: string | null;
  };
};

interface PhotoViewerProps {
  media: MediaWithUser;
  allMedia: MediaWithUser[];
  project: Project;
  tasks: Task[];
  onClose: () => void;
  onNavigate: (media: MediaWithUser) => void;
}

type AnnotationPoint = { x: number; y: number };
type AnnotationLine = { points: AnnotationPoint[]; color: string; width: number };

export default function PhotoViewer({
  media,
  allMedia,
  project,
  tasks,
  onClose,
  onNavigate,
}: PhotoViewerProps) {
  const { toast } = useToast();
  const [photoOnlyMode, setPhotoOnlyMode] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<AnnotationLine[]>([]);
  const [currentLine, setCurrentLine] = useState<AnnotationLine | null>(null);
  const [annotationColor] = useState("#ff3b30");
  const [annotationWidth] = useState(3);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const currentIndex = allMedia.findIndex((m) => m.id === media.id);

  const { data: mediaComments } = useQuery<CommentWithUser[]>({
    queryKey: ["/api/media", media.id.toString(), "comments"],
  });

  const addComment = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/media/${media.id}/comments`, {
        content: newComment,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/media", media.id.toString(), "comments"],
      });
      setNewComment("");
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/api/login"; }, 500);
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const getInitials = (firstName: string | null, lastName: string | null) => {
    return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
  };

  const goToPrev = useCallback(() => {
    if (currentIndex > 0) {
      setAnnotations([]);
      setCurrentLine(null);
      onNavigate(allMedia[currentIndex - 1]);
    }
  }, [currentIndex, allMedia, onNavigate]);

  const goToNext = useCallback(() => {
    if (currentIndex < allMedia.length - 1) {
      setAnnotations([]);
      setCurrentLine(null);
      onNavigate(allMedia[currentIndex + 1]);
    }
  }, [currentIndex, allMedia, onNavigate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (photoOnlyMode) {
          setPhotoOnlyMode(false);
        } else {
          onClose();
        }
      } else if (e.key === "ArrowLeft") {
        goToPrev();
      } else if (e.key === "ArrowRight") {
        goToNext();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, photoOnlyMode, goToPrev, goToNext]);

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const allLines = [...annotations, ...(currentLine ? [currentLine] : [])];
    for (const line of allLines) {
      if (line.points.length < 2) continue;
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(
        line.points[0].x * canvas.width,
        line.points[0].y * canvas.height
      );
      for (let i = 1; i < line.points.length; i++) {
        ctx.lineTo(
          line.points[i].x * canvas.width,
          line.points[i].y * canvas.height
        );
      }
      ctx.stroke();
    }
  }, [annotations, currentLine]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  const getRelativePos = (e: React.MouseEvent | React.TouchEvent): AnnotationPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    let clientX: number, clientY: number;
    if ("touches" in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    };
  };

  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isAnnotating) return;
    e.preventDefault();
    const pos = getRelativePos(e);
    if (!pos) return;
    setCurrentLine({ points: [pos], color: annotationColor, width: annotationWidth });
  };

  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isAnnotating || !currentLine) return;
    e.preventDefault();
    const pos = getRelativePos(e);
    if (!pos) return;
    setCurrentLine((prev) =>
      prev ? { ...prev, points: [...prev.points, pos] } : null
    );
  };

  const handlePointerUp = () => {
    if (!isAnnotating || !currentLine) return;
    if (currentLine.points.length > 1) {
      setAnnotations((prev) => [...prev, currentLine]);
    }
    setCurrentLine(null);
  };

  const undoAnnotation = () => {
    setAnnotations((prev) => prev.slice(0, -1));
  };

  const clearAnnotations = () => {
    setAnnotations([]);
  };

  const renderPhotoArea = (fullscreen: boolean) => (
    <div
      ref={containerRef}
      className={`relative flex items-center justify-center ${fullscreen ? "w-full h-full" : "flex-1 min-h-0"} bg-black/95 select-none`}
      data-testid="photo-viewer-image-area"
    >
      <div className="relative inline-block max-w-full max-h-full">
        <img
          ref={imageRef}
          src={media.url}
          alt={media.caption || media.originalName}
          className={`${fullscreen ? "max-h-screen" : "max-h-[calc(100vh-4rem)]"} max-w-full object-contain`}
          onLoad={redrawCanvas}
          draggable={false}
          data-testid="photo-viewer-image"
        />
        <canvas
          ref={canvasRef}
          className={`absolute inset-0 w-full h-full ${isAnnotating ? "cursor-crosshair" : "cursor-default"}`}
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
          data-testid="photo-viewer-canvas"
        />
      </div>

      {currentIndex > 0 && (
        <Button
          variant="outline"
          size="icon"
          onClick={goToPrev}
          className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 dark:bg-black/70 border-white/90 dark:border-black/70 shadow-md"
          data-testid="button-photo-prev"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
      )}
      {currentIndex < allMedia.length - 1 && (
        <Button
          variant="outline"
          size="icon"
          onClick={goToNext}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 dark:bg-black/70 border-white/90 dark:border-black/70 shadow-md"
          data-testid="button-photo-next"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      )}

      <div className="absolute top-3 left-3 flex items-center gap-1 bg-white/90 dark:bg-black/70 rounded-md shadow-md p-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsAnnotating(!isAnnotating)}
          className={`rounded ${isAnnotating ? "bg-primary text-primary-foreground" : ""}`}
          title="Annotate"
          data-testid="button-annotate"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setPhotoOnlyMode(!photoOnlyMode)}
          title="Fullscreen"
          data-testid="button-fullscreen"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            const link = document.createElement("a");
            link.href = media.url;
            link.download = media.originalName;
            link.click();
          }}
          title="Download"
          data-testid="button-download"
        >
          <Download className="h-4 w-4" />
        </Button>
        {isAnnotating && (
          <>
            <div className="w-px h-6 bg-black/20 dark:bg-white/20 mx-0.5" />
            <Button
              variant="ghost"
              size="icon"
              onClick={undoAnnotation}
              disabled={annotations.length === 0}
              title="Undo"
              data-testid="button-undo-annotation"
            >
              <Undo2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={clearAnnotations}
              disabled={annotations.length === 0}
              title="Clear all"
              data-testid="button-clear-annotations"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      {!photoOnlyMode && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-white/90 dark:bg-black/70 rounded-md px-3 py-1.5 text-xs text-black dark:text-white shadow">
          {currentIndex + 1} / {allMedia.length}
        </div>
      )}
    </div>
  );

  if (photoOnlyMode) {
    return (
      <div className="fixed inset-0 z-[100] bg-black flex flex-col" data-testid="photo-viewer-fullscreen">
        <div className="absolute top-3 right-3 z-10">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setPhotoOnlyMode(false)}
            className="rounded-full bg-white/90 dark:bg-black/70 border-white/90 dark:border-black/70 shadow-md"
            data-testid="button-exit-fullscreen"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        {renderPhotoArea(true)}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-white/90 dark:bg-black/70 rounded-md px-3 py-1.5 text-xs text-black dark:text-white shadow">
          {currentIndex + 1} / {allMedia.length}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] bg-background flex" data-testid="photo-viewer-overlay">
      <div className="flex-1 flex flex-col min-w-0 bg-black">
        <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 bg-black/80">
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-white/80"
            data-testid="button-close-viewer"
          >
            <X className="h-5 w-5" />
          </Button>
          <span className="text-xs text-white/60">
            {currentIndex + 1} of {allMedia.length}
          </span>
        </div>
        {renderPhotoArea(false)}
      </div>

      <div className="w-80 xl:w-96 shrink-0 border-l bg-background overflow-y-auto hidden lg:block" data-testid="photo-viewer-sidebar">
        <div className="p-4 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold" data-testid="text-viewer-project-name">
                {project.name}
              </h2>
              {project.address && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {project.address}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              data-testid="button-close-viewer-sidebar"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {media.uploadedBy && (
            <div className="flex items-center gap-2">
              <Avatar className="h-7 w-7">
                <AvatarImage src={media.uploadedBy.profileImageUrl || undefined} />
                <AvatarFallback className="text-[9px] bg-primary/10 text-primary">
                  {getInitials(media.uploadedBy.firstName, media.uploadedBy.lastName)}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-medium">
                  {media.uploadedBy.firstName} {media.uploadedBy.lastName}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(media.createdAt).toLocaleString("en-US", {
                    month: "2-digit",
                    day: "2-digit",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                  })}
                </p>
              </div>
            </div>
          )}

          {media.tags && media.tags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Tag className="h-3.5 w-3.5 text-muted-foreground" />
              {media.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : (
            <Button variant="ghost" size="sm" className="text-primary" data-testid="button-add-tags">
              <Tag className="h-3.5 w-3.5 mr-1" />
              Add Tags
            </Button>
          )}

          <div className="border-t pt-4 space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <ClipboardList className="h-3.5 w-3.5" />
              Tasks
            </h3>
            {tasks.length > 0 ? (
              <div className="space-y-1">
                {tasks.slice(0, 3).map((task) => (
                  <p key={task.id} className="text-sm text-muted-foreground truncate">
                    {task.title}
                  </p>
                ))}
                {tasks.length > 3 && (
                  <p className="text-xs text-muted-foreground">+{tasks.length - 3} more</p>
                )}
              </div>
            ) : (
              <Button variant="ghost" size="sm" className="text-primary" data-testid="button-new-task-viewer">
                <PlusCircle className="h-3.5 w-3.5 mr-1" />
                New Task
              </Button>
            )}
          </div>

          <div className="border-t pt-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Description</h3>
              <Button variant="ghost" size="sm" className="text-primary" data-testid="button-edit-description">
                Edit
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {media.caption || "Add a description..."}
            </p>
          </div>

          {(media.latitude || media.longitude) && (
            <div className="border-t pt-4">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {media.latitude?.toFixed(4)}, {media.longitude?.toFixed(4)}
              </p>
            </div>
          )}

          <div className="border-t pt-4 space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" />
              Comments
            </h3>
            <div className="space-y-3 max-h-[250px] overflow-y-auto">
              {(mediaComments || []).length === 0 ? (
                <p className="text-sm text-muted-foreground">No comments yet.</p>
              ) : (
                (mediaComments || []).map((comment) => (
                  <div key={comment.id} className="flex gap-2 text-sm" data-testid={`comment-${comment.id}`}>
                    <Avatar className="h-6 w-6 shrink-0">
                      <AvatarImage src={comment.user?.profileImageUrl || undefined} />
                      <AvatarFallback className="text-[9px]">
                        {(comment.user?.firstName || "U")[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <span className="font-medium text-xs">
                        {comment.user?.firstName} {comment.user?.lastName}
                      </span>
                      <p className="text-muted-foreground text-xs mt-0.5">{comment.content}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="space-y-2">
              <Textarea
                placeholder="Add a comment..."
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                className="text-sm min-h-[60px] resize-none"
                data-testid="input-viewer-comment"
              />
              <Button
                variant="ghost"
                size="sm"
                className="text-primary"
                onClick={() => { if (newComment.trim()) addComment.mutate(); }}
                disabled={addComment.isPending || !newComment.trim()}
                data-testid="button-post-viewer-comment"
              >
                Post
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
