import { useState, useRef, useCallback, useEffect, type CSSProperties } from "react";
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
  Eye,
  EyeOff,
  Eraser,
  Type,
} from "lucide-react";
import type { Media, Comment, Task, Project, MediaAnnotation, AnnotationStroke } from "@shared/schema";
import { useAuth } from "@/hooks/use-auth";
import { AnnotationOverlay } from "@/lib/annotation-svg";

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
type AnnotationTool = "freehand" | "arrow" | "circle" | "rectangle" | "line" | "eraser" | "text";

const ERASER_THRESHOLD = 0.015;

function dist(a: AnnotationPoint, b: AnnotationPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distToSegment(p: AnnotationPoint, a: AnnotationPoint, b: AnnotationPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function shapeHit(shape: AnnotationShape, p: AnnotationPoint, threshold: number): boolean {
  if (shape.type === "freehand") {
    for (let i = 0; i < shape.points.length - 1; i++) {
      if (distToSegment(p, shape.points[i], shape.points[i + 1]) < threshold) return true;
    }
    return false;
  }
  if (shape.type === "arrow" || shape.type === "line") {
    return distToSegment(p, shape.start, shape.end) < threshold;
  }
  if (shape.type === "rectangle") {
    const { start: s, end: e } = shape;
    const x1 = Math.min(s.x, e.x), x2 = Math.max(s.x, e.x);
    const y1 = Math.min(s.y, e.y), y2 = Math.max(s.y, e.y);
    const tl = { x: x1, y: y1 }, tr = { x: x2, y: y1 };
    const bl = { x: x1, y: y2 }, br = { x: x2, y: y2 };
    return (
      distToSegment(p, tl, tr) < threshold ||
      distToSegment(p, tr, br) < threshold ||
      distToSegment(p, br, bl) < threshold ||
      distToSegment(p, bl, tl) < threshold
    );
  }
  if (shape.type === "circle") {
    const r = dist(shape.center, shape.radius);
    return Math.abs(dist(shape.center, p) - r) < threshold;
  }
  return false;
}
type AnnotationShape =
  | { type: "freehand"; points: AnnotationPoint[]; color: string; width: number }
  | { type: "arrow"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: "circle"; center: AnnotationPoint; radius: AnnotationPoint; color: string; width: number }
  | { type: "rectangle"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: "line"; start: AnnotationPoint; end: AnnotationPoint; color: string; width: number }
  | { type: "text"; id: string; x: number; y: number; content: string; color: string; fontSize: number };

type TextAnnotation = Extract<AnnotationStroke, { type: "text" }>;
const isTextStroke = (s: AnnotationStroke): s is TextAnnotation => s.type === "text";
const isTextShape = (s: AnnotationShape): s is Extract<AnnotationShape, { type: "text" }> => s.type === "text";

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function shapeToStroke(shape: AnnotationShape): AnnotationStroke {
  if (shape.type === "text") {
    return { id: shape.id, type: "text", x: shape.x, y: shape.y, content: shape.content, color: shape.color, fontSize: shape.fontSize };
  }
  if (shape.type === "freehand") {
    return { id: newId(), type: "pencil", color: shape.color, width: shape.width, points: shape.points };
  }
  if (shape.type === "circle") {
    return { id: newId(), type: "circle", color: shape.color, width: shape.width, points: [shape.center, shape.radius] };
  }
  return { id: newId(), type: shape.type, color: shape.color, width: shape.width, points: [shape.start, shape.end] };
}

function strokeToShape(stroke: AnnotationStroke): AnnotationShape {
  if (stroke.type === "text") {
    return { type: "text", id: stroke.id, x: stroke.x, y: stroke.y, content: stroke.content, color: stroke.color, fontSize: stroke.fontSize };
  }
  const { color, width, points } = stroke;
  if (stroke.type === "pencil") {
    return { type: "freehand", color, width, points };
  }
  const [a, b] = points;
  const safeA = a || { x: 0, y: 0 };
  const safeB = b || safeA;
  if (stroke.type === "circle") {
    return { type: "circle", color, width, center: safeA, radius: safeB };
  }
  return { type: stroke.type, color, width, start: safeA, end: safeB };
}

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
  const { user: currentUser } = useAuth();
  const [photoOnlyMode, setPhotoOnlyMode] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [annotations, setAnnotations] = useState<AnnotationShape[]>([]);
  const [currentShape, setCurrentShape] = useState<AnnotationShape | null>(null);
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [annotationColor, setAnnotationColor] = useState("#ff3b30");
  const [annotationWidth, setAnnotationWidth] = useState(3);
  const [annotationFontSize, setAnnotationFontSize] = useState(18);
  const [annotationTool, setAnnotationToolRaw] = useState<AnnotationTool>("freehand");
  const [drawStart, setDrawStart] = useState<AnnotationPoint | null>(null);
  const [textInput, setTextInput] = useState<{ x: number; y: number; content: string; editingId: string | null } | null>(null);
  const setAnnotationTool = useCallback((tool: AnnotationTool) => {
    setCurrentShape(null);
    setDrawStart(null);
    setAnnotationToolRaw(tool);
  }, []);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [imageRectStyle, setImageRectStyle] = useState<CSSProperties>({});

  const recomputeImageRect = useCallback(() => {
    const container = containerRef.current;
    const img = imageRef.current;
    if (!container || !img) return;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    const ar = img.naturalWidth / img.naturalHeight;
    const cAr = cw / ch;
    let w: number, h: number;
    if (ar > cAr) {
      w = cw;
      h = cw / ar;
    } else {
      h = ch;
      w = ch * ar;
    }
    setImageRectStyle({
      position: "absolute",
      left: (cw - w) / 2,
      top: (ch - h) / 2,
      width: w,
      height: h,
    });
  }, []);

  useEffect(() => {
    recomputeImageRect();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(recomputeImageRect);
    ro.observe(container);
    return () => ro.disconnect();
  }, [recomputeImageRect, media.id]);

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

  const { data: savedAnnotations = [] } = useQuery<(MediaAnnotation & { user?: { firstName: string | null; lastName: string | null; profileImageUrl: string | null } })[]>({
    queryKey: ["/api/media", media.id.toString(), "annotations"],
  });

  const allDisplayedStrokes: AnnotationStroke[] = (savedAnnotations || []).flatMap((a) => {
    if (editingAnnotationId && a.id === editingAnnotationId) return [];
    return Array.isArray(a.strokes) ? (a.strokes as AnnotationStroke[]) : [];
  });

  const myExistingAnnotation = (savedAnnotations || []).find(
    (a) => currentUser?.id && a.userId === currentUser.id,
  );

  const saveAnnotation = useMutation({
    mutationFn: async () => {
      const strokes = annotations.map(shapeToStroke);
      if (editingAnnotationId && strokes.length === 0) {
        await apiRequest("DELETE", `/api/annotations/${editingAnnotationId}`);
        return null;
      }
      if (editingAnnotationId) {
        const res = await apiRequest(
          "PUT",
          `/api/annotations/${editingAnnotationId}`,
          { strokes },
        );
        return res.json();
      }
      const res = await apiRequest(
        "POST",
        `/api/media/${media.id}/annotations`,
        { strokes },
      );
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/media", media.id.toString(), "annotations"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/projects", project.id.toString(), "annotations"],
      });
      setAnnotations([]);
      setCurrentShape(null);
      setEditingAnnotationId(null);
      setIsAnnotating(false);
      toast({ title: "Annotations saved" });
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => { window.location.href = "/login"; }, 500);
        return;
      }
      toast({ title: "Could not save", description: error.message, variant: "destructive" });
    },
  });

  const deleteAnnotation = useMutation({
    mutationFn: async (annotationId: string) => {
      await apiRequest("DELETE", `/api/annotations/${annotationId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/media", media.id.toString(), "annotations"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/projects", project.id.toString(), "annotations"],
      });
      toast({ title: "Annotations removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not delete", description: error.message, variant: "destructive" });
    },
  });

  const deletePhoto = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/media/${media.id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", project.id.toString()] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects", project.id.toString(), "annotations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/media"] });
      toast({ title: "Photo deleted" });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Could not delete photo", description: error.message, variant: "destructive" });
    },
  });

  const startEditingMine = () => {
    if (!myExistingAnnotation) return;
    const strokes = Array.isArray(myExistingAnnotation.strokes)
      ? (myExistingAnnotation.strokes as AnnotationStroke[])
      : [];
    setAnnotations(strokes.map(strokeToShape));
    setEditingAnnotationId(myExistingAnnotation.id);
    setIsAnnotating(true);
    setShowOverlay(true);
  };

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

  const saveAnnotatedPhoto = useMutation({
    mutationFn: async () => {
      if (annotations.length === 0) throw new Error("No annotations to save");

      const blob: Blob = await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          const off = document.createElement("canvas");
          off.width = w;
          off.height = h;
          const ctx = off.getContext("2d");
          if (!ctx) return reject(new Error("Canvas context unavailable"));
          ctx.drawImage(img, 0, 0, w, h);
          for (const shape of annotations) {
            const scaled: AnnotationShape = isTextShape(shape)
              ? { ...shape, fontSize: Math.max(8, shape.fontSize * (Math.min(w, h) / 600)) }
              : ({ ...shape, width: Math.max(1, shape.width * (Math.min(w, h) / 600)) } as AnnotationShape);
            drawShape(ctx, scaled, w, h);
          }
          off.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("Failed to encode image"))),
            "image/jpeg",
            0.92,
          );
        };
        img.onerror = () =>
          reject(new Error("Could not load image for export (CORS)"));
        img.src = media.url;
      });

      const baseName = (media.originalName || "photo").replace(/\.[^.]+$/, "");
      const fileName = `annotated-${baseName}-${Date.now()}.jpg`;

      const signRes = await fetch(`/api/uploads/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          files: [{ originalName: fileName, mimeType: "image/jpeg", fileSize: blob.size }],
        }),
      });
      if (!signRes.ok) throw new Error(await signRes.text());
      const signed: Array<{ key: string; uploadUrl: string; publicUrl: string }> =
        await signRes.json();

      const putRes = await fetch(signed[0].uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
      });
      if (!putRes.ok) throw new Error("Upload to storage failed");

      const finalizeRes = await fetch(`/api/projects/${project.id}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          files: [
            {
              key: signed[0].key,
              publicUrl: signed[0].publicUrl,
              originalName: fileName,
              mimeType: "image/jpeg",
            },
          ],
        }),
      });
      if (!finalizeRes.ok) throw new Error(await finalizeRes.text());
      return finalizeRes.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/projects", project.id.toString(), "media"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/projects", project.id.toString()],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/media"] });
      setAnnotations([]);
      setCurrentShape(null);
      setIsAnnotating(false);
      toast({
        title: "Annotations saved",
        description: "A new annotated photo was added to the project.",
      });
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", variant: "destructive" });
        setTimeout(() => {
          window.location.href = "/login";
        }, 500);
        return;
      }
      toast({
        title: "Could not save annotations",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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
    if (shape.type === "text") {
      ctx.save();
      ctx.font = `600 ${shape.fontSize}px Inter, system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillStyle = shape.color;
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 4;
      ctx.fillText(shape.content, shape.x * w, shape.y * h);
      ctx.restore();
      return;
    }
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
    if (!canvas) return;
    const w = Number(imageRectStyle.width) || 0;
    const h = Number(imageRectStyle.height) || 0;
    if (!w || !h) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const allShapes = [...annotations, ...(currentShape ? [currentShape] : [])];
    for (const shape of allShapes) {
      drawShape(ctx, shape, w, h);
    }
  }, [annotations, currentShape, drawShape, imageRectStyle]);

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

  const eraseAt = (pos: AnnotationPoint) => {
    setAnnotations((prev) => prev.filter((s) => !shapeHit(s, pos, ERASER_THRESHOLD)));
  };

  const getNormalizedClient = (clientX: number, clientY: number): AnnotationPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  };

  const DRAG_THRESHOLD_PX = 5;
  type TextDragSource =
    | { kind: "mine"; t: Extract<AnnotationShape, { type: "text" }> }
    | { kind: "saved"; row: MediaAnnotation; t: Extract<AnnotationStroke, { type: "text" }> };
  const dragStateRef = useRef<{
    textId: string;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    dragged: boolean;
    promoted: boolean;
    source: TextDragSource;
  } | null>(null);

  const handleTextPointerDown = (e: React.PointerEvent<HTMLDivElement>, source: TextDragSource) => {
    if (!isAnnotating) return;
    if (annotationTool !== "text" && annotationTool !== "eraser") return;
    e.stopPropagation();
    if (annotationTool === "eraser") {
      if (source.kind === "mine") {
        setAnnotations((prev) => prev.filter((s) => !(isTextShape(s) && s.id === source.t.id)));
      } else {
        handleSavedMineTextClick(source.row, source.t);
      }
      return;
    }
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    dragStateRef.current = {
      textId: source.t.id,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      dragged: false,
      promoted: source.kind === "mine",
      source,
    };
  };

  const handleTextPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.dragged && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return;
    drag.dragged = true;
    if (!drag.promoted && drag.source.kind === "saved") {
      const row = drag.source.row;
      const allStrokes = Array.isArray(row.strokes) ? (row.strokes as AnnotationStroke[]) : [];
      setAnnotations(allStrokes.map(strokeToShape));
      setEditingAnnotationId(row.id);
      drag.promoted = true;
    }
    const pos = getNormalizedClient(e.clientX, e.clientY);
    if (!pos) return;
    setAnnotations((prev) =>
      prev.map((s) => (isTextShape(s) && s.id === drag.textId ? { ...s, x: pos.x, y: pos.y } : s)),
    );
  };

  const handleTextPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    const wasDrag = drag.dragged;
    dragStateRef.current = null;
    if (wasDrag) return;
    // Click (no drag) — open the inline editor
    if (drag.source.kind === "mine") {
      const t = drag.source.t;
      setAnnotationFontSize(t.fontSize);
      setTextInput({ x: t.x, y: t.y, content: t.content, editingId: t.id });
    } else {
      handleSavedMineTextClick(drag.source.row, drag.source.t);
    }
  };

  const handlePointerDown = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isAnnotating) return;
    e.preventDefault();
    const pos = getRelativePos(e);
    if (!pos) return;

    if (annotationTool === "eraser") {
      setDrawStart(pos);
      eraseAt(pos);
      return;
    }

    if (annotationTool === "text") {
      setTextInput({ x: pos.x, y: pos.y, content: "", editingId: null });
      return;
    }

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
    if (!isAnnotating) return;
    if (annotationTool === "eraser" && drawStart) {
      e.preventDefault();
      const pos = getRelativePos(e);
      if (pos) eraseAt(pos);
      return;
    }
    if (!currentShape) return;
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
    if (!isAnnotating) return;
    if (annotationTool === "eraser") {
      setDrawStart(null);
      return;
    }
    if (!currentShape) return;
    const isValid = currentShape.type === "freehand"
      ? currentShape.points.length > 1
      : true;
    if (isValid) {
      setAnnotations((prev) => [...prev, currentShape]);
    }
    setCurrentShape(null);
    setDrawStart(null);
  };

  const commitTextInput = () => {
    setTextInput((prev) => {
      if (!prev) return null;
      const trimmed = prev.content.trim();
      if (!trimmed) return null;
      if (prev.editingId) {
        setAnnotations((shapes) =>
          shapes.map((s) =>
            isTextShape(s) && s.id === prev.editingId
              ? { ...s, content: trimmed, color: annotationColor, fontSize: annotationFontSize }
              : s,
          ),
        );
      } else {
        setAnnotations((shapes) => [
          ...shapes,
          { type: "text", id: newId(), x: prev.x, y: prev.y, content: trimmed, color: annotationColor, fontSize: annotationFontSize },
        ]);
      }
      return null;
    });
  };

  const handleTextNodeClick = (id: string, x: number, y: number, content: string, fontSize: number) => {
    if (!isAnnotating) return;
    if (annotationTool === "eraser") {
      setAnnotations((prev) => prev.filter((s) => !(isTextShape(s) && s.id === id)));
      return;
    }
    if (annotationTool === "text") {
      setAnnotationFontSize(fontSize);
      setTextInput({ x, y, content, editingId: id });
    }
  };

  // Saved (already-persisted) text node belonging to current user — promote to edit-mine then open input or delete.
  const handleSavedMineTextClick = (
    row: MediaAnnotation,
    t: Extract<AnnotationStroke, { type: "text" }>,
  ) => {
    if (!isAnnotating) return;
    if (annotationTool !== "text" && annotationTool !== "eraser") return;
    const allStrokes = Array.isArray(row.strokes) ? (row.strokes as AnnotationStroke[]) : [];
    if (annotationTool === "eraser") {
      const remaining = allStrokes.filter((s) => !(isTextStroke(s) && s.id === t.id));
      setAnnotations(remaining.map(strokeToShape));
      setEditingAnnotationId(row.id);
      return;
    }
    setAnnotations(allStrokes.map(strokeToShape));
    setEditingAnnotationId(row.id);
    setAnnotationFontSize(t.fontSize);
    setTextInput({ x: t.x, y: t.y, content: t.content, editingId: t.id });
  };

  const undoAnnotation = () => {
    setAnnotations((prev) => prev.slice(0, -1));
  };

  const clearAnnotations = () => {
    setAnnotations([]);
  };

  const isVideo = (media.mimeType ?? "").startsWith("video/");

  const renderPhotoArea = (fullscreen: boolean) => (
    <div
      ref={containerRef}
      className={`relative flex items-center justify-center ${fullscreen ? "w-full h-full" : "flex-1 min-h-0"} bg-black/95 select-none`}
      data-testid="photo-viewer-image-area"
    >
      {isVideo ? (
        <video
          src={media.url}
          controls
          playsInline
          className="absolute inset-0 w-full h-full object-contain"
          data-testid="photo-viewer-video"
        />
      ) : (
        <img
          ref={imageRef}
          src={media.url}
          alt={media.caption || media.originalName}
          className="absolute inset-0 w-full h-full object-contain"
          onLoad={recomputeImageRect}
          draggable={false}
          data-testid="photo-viewer-image"
        />
      )}
      {!isVideo && showOverlay && allDisplayedStrokes.length > 0 && (
        <AnnotationOverlay strokes={allDisplayedStrokes} style={imageRectStyle} />
      )}
      {!isVideo && (
        <canvas
          ref={canvasRef}
          style={imageRectStyle}
          className={isAnnotating ? "cursor-crosshair" : "cursor-default"}
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
          data-testid="photo-viewer-canvas"
        />
      )}

      {/* Text annotations layer (HTML divs — SVG <text> would stretch with viewBox preserveAspectRatio="none") */}
      <div
        style={{ ...imageRectStyle, pointerEvents: "none" }}
        className="overflow-hidden"
        data-testid="text-annotations-layer"
      >
        {showOverlay && (savedAnnotations || []).flatMap((row) => {
          if (editingAnnotationId && row.id === editingAnnotationId) return [];
          const isMine = !!currentUser?.id && row.userId === currentUser.id;
          const interactive = isMine && isAnnotating && (annotationTool === "text" || annotationTool === "eraser");
          const strokes = Array.isArray(row.strokes) ? (row.strokes as AnnotationStroke[]) : [];
          return strokes.filter(isTextStroke).map((t) => (
            <div
              key={`saved-${row.id}-${t.id}`}
              className="absolute select-none group"
              style={{
                left: `${t.x * 100}%`,
                top: `${t.y * 100}%`,
                color: t.color,
                fontSize: t.fontSize,
                fontWeight: 600,
                lineHeight: 1.1,
                whiteSpace: "nowrap",
                textShadow: "0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)",
                pointerEvents: interactive ? "auto" : "none",
                cursor: interactive ? (annotationTool === "eraser" ? "not-allowed" : "move") : "default",
              }}
              onPointerDown={interactive ? (e) => handleTextPointerDown(e, { kind: "saved", row, t }) : undefined}
              onPointerMove={interactive ? handleTextPointerMove : undefined}
              onPointerUp={interactive ? handleTextPointerUp : undefined}
              data-testid={isMine ? `text-annotation-saved-mine-${t.id}` : `text-annotation-saved-${t.id}`}
            >
              {t.content}
            </div>
          ));
        })}
        {annotations.filter(isTextShape).map((t) => {
          const interactive = isAnnotating && (annotationTool === "text" || annotationTool === "eraser");
          const beingEdited = textInput?.editingId === t.id;
          // While editing this node, hide the rendered text — the inline input is the live preview.
          if (beingEdited) return null;
          return (
            <div
              key={`mine-${t.id}`}
              className="absolute group select-none"
              style={{
                left: `${t.x * 100}%`,
                top: `${t.y * 100}%`,
                color: t.color,
                fontSize: t.fontSize,
                fontWeight: 600,
                lineHeight: 1.1,
                whiteSpace: "nowrap",
                textShadow: "0 0 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)",
                pointerEvents: interactive ? "auto" : "none",
                cursor: annotationTool === "eraser" ? "not-allowed" : "move",
                touchAction: interactive && annotationTool === "text" ? "none" : "auto",
              }}
              onPointerDown={interactive ? (e) => handleTextPointerDown(e, { kind: "mine", t }) : undefined}
              onPointerMove={interactive ? handleTextPointerMove : undefined}
              onPointerUp={interactive ? handleTextPointerUp : undefined}
              data-testid={`text-annotation-mine-${t.id}`}
            >
              {t.content}
              {isAnnotating && (
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAnnotations((prev) => prev.filter((s) => !(isTextShape(s) && s.id === t.id)));
                  }}
                  className="absolute -top-2 -right-2 hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full bg-black/80 text-white text-[10px] leading-none"
                  style={{ pointerEvents: "auto" }}
                  title="Delete text"
                  data-testid={`button-delete-text-${t.id}`}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        {textInput && (
          <div
            className="absolute"
            style={{
              left: `${textInput.x * 100}%`,
              top: `${textInput.y * 100}%`,
              pointerEvents: "auto",
            }}
            data-testid="text-annotation-input-wrapper"
          >
            <Input
              autoFocus
              value={textInput.content}
              onChange={(e) => setTextInput((s) => (s ? { ...s, content: e.target.value } : null))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTextInput();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setTextInput(null);
                }
              }}
              onBlur={commitTextInput}
              placeholder="Note…"
              className="px-2 py-0.5 bg-white/95 dark:bg-black/85 border shadow-md min-w-[140px]"
              style={{
                fontSize: annotationFontSize,
                lineHeight: 1.2,
                fontWeight: 600,
                color: annotationColor,
                height: "auto",
              }}
              data-testid="input-text-annotation"
            />
          </div>
        )}
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
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              if (window.confirm("Delete this photo? This cannot be undone.")) {
                deletePhoto.mutate();
              }
            }}
            disabled={deletePhoto.isPending}
            title="Delete photo"
            data-testid="button-delete-photo"
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          {savedAnnotations.length > 0 && !isAnnotating && (
            <>
              <div className="w-px h-6 bg-black/20 dark:bg-white/20 mx-0.5" />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowOverlay((v) => !v)}
                title={showOverlay ? "Hide annotations" : "Show annotations"}
                data-testid="button-toggle-annotations"
              >
                {showOverlay ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              </Button>
              {myExistingAnnotation && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={startEditingMine}
                  className="h-8 px-2 text-xs"
                  title="Edit your annotations"
                  data-testid="button-edit-my-annotations"
                >
                  <Pencil className="h-3.5 w-3.5 mr-1" />
                  Edit mine
                </Button>
              )}
            </>
          )}
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
              <div className="w-px h-6 bg-black/20 dark:bg-white/20 mx-0.5" />
              <Button
                size="sm"
                onClick={() => saveAnnotation.mutate()}
                disabled={(annotations.length === 0 && !editingAnnotationId) || saveAnnotation.isPending || deleteAnnotation.isPending}
                className="h-8 px-3 bg-[#F09000] hover:bg-[#D67F00] text-white font-medium"
                title="Save annotations"
                data-testid="button-save-annotations"
              >
                <Check className="h-4 w-4 mr-1" />
                {saveAnnotation.isPending || deleteAnnotation.isPending ? "Saving..." : "Save"}
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
                onClick={() => setAnnotationTool("text")}
                className={`rounded ${annotationTool === "text" ? "bg-primary text-primary-foreground" : ""}`}
                title="Text"
                data-testid="button-tool-text"
              >
                <Type className="h-4 w-4" />
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
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setAnnotationTool("eraser")}
                className={`rounded ${annotationTool === "eraser" ? "bg-primary text-primary-foreground" : ""}`}
                title="Eraser"
                data-testid="button-tool-eraser"
              >
                <Eraser className="h-4 w-4" />
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
              <span className="text-[10px] font-medium text-black dark:text-white whitespace-nowrap">
                {annotationTool === "text" ? "Font" : "Size"}
              </span>
              {annotationTool === "text" ? (
                <>
                  <input
                    type="range"
                    min={8}
                    max={96}
                    value={annotationFontSize}
                    onChange={(e) => setAnnotationFontSize(Number(e.target.value))}
                    className="w-20 h-1 accent-current"
                    style={{ color: annotationColor }}
                    data-testid="slider-font-size"
                  />
                  <span
                    className="shrink-0 leading-none font-bold tabular-nums text-black dark:text-white"
                    style={{ fontSize: Math.min(annotationFontSize, 22) }}
                    data-testid="text-font-size-preview"
                  >
                    {annotationFontSize}
                  </span>
                </>
              ) : (
                <>
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
                </>
              )}
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
                      <span
                        className="text-muted-foreground text-[10px] ml-1.5"
                        data-testid={`text-comment-timestamp-${comment.id}`}
                      >
                        {new Date(comment.createdAt).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                          hour12: true,
                        })}
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
