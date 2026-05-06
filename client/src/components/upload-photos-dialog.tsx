import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Upload, X, CheckCircle2, AlertCircle, Loader2, ImageIcon } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { cn } from "@/lib/utils";

const MAX_BATCH = 20;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

type FileStatus = "pending" | "uploading" | "done" | "failed";

interface StagedFile {
  id: string;
  file: File;
  previewUrl: string;
  status: FileStatus;
  error?: string;
}

interface UploadPhotosDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Files to auto-stage on open (e.g. handoff from Take Photo). Cleared via onInitialFilesConsumed after staging. */
  initialFiles?: File[] | null;
  onInitialFilesConsumed?: () => void;
}

let nextStagedId = 0;
const makeId = () => `staged-${Date.now()}-${nextStagedId++}`;

const isAcceptableFile = (f: File) =>
  f.type.startsWith("image/") ||
  f.type.startsWith("video/") ||
  /\.(jpe?g|png|gif|webp|mp4|mov|avi|heic)$/i.test(f.name);

const isWithinSizeLimit = (f: File) => {
  const limit = f.type.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  return f.size > 0 && f.size <= limit;
};

export function UploadPhotosDialog({
  projectId,
  open,
  onOpenChange,
  initialFiles,
  onInitialFilesConsumed,
}: UploadPhotosDialogProps) {
  const { toast } = useToast();
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep a ref of staged for the unmount cleanup (closure can't see latest state otherwise)
  const stagedRef = useRef<StagedFile[]>([]);
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);

  // Final safety net: revoke any leftover object URLs on unmount
  useEffect(() => {
    return () => {
      stagedRef.current.forEach((s) => URL.revokeObjectURL(s.previewUrl));
    };
  }, []);

  // Auto-stage handoff files when opened with initialFiles
  useEffect(() => {
    if (open && initialFiles && initialFiles.length > 0) {
      addFiles(initialFiles);
      onInitialFilesConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFiles]);

  // Reset on close — revoke all previews
  useEffect(() => {
    if (!open) {
      setStaged((prev) => {
        prev.forEach((s) => URL.revokeObjectURL(s.previewUrl));
        return [];
      });
      setIsDragActive(false);
      dragCounterRef.current = 0;
    }
  }, [open]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      const accepted: File[] = [];
      let rejectedType = 0;
      let rejectedSize = 0;
      for (const f of arr) {
        if (!isAcceptableFile(f)) {
          rejectedType++;
          continue;
        }
        if (!isWithinSizeLimit(f)) {
          rejectedSize++;
          continue;
        }
        accepted.push(f);
      }
      if (rejectedType > 0) {
        toast({
          title: "Some files skipped",
          description: `${rejectedType} file${rejectedType !== 1 ? "s" : ""} are not images or videos.`,
          variant: "destructive",
        });
      }
      if (rejectedSize > 0) {
        toast({
          title: "Files too large",
          description: `${rejectedSize} file${rejectedSize !== 1 ? "s" : ""} exceeded the size limit (50MB images, 500MB video).`,
          variant: "destructive",
        });
      }
      setStaged((prev) => {
        const remainingSlots = MAX_BATCH - prev.length;
        let trimmed = accepted;
        if (accepted.length > remainingSlots) {
          toast({
            title: "Batch limit reached",
            description: `Max ${MAX_BATCH} files per upload. Took the first ${Math.max(0, remainingSlots)}.`,
            variant: "destructive",
          });
          trimmed = accepted.slice(0, Math.max(0, remainingSlots));
        }
        const next: StagedFile[] = trimmed.map((file) => ({
          id: makeId(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: "pending",
        }));
        return [...prev, ...next];
      });
    },
    [toast],
  );

  const removeFile = useCallback((id: string) => {
    setStaged((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  }, []);

  const updateStatus = (id: string, status: FileStatus, error?: string) => {
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, status, error } : s)));
  };

  const uploadMutation = useMutation({
    mutationFn: async (toUpload: StagedFile[]) => {
      toUpload.forEach((s) => updateStatus(s.id, "uploading"));

      const signRes = await fetch(`/api/uploads/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          files: toUpload.map((s) => ({
            originalName: s.file.name,
            mimeType: s.file.type || "application/octet-stream",
            fileSize: s.file.size,
          })),
        }),
      });
      if (!signRes.ok) {
        const errText = await signRes.text();
        toUpload.forEach((s) => updateStatus(s.id, "failed", "Sign failed"));
        throw new Error(errText || "Failed to sign uploads");
      }
      const signed: Array<{ key: string; uploadUrl: string; publicUrl: string }> = await signRes.json();

      const results = await Promise.all(
        toUpload.map(async (s, i) => {
          try {
            const put = await fetch(signed[i].uploadUrl, {
              method: "PUT",
              headers: { "Content-Type": s.file.type || "application/octet-stream" },
              body: s.file,
            });
            if (!put.ok) throw new Error(`Upload failed (${put.status})`);
            return { ok: true as const, staged: s, signed: signed[i] };
          } catch (err: any) {
            updateStatus(s.id, "failed", err?.message || "Upload failed");
            return { ok: false as const, staged: s };
          }
        }),
      );

      const succeeded = results.filter(
        (r): r is { ok: true; staged: StagedFile; signed: { key: string; uploadUrl: string; publicUrl: string } } =>
          r.ok,
      );
      if (succeeded.length === 0) {
        throw new Error("All uploads failed");
      }

      const finalizeRes = await fetch(`/api/projects/${projectId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          files: succeeded.map((r) => ({
            key: r.signed.key,
            publicUrl: r.signed.publicUrl,
            originalName: r.staged.file.name,
            mimeType: r.staged.file.type || "application/octet-stream",
          })),
        }),
      });
      if (!finalizeRes.ok) {
        const errText = await finalizeRes.text();
        succeeded.forEach((r) => updateStatus(r.staged.id, "failed", "Finalize failed"));
        throw new Error(errText || "Finalize failed");
      }
      succeeded.forEach((r) => updateStatus(r.staged.id, "done"));
      return { successCount: succeeded.length, failCount: results.length - succeeded.length };
    },
    onSuccess: ({ successCount, failCount }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      queryClient.invalidateQueries({ queryKey: ["/api/projects"], exact: true });
      const allDone = failCount === 0;
      toast({
        title: allDone ? "Uploaded" : "Partial upload",
        description: `${successCount} photo${successCount !== 1 ? "s" : ""} uploaded${failCount > 0 ? `, ${failCount} failed.` : "."}`,
      });
      if (allDone) {
        setStaged((prev) => {
          prev.forEach((s) => URL.revokeObjectURL(s.previewUrl));
          return [];
        });
        onOpenChange(false);
      } else {
        // Drop the succeeded rows (revoke their URLs); keep failed for retry
        setStaged((prev) => {
          prev.filter((s) => s.status === "done").forEach((s) => URL.revokeObjectURL(s.previewUrl));
          return prev.filter((s) => s.status !== "done");
        });
      }
    },
    onError: (error: Error) => {
      if (isUnauthorizedError(error)) {
        toast({ title: "Unauthorized", description: "Logging in again...", variant: "destructive" });
        setTimeout(() => {
          window.location.href = "/login";
        }, 500);
        return;
      }
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer.types.includes("Files")) return;
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDragActive(true);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragActive(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    dragCounterRef.current = 0;
    addFiles(e.dataTransfer.files);
  };

  const pendingForCommit = staged.filter((s) => s.status === "pending" || s.status === "failed");
  const isUploading = uploadMutation.isPending;
  const canCommit = pendingForCommit.length > 0 && !isUploading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="dialog-upload-photos">
        <DialogHeader>
          <DialogTitle>Add Photos</DialogTitle>
        </DialogHeader>

        <div
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "border-2 border-dashed rounded-xl p-10 min-h-[220px] flex flex-col items-center justify-center cursor-pointer transition-colors text-center select-none",
            isDragActive
              ? "border-primary bg-primary/10"
              : "border-neutral-300 dark:border-neutral-700 hover:bg-muted/30",
          )}
          data-testid="dropzone-upload"
        >
          <Upload className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="font-medium text-foreground">Click here or drag &amp; drop photos</p>
          <p className="text-xs text-muted-foreground mt-1.5">
            JPG, PNG, HEIC, WebP, MP4 — up to 50MB images / 500MB video, max {MAX_BATCH} at once
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*"
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files || []);
              e.target.value = "";
            }}
            data-testid="input-dialog-file-upload"
          />
        </div>

        {staged.length > 0 && (
          <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1" data-testid="list-staged-files">
            {staged.map((s) => (
              <FileRow key={s.id} staged={s} onRemove={() => removeFile(s.id)} disabled={isUploading} />
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-upload">
            Cancel
          </Button>
          <Button
            onClick={() => uploadMutation.mutate(pendingForCommit)}
            disabled={!canCommit}
            data-testid="button-upload-photos"
          >
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Upload {pendingForCommit.length} Photo{pendingForCommit.length !== 1 ? "s" : ""}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileRow({
  staged,
  onRemove,
  disabled,
}: {
  staged: StagedFile;
  onRemove: () => void;
  disabled: boolean;
}) {
  const isImage = staged.file.type.startsWith("image/");
  return (
    <div
      className="flex items-center gap-3 p-2 rounded-md border bg-card"
      data-testid={`row-staged-${staged.id}`}
    >
      <div className="h-10 w-10 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
        {isImage ? (
          <img src={staged.previewUrl} alt={staged.file.name} className="h-full w-full object-cover" />
        ) : (
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate" data-testid={`text-filename-${staged.id}`}>
          {staged.file.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {(staged.file.size / (1024 * 1024)).toFixed(2)} MB
          {staged.error && <span className="text-destructive ml-2">— {staged.error}</span>}
        </p>
      </div>
      <StatusIcon status={staged.status} />
      {!disabled && staged.status !== "done" && (
        <button
          type="button"
          onClick={onRemove}
          className="h-6 w-6 rounded-full hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${staged.file.name}`}
          data-testid={`button-remove-staged-${staged.id}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: FileStatus }) {
  if (status === "uploading")
    return <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" data-testid="status-uploading" />;
  if (status === "done")
    return <CheckCircle2 className="h-4 w-4 text-green-600" data-testid="status-done" />;
  if (status === "failed")
    return <AlertCircle className="h-4 w-4 text-destructive" data-testid="status-failed" />;
  return null;
}
