import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ArrowUpRight,
  Circle as CircleIcon,
  Square,
  Minus,
  Check,
  Plus,
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
type AnnotationTool = "freehand" | "arrow" | "circle" | "rectangle" | "line";
type AnnotationShape =
  | { type: "freehand"; points: AnnotationPoint[]; color: string; width: number }
  | { type: "arrow"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: "circle"; center: AnnotationPoint; radius: AnnotationPoint; color: string; width: number }
  | { type: "rectangle"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: "line"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number };

const ANNOTATION_COLORS = [
  { name: "Red", value: "#ff3b30" },
  { name: "Green", value: "#34c759" },
  { name: "Blue", value: "#007aff" },
  { name: "Yellow", value: "#ffcc00" },
  { name: "Orange", value: "#F09000" },
  { name: "Purple", value: "#af52de" },
  { name: "White", value: "#ffffff" },
  { name: "Black", value: "#000000" },
];

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
  const [annotations, setAnnotations] = useState<AnnotationShape[]>([]);
  const [currentShape, setCurrentShape] = useState<AnnotationShape | null>(null);
  const [annotationColor, setAnnotationColor] = useState("#ff3b30");
  const [annotationWidth, setAnnotationWidth] = useState(3);
  const [annotationTool, setAnnotationToolRaw] = useState<AnnotationTool>("freehand");
  const [drawStart, setDrawStart] = useState<AnnotationPoint | null>(null);
  const setAnnotationTool = useCallback((tool: AnnotationTool) => {
    setCurrentShape(null);
    setDrawStart(null);
    setAnnotationToolRaw(tool);
  }, []);
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
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionText, setDescriptionText] = useState(media.caption || "");
  const [editingTags, setEditingTags] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>(media.tags || []);

  const { data: accountPhotoTags } = useQuery<{ id: number; name: string; type: string }[]>({
    queryKey: ["/api/tags", { type: "photo" }],
    queryFn: async () => {
      const res = await fetch("/api/tags?type=photo", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  useEffect(() => {
    setDescriptionText(media.caption || "");
    setSelectedTags(media.tags || []);
    setEditingDescription(false);
    setEditingTags(false);
  }, [media.id, media.caption, media.tags]);

  const updateMedia = useMutation({
    mutationFn: async (data: { caption?: string; tags?: string[] }) => {
      const res = await apiRequest("PATCH", `/api/media/${media.id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", project.id.toString(), "media"] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", project.id.toString()] });
      queryClient.invalidateQueries({ queryKey: ["/api/media"] });
      toast({ title: "Updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const saveDescription = () => {
    updateMedia.mutate({ caption: descriptionText });
    setEditingDescription(false);
  };

  const displayCaption = editingDescription ? descriptionText : (descriptionText || media.caption || "");

  const toggleTag = (tagName: string) => {
    const newTags = selectedTags.includes(tagName)
      ? selectedTags.filter(t => t !== tagName)
      : [...selectedTags, tagName];
    setSelectedTags(newTags);
    updateMedia.mutate({ tags: newTags });
  };

  const removeTag = (tagName: string) => {
    const newTags = selectedTags.filter(t => t !== tagName);
    setSelectedTags(newTags);
    updateMedia.mutate({ tags: newTags });
  };

  const getInitials = (firstName: string | null, lastName: string | null) => {
    return `${(firstName || "")[0] || ""}${(lastName || "")[0] || ""}`.toUpperCase() || "U";
  };

  const goToPrev = useCallback(() => {
    if (currentIndex > 0) {
      setAnnotations([]);
      setCurrentShape(null);
      setDrawStart(null);
      onNavigate(allMedia[currentIndex - 1]);
    }
  }, [currentIndex, allMedia, onNavigate]);

  const goToNext = useCallback(() => {
    if (currentIndex < allMedia.length - 1) {
      setAnnotations([]);
      setCurrentShape(null);
      setDrawStart(null);
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

  const drawShape = useCallback((ctx: CanvasRenderingContext2D, shape: AnnotationShape, w: number, h: number) => {
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (shape.type === "freehand") {
      if (shape.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(shape.points[0].x * w, shape.points[0].y * h);
      for (let i = 1; i < shape.points.length; i++) {
        ctx.lineTo(shape.points[i].x * w, shape.points[i].y * h);
      }
      ctx.stroke();
    } else if (shape.type === "line") {
      ctx.beginPath();
      ctx.moveTo(shape.start.x * w, shape.start.y * h);
      ctx.lineTo(shape.end.x * w, shape.end.y * h);
      ctx.stroke();
    } else if (shape.type === "arrow") {
      const sx = shape.start.x * w, sy = shape.start.y * h;
      const ex = shape.end.x * w, ey = shape.end.y * h;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      const angle = Math.atan2(ey - sy, ex - sx);
      const headLen = Math.max(12, shape.width * 4);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - headLen * Math.cos(angle - Math.PI / 6), ey - headLen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - headLen * Math.cos(angle + Math.PI / 6), ey - headLen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    } else if (shape.type === "circle") {
      const cx = shape.center.x * w, cy = shape.center.y * h;
      const rx = shape.radius.x * w, ry = shape.radius.y * h;
      const r = Math.sqrt((rx - cx) ** 2 + (ry - cy) ** 2);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    } else if (shape.type === "rectangle") {
      const x1 = shape.start.x * w, y1 = shape.start.y * h;
      const x2 = shape.end.x * w, y2 = shape.end.y * h;
      ctx.beginPath();
      ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.stroke();
    }
  }, []);

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const allShapes = [...annotations, ...(currentShape ? [currentShape] : [])];
    for (const shape of allShapes) {
      drawShape(ctx, shape, canvas.width, canvas.height);
    }
  }, [annotations, currentShape, drawShape]);

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

    if (annotationTool === "freehand") {
      setCurrentShape({ type: "freehand", points: [pos], color: annotationColor, width: annotationWidth });
    } else {
      setDrawStart(pos);
      if (annotationTool === "arrow") {
        setCurrentShape({ type: "arrow", start: pos, end: pos, color: annotationColor, width: annotationWidth });
      } else if (annotationTool === "circle") {
        setCurrentShape({ type: "circle", center: pos, radius: pos, color: annotationColor, width: annotationWidth });
      } else if (annotationTool === "rectangle") {
        setCurrentShape({ type: "rectangle", start: pos, end: pos, color: annotationColor, width: annotationWidth });
      } else if (annotationTool === "line") {
        setCurrentShape({ type: "line", start: pos, end: pos, color: annotationColor, width: annotationWidth });
      }
    }
  };

  const handlePointerMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isAnnotating || !currentShape) return;
    e.preventDefault();
    const pos = getRelativePos(e);
    if (!pos) return;

    if (currentShape.type === "freehand") {
      setCurrentShape((prev) =>
        prev && prev.type === "freehand" ? { ...prev, points: [...prev.points, pos] } : prev
      );
    } else if (drawStart) {
      setCurrentShape((prev) => {
        if (!prev) return prev;
        if (prev.type === "arrow" || prev.type === "line" || prev.type === "rectangle") {
          return { ...prev, end: pos };
        } else if (prev.type === "circle") {
          return { ...prev, radius: pos };
        }
        return prev;
      });
    }
  };

  const handlePointerUp = () => {
    if (!isAnnotating || !currentShape) return;
    const isValid = currentShape.type === "freehand"
      ? currentShape.points.length > 1
      : true;
    if (isValid) {
      setAnnotations((prev) => [...prev, currentShape]);
    }
    setCurrentShape(null);
    setDrawStart(null);
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
        <div className="absolute left-3 top-0 bottom-0 flex items-center pointer-events-none">
          <Button
            variant="outline"
            size="icon"
            onClick={goToPrev}
            className="pointer-events-auto rounded-full bg-white/90 dark:bg-black/70 border-white/90 dark:border-black/70 shadow-md"
            data-testid="button-photo-prev"
          >
            <ChevronLeft className="h-5 w-5" />
          </Button>
        </div>
      )}
      {currentIndex < allMedia.length - 1 && (
        <div className="absolute right-3 top-0 bottom-0 flex items-center pointer-events-none">
          <Button
            variant="outline"
            size="icon"
            onClick={goToNext}
            className="pointer-events-auto rounded-full bg-white/90 dark:bg-black/70 border-white/90 dark:border-black/70 shadow-md"
            data-testid="button-photo-next"
          >
            <ChevronRight className="h-5 w-5" />
          </Button>
        </div>
      )}

      <div className="absolute top-3 left-3 flex flex-col gap-1.5" data-testid="annotation-toolbar">
        <div className="flex items-center gap-1 bg-white/90 dark:bg-black/70 rounded-md shadow-md p-1">
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

        {isAnnotating && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1 bg-white/90 dark:bg-black/70 rounded-md shadow-md p-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setAnnotationTool("freehand")}
                className={`rounded ${annotationTool === "freehand" ? "bg-primary text-primary-foreground" : ""}`}
                title="Freehand"
                data-testid="button-tool-freehand"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setAnnotationTool("arrow")}
                className={`rounded ${annotationTool === "arrow" ? "bg-primary text-primary-foreground" : ""}`}
                title="Arrow"
                data-testid="button-tool-arrow"
              >
                <ArrowUpRight className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setAnnotationTool("circle")}
                className={`rounded ${annotationTool === "circle" ? "bg-primary text-primary-foreground" : ""}`}
                title="Circle"
                data-testid="button-tool-circle"
              >
                <CircleIcon className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setAnnotationTool("rectangle")}
                className={`rounded ${annotationTool === "rectangle" ? "bg-primary text-primary-foreground" : ""}`}
                title="Rectangle"
                data-testid="button-tool-rectangle"
              >
                <Square className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setAnnotationTool("line")}
                className={`rounded ${annotationTool === "line" ? "bg-primary text-primary-foreground" : ""}`}
                title="Line"
                data-testid="button-tool-line"
              >
                <Minus className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center gap-1 bg-white/90 dark:bg-black/70 rounded-md shadow-md p-1">
              {ANNOTATION_COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setAnnotationColor(c.value)}
                  className={`w-6 h-6 rounded-full border-2 shrink-0 transition-transform ${
                    annotationColor === c.value ? "border-white scale-110 ring-1 ring-black/40" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c.value }}
                  title={c.name}
                  data-testid={`button-color-${c.name.toLowerCase()}`}
                />
              ))}
            </div>

            <div className="flex items-center gap-2 bg-white/90 dark:bg-black/70 rounded-md shadow-md px-2 py-1">
              <span className="text-[10px] font-medium text-black dark:text-white whitespace-nowrap">Size</span>
              <input
                type="range"
                min={1}
                max={8}
                value={annotationWidth}
                onChange={(e) => setAnnotationWidth(Number(e.target.value))}
                className="w-20 h-1 accent-current"
                style={{ color: annotationColor }}
                data-testid="slider-stroke-width"
              />
              <div
                className="rounded-full shrink-0"
                style={{ width: annotationWidth * 2 + 4, height: annotationWidth * 2 + 4, backgroundColor: annotationColor }}
              />
            </div>
          </div>
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

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5" />
                Tags
              </h3>
              <Button
                variant="ghost"
                size="sm"
                className="text-primary h-7 text-xs"
                onClick={() => setEditingTags(!editingTags)}
                data-testid="button-edit-tags"
              >
                {editingTags ? "Done" : "Edit"}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {selectedTags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs gap-1" data-testid={`badge-tag-${tag}`}>
                  {tag}
                  {editingTags && (
                    <X className="h-3 w-3 cursor-pointer hover:text-destructive" onClick={() => removeTag(tag)} />
                  )}
                </Badge>
              ))}
              {selectedTags.length === 0 && !editingTags && (
                <span className="text-xs text-muted-foreground">No tags</span>
              )}
            </div>
            {editingTags && (
              <div className="space-y-1.5">
                {(accountPhotoTags || []).filter(t => !selectedTags.includes(t.name)).length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {(accountPhotoTags || []).filter(t => !selectedTags.includes(t.name)).map(t => (
                      <Badge
                        key={t.id}
                        variant="outline"
                        className="text-xs cursor-pointer hover:bg-primary/10"
                        onClick={() => toggleTag(t.name)}
                        data-testid={`badge-add-tag-${t.name}`}
                      >
                        <Plus className="h-2.5 w-2.5 mr-0.5" />
                        {t.name}
                      </Badge>
                    ))}
                  </div>
                )}
                {(accountPhotoTags || []).length === 0 && (
                  <p className="text-[10px] text-muted-foreground">No photo tags defined. Add them in Settings.</p>
                )}
              </div>
            )}
          </div>

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
              {editingDescription ? (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="text-primary h-7 text-xs" onClick={saveDescription} data-testid="button-save-description">
                    <Check className="h-3 w-3 mr-0.5" /> Save
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEditingDescription(false); setDescriptionText(media.caption || ""); }} data-testid="button-cancel-description">
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" className="text-primary h-7 text-xs" onClick={() => setEditingDescription(true)} data-testid="button-edit-description">
                  Edit
                </Button>
              )}
            </div>
            {editingDescription ? (
              <Textarea
                value={descriptionText}
                onChange={(e) => setDescriptionText(e.target.value)}
                placeholder="Add a description..."
                className="text-sm min-h-[60px] resize-none"
                data-testid="input-photo-description"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {displayCaption || "No description"}
              </p>
            )}
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
