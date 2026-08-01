import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Upload, X, CheckCircle2, AlertCircle, Loader2, FileText } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { isUnauthorizedError } from "@/lib/auth-utils";
import { cn } from "@/lib/utils";
import { MAX_UPLOAD_BATCH } from "@shared/constants";

const MAX_BATCH = MAX_UPLOAD_BATCH;
const UPLOAD_CONCURRENCY = 6;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024; // 50 MB — mirrors server MAX_DOCUMENT_SIZE

// Mirrors the server's ALLOWED_DOCUMENT_TYPES allowlist. The server requires
// the extension AND mimeType to BOTH match, and browsers report MIME types
// unreliably (.heic is often "", .csv varies by OS) — so we derive the
// mimeType we send from the extension rather than trusting file.type.
const DOCUMENT_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
};
const ACCEPT_ATTR = Object.keys(DOCUMENT_MIME_BY_EXT).map((e) => `.${e}`).join(",");

function documentMimeFor(name: string): string | null {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return null;
  const ext = name.slice(idx + 1).toLowerCase();
  return DOCUMENT_MIME_BY_EXT[ext] ?? null;
}

type FileStatus = "pending" | "uploading" | "done" | "failed";

interface StagedFile {
  id: string;
  file: File;
  mimeType: string; // derived from extension — matches server allowlist
  status: FileStatus;
  /** 0–100 while uploading */
  progress?: number;
  error?: string;
}

/** PUT via XHR so we get real per-file upload progress events. */
function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed (network error)"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(file);
  });
}

let nextStagedId = 0;
const makeId = () => `staged-file-${Date.now()}-${nextStagedId++}`;

interface UploadFilesDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface SignedDocument {
  key: string;
  uploadUrl: string;
  publicUrl: string;
  // Baked into the PUT signature — MUST be sent verbatim as the
  // Content-Disposition header on the S3 PUT or S3 rejects the upload.
  contentDisposition: string;
}

