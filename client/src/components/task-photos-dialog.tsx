// Task photos dialog — the two attach paths for the photo-requirement feature:
//   1. Contextual capture: files picked/taken FROM this dialog upload via
//      uploadTaskPhotos(), which threads the taskId through
//      sign → S3 PUT → finalize → attach (no extra user action).
//   2. Deliberate attach: a picker over the project's EXISTING photos that
//      calls POST /api/tasks/:id/photos with the selected mediaIds.
// Both paths land on the same endpoint, so mobile can mirror either.
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Camera, ImagePlus, Loader2, X, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uploadTaskPhotos } from "@/lib/upload-task-photos";
import type { Media, Task, TaskPhoto } from "@shared/schema";

type TaskPhotoWithMedia = TaskPhoto & { media: Media };

interface TaskPhotosDialogProps {
  task: (Task & { attachedPhotoCount?: number }) | null;
  onOpenChange: (open: boolean) => void;
}

export default function TaskPhotosDialog({ task, onOpenChange }: TaskPhotosDialogProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const open = task !== null;
  const taskId = task?.id;

  const photosQuery = useQuery<TaskPhotoWithMedia[]>({
    queryKey: [`/api/tasks/${taskId}/photos`],
    enabled: open,
  });

  // Project media for the "attach existing" picker.
  const projectQuery = useQuery<{ media: Media[] }>({
    queryKey: [`/api/projects/${task?.projectId}`],
    enabled: open && pickerOpen,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/tasks/${taskId}/photos`] });
    queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    queryClient.invalidateQueries({ queryKey: [`/api/projects/${task?.projectId}`] });
  };

  const attachExisting = useMutation({
    mutationFn: async (mediaIds: number[]) => {
      await apiRequest("POST", `/api/tasks/${taskId}/photos`, { mediaIds });
    },
    onSuccess: () => {
      invalidate();
      setPickerOpen(false);
      setSelectedIds(new Set());
      toast({ title: "Photos attached" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to attach photos", description: e.message, variant: "destructive" });
    },
  });

  const detach = useMutation({
    mutationFn: async (taskPhotoId: number) => {
      await apiRequest("DELETE", `/api/task-photos/${taskPhotoId}`);
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => {
      toast({ title: "Failed to remove photo", description: e.message, variant: "destructive" });
    },
  });

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !task || !taskId) return;
    setUploading(true);
    try {
      const results = await uploadTaskPhotos(Array.from(files), task.projectId, taskId);
      const okCount = results.filter((r) => r.ok).length;
      const failCount = results.length - okCount;
      if (okCount > 0) invalidate();
      if (failCount > 0) {
        toast({
          title: `${okCount} of ${results.length} photos attached`,
          description: results.find((r) => !r.ok)?.error,
          variant: "destructive",
        });
      } else {
        toast({ title: okCount === 1 ? "Photo attached" : `${okCount} photos attached` });
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (!task) return null;

  const attached = photosQuery.data?.length ?? 0;
  const required = (task as any).requiredPhotoCount ?? 0;
  const attachedMediaIds = new Set((photosQuery.data ?? []).map((p) => p.mediaId));
  const pickerMedia = (projectQuery.data?.media ?? []).filter(
    (m) => !attachedMediaIds.has(m.id) && m.mimeType.startsWith("image/"),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setPickerOpen(false); setSelectedIds(new Set()); onOpenChange(false); } }}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-task-photos">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Task photos
            {required > 0 && (
              <Badge variant={attached >= required ? "default" : "secondary"} data-testid="badge-task-photo-progress">
                {attached} of {required} required
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {required > 0
              ? `This task needs ${required} photo${required === 1 ? "" : "s"} attached before it can be marked done.`
              : "Attach photos to document this task."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
            data-testid="input-task-photo-files"
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            data-testid="button-upload-task-photos"
          >
            {uploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Camera className="h-4 w-4 mr-2" />}
            {uploading ? "Uploading…" : "Add photos"}
          </Button>
          <Button
            variant="outline"
            onClick={() => setPickerOpen((v) => !v)}
            data-testid="button-attach-existing-photos"
          >
            <ImagePlus className="h-4 w-4 mr-2" />
            Attach existing
          </Button>
        </div>

        {pickerOpen && (
          <div className="border rounded-md p-2 space-y-2" data-testid="picker-existing-photos">
            {projectQuery.isLoading ? (
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="aspect-square rounded" />)}
              </div>
            ) : pickerMedia.length === 0 ? (
              <p className="text-sm text-muted-foreground p-2">No other project photos to attach.</p>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto">
                  {pickerMedia.map((m) => {
                    const selected = selectedIds.has(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        className={`relative aspect-square rounded overflow-hidden border-2 ${selected ? "border-primary" : "border-transparent"}`}
                        onClick={() => {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
                            return next;
                          });
                        }}
                        data-testid={`picker-photo-${m.id}`}
                      >
                        <img src={m.url} alt={m.originalName} className="h-full w-full object-cover" />
                        {selected && (
                          <span className="absolute top-1 right-1 bg-primary text-primary-foreground rounded-full p-0.5">
                            <Check className="h-3 w-3" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <Button
                  size="sm"
                  disabled={selectedIds.size === 0 || attachExisting.isPending}
                  onClick={() => attachExisting.mutate(Array.from(selectedIds))}
                  data-testid="button-confirm-attach-existing"
                >
                  {attachExisting.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Attach {selectedIds.size || ""} selected
                </Button>
              </>
            )}
          </div>
        )}

        <div>
          {photosQuery.isLoading ? (
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="aspect-square rounded" />)}
            </div>
          ) : attached === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-task-photos">No photos attached yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {(photosQuery.data ?? []).map((p) => (
                <div key={p.id} className="relative aspect-square rounded overflow-hidden group" data-testid={`task-photo-${p.id}`}>
                  <img src={p.media.url} alt={p.media.originalName} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => detach.mutate(p.id)}
                    aria-label="Remove photo"
                    data-testid={`button-detach-photo-${p.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