export function UploadFilesDialog({ projectId, open, onOpenChange }: UploadFilesDialogProps) {
  const { toast } = useToast();
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setStaged([]);
      setIsDragActive(false);
      dragCounterRef.current = 0;
    }
  }, [open]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      const accepted: StagedFile[] = [];
      let rejectedType = 0;
      let rejectedSize = 0;
      for (const f of arr) {
        const mime = documentMimeFor(f.name);
        if (!mime) {
          rejectedType++;
          continue;
        }
        if (f.size <= 0 || f.size > MAX_DOCUMENT_BYTES) {
          rejectedSize++;
          continue;
        }
        accepted.push({ id: makeId(), file: f, mimeType: mime, status: "pending" });
      }
      if (rejectedType > 0) {
        toast({
          title: "Some files skipped",
          description: `${rejectedType} file${rejectedType !== 1 ? "s" : ""} are not a supported document type (PDF, Word, Excel, CSV, TXT, JPG, PNG, HEIC).`,
          variant: "destructive",
        });
      }
      if (rejectedSize > 0) {
        toast({
          title: "Files too large",
          description: `${rejectedSize} file${rejectedSize !== 1 ? "s" : ""} exceeded the 50MB limit or are empty.`,
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
        return [...prev, ...trimmed];
      });
    },
    [toast],
  );

  const removeFile = useCallback((id: string) => {
    setStaged((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const updateStatus = (id: string, status: FileStatus, error?: string) => {
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, status, error } : s)));
  };

  const updateProgress = (id: string, progress: number) => {
    setStaged((prev) => prev.map((s) => (s.id === id ? { ...s, progress } : s)));
  };

  const uploadMutation = useMutation({
    mutationFn: async (toUpload: StagedFile[]) => {
      toUpload.forEach((s) => {
        updateProgress(s.id, 0);
        updateStatus(s.id, "uploading");
      });

      const signRes = await fetch(`/api/uploads/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          files: toUpload.map((s) => ({
            originalName: s.file.name,
            mimeType: s.mimeType,
            fileSize: s.file.size,
            folder: "files",
          })),
        }),
      });
      if (!signRes.ok) {
        const errText = await signRes.text();
        toUpload.forEach((s) => updateStatus(s.id, "failed", "Sign failed"));
        throw new Error(errText || "Failed to sign uploads");
      }
      const signed: SignedDocument[] = await signRes.json();

      type UploadResult =
        | { ok: true; staged: StagedFile; signed: SignedDocument }
        | { ok: false; staged: StagedFile };
      const results: UploadResult[] = new Array(toUpload.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < toUpload.length) {
          const i = cursor++;
          const s = toUpload[i];
          try {
            await putWithProgress(
              signed[i].uploadUrl,
              s.file,
              {
                "Content-Type": s.mimeType,
                // Baked into the signature — must match exactly.
                "Content-Disposition": signed[i].contentDisposition,
              },
              (percent) => updateProgress(s.id, percent),
            );
            results[i] = { ok: true, staged: s, signed: signed[i] };
          } catch (err: any) {
            updateStatus(s.id, "failed", err?.message || "Upload failed");
            results[i] = { ok: false, staged: s };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, toUpload.length) }, worker),
      );

      const succeeded = results.filter(
        (r): r is { ok: true; staged: StagedFile; signed: SignedDocument } => r.ok,
      );
      const failedNames = results.filter((r) => !r.ok).map((r) => r.staged.file.name);
      if (succeeded.length === 0) {
        throw new Error("All uploads failed");
      }

      const registerRes = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          files: succeeded.map((r) => ({
            key: r.signed.key,
            publicUrl: r.signed.publicUrl,
            originalName: r.staged.file.name,
            mimeType: r.staged.mimeType,
            fileSize: r.staged.file.size,
          })),
        }),
      });
      if (!registerRes.ok) {
        const errText = await registerRes.text();
        succeeded.forEach((r) => updateStatus(r.staged.id, "failed", "Save failed"));
        throw new Error(errText || "Failed to save files");
      }
      succeeded.forEach((r) => updateStatus(r.staged.id, "done"));
      return { successCount: succeeded.length, failedNames };
    },
    onSuccess: ({ successCount, failedNames }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "files"] });
      const allDone = failedNames.length === 0;
      toast({
        title: allDone ? "Uploaded" : "Partial upload",
        description: allDone
          ? `${successCount} file${successCount !== 1 ? "s" : ""} uploaded.`
          : `${successCount} uploaded. Failed: ${failedNames.join(", ")}`,
        variant: allDone ? undefined : "destructive",
      });
      if (allDone) {
        setStaged([]);
        onOpenChange(false);
      } else {
        // Keep failed rows for retry; drop the succeeded ones.
        setStaged((prev) => prev.filter((s) => s.status !== "done"));
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
      <DialogContent className="sm:max-w-2xl" data-testid="dialog-upload-files">
        <DialogHeader>
          <DialogTitle>Add Files</DialogTitle>
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
          data-testid="dropzone-upload-files"
        >
          <Upload className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="font-medium text-foreground">Click here or drag &amp; drop files</p>
          <p className="text-xs text-muted-foreground mt-1.5">
            PDF, Word, Excel, CSV, TXT, JPG, PNG, HEIC — up to 50MB each, max {MAX_BATCH} at once
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files || []);
              e.target.value = "";
            }}
            data-testid="input-dialog-files-upload"
          />
        </div>

        {staged.length > 0 && (
          <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1" data-testid="list-staged-documents">
            {staged.map((s) => (
              <StagedRow key={s.id} staged={s} onRemove={() => removeFile(s.id)} disabled={isUploading} />
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-upload-files">
            Cancel
          </Button>
          <Button
            onClick={() => uploadMutation.mutate(pendingForCommit)}
            disabled={!canCommit}
            data-testid="button-upload-files"
          >
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Upload {pendingForCommit.length} File{pendingForCommit.length !== 1 ? "s" : ""}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StagedRow({
  staged,
  onRemove,
  disabled,
}: {
  staged: StagedFile;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3 p-2 rounded-md border bg-card"
      data-testid={`row-staged-doc-${staged.id}`}
    >
      <div className="h-10 w-10 shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
        <FileText className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate" data-testid={`text-doc-filename-${staged.id}`}>
          {staged.file.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {(staged.file.size / (1024 * 1024)).toFixed(2)} MB
          {staged.error && <span className="text-destructive ml-2">— {staged.error}</span>}
        </p>
        {staged.status === "uploading" && (
          <div
            className="mt-1 h-1 w-full rounded-full bg-muted overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={staged.progress ?? 0}
            data-testid={`progress-doc-${staged.id}`}
          >
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${staged.progress ?? 0}%` }}
            />
          </div>
        )}
      </div>
      <StatusIcon status={staged.status} />
      {!disabled && staged.status !== "done" && (
        <button
          type="button"
          onClick={onRemove}
          className="h-6 w-6 rounded-full hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${staged.file.name}`}
          data-testid={`button-remove-staged-doc-${staged.id}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: FileStatus }) {
  if (status === "uploading")
    return <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" data-testid="status-doc-uploading" />;
  if (status === "done")
    return <CheckCircle2 className="h-4 w-4 text-green-600" data-testid="status-doc-done" />;
  if (status === "failed")
    return <AlertCircle className="h-4 w-4 text-destructive" data-testid="status-doc-failed" />;
  return null;
}
