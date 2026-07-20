// "Download all projects & photos" export (Settings → Export Data).
//
// Fetches GET /api/export/manifest (owner/admin-only JSON — project list +
// per-file CloudFront URLs), then builds the ZIP entirely client-side with
// client-zip. Layout:
//
//   FieldView Export/
//     projects.csv                          (id, name, address, status, createdAt, fileCount)
//     failures.txt                          (only when some files failed)
//     {Project Name}/{mediaId}_{originalName}
//
// Saving: Chrome/Edge pipe the downloadZip Response body straight into a
// showSaveFilePicker writable (constant memory, multi-GB OK). Safari/Firefox
// fall back to an in-memory blob + <a download>.

import { downloadZip, type InputWithMeta, type InputWithSizeMeta } from "client-zip";

export interface ExportManifest {
  exportedAt: string;
  accountName: string;
  projects: Array<{
    id: number;
    name: string;
    address: string | null;
    status: string;
    createdAt: string;
    files: Array<{
      id: number;
      url: string;
      originalName: string;
      mimeType: string;
      createdAt: string;
    }>;
  }>;
}

export interface ExportFailure {
  originalName: string;
  projectName: string;
  url: string;
}

export interface ExportResult {
  totalFiles: number;
  downloadedFiles: number;
  failures: ExportFailure[];
  cancelled: boolean;
}

const CONCURRENCY = 4;
export const FALLBACK_LARGE_EXPORT_THRESHOLD = 2000;

export function supportsStreamingSave(): boolean {
  return typeof (window as any).showSaveFilePicker === "function";
}

export async function fetchExportManifest(): Promise<ExportManifest> {
  const res = await fetch("/api/export/manifest", { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to load export manifest (HTTP ${res.status})`);
  }
  return res.json();
}

// Strip characters invalid in zip paths, trim, collapse whitespace.
function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "untitled";
}

function csvCell(value: string | number | null): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildProjectsCsv(manifest: ExportManifest): string {
  const header = "id,name,address,status,createdAt,fileCount";
  const rows = manifest.projects.map((p) =>
    [p.id, p.name, p.address, p.status, p.createdAt, p.files.length]
      .map(csvCell)
      .join(","),
  );
  return [header, ...rows].join("\n") + "\n";
}

interface PlannedFile {
  zipPath: string;
  url: string;
  originalName: string;
  projectName: string;
  lastModified: Date;
}

function planFiles(manifest: ExportManifest): PlannedFile[] {
  const planned: PlannedFile[] = [];
  const usedFolders = new Map<string, number>();
  for (const project of manifest.projects) {
    let folder = sanitizeName(project.name);
    // Two projects can sanitize to the same folder name — suffix with id.
    const seen = usedFolders.get(folder.toLowerCase()) ?? 0;
    usedFolders.set(folder.toLowerCase(), seen + 1);
    if (seen > 0) folder = `${folder} (${project.id})`;
    for (const file of project.files) {
      planned.push({
        zipPath: `FieldView Export/${folder}/${file.id}_${sanitizeName(file.originalName)}`,
        url: file.url,
        originalName: file.originalName,
        projectName: project.name,
        lastModified: new Date(file.createdAt),
      });
    }
  }
  return planned;
}

async function fetchWithRetry(
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  const attempt = async () => {
    const res = await fetch(url, { signal, mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };
  try {
    return await attempt();
  } catch (err) {
    if (signal.aborted) throw err;
    return attempt(); // retry once
  }
}

// Async generator feeding client-zip: files stream in manifest order while
// up to CONCURRENCY fetches run ahead in the background.
async function* zipEntries(
  manifest: ExportManifest,
  planned: PlannedFile[],
  failures: ExportFailure[],
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void,
): AsyncGenerator<InputWithMeta | InputWithSizeMeta> {
  yield {
    name: "FieldView Export/projects.csv",
    lastModified: new Date(manifest.exportedAt),
    input: buildProjectsCsv(manifest),
  };

  const total = planned.length;
  let completed = 0;

  // Sliding window: keep up to CONCURRENCY fetch promises in flight, but
  // always yield results in order.
  const inFlight: Array<{ file: PlannedFile; promise: Promise<Response | null> }> = [];
  let next = 0;

  const startFetch = (file: PlannedFile) => ({
    file,
    promise: fetchWithRetry(file.url, signal).catch(() => null),
  });

  while (next < planned.length && inFlight.length < CONCURRENCY) {
    inFlight.push(startFetch(planned[next++]));
  }

  while (inFlight.length > 0) {
    if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
    const { file, promise } = inFlight.shift()!;
    const res = await promise;
    if (next < planned.length) inFlight.push(startFetch(planned[next++]));

    if (res && res.body) {
      const sizeHeader = res.headers.get("content-length");
      yield {
        name: file.zipPath,
        lastModified: file.lastModified,
        input: res,
        ...(sizeHeader ? { size: Number(sizeHeader) } : {}),
      };
    } else {
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      failures.push({
        originalName: file.originalName,
        projectName: file.projectName,
        url: file.url,
      });
    }
    completed++;
    onProgress(completed, total);
  }

  if (failures.length > 0) {
    const lines = failures.map(
      (f) => `${f.projectName} / ${f.originalName} — ${f.url}`,
    );
    yield {
      name: "FieldView Export/failures.txt",
      lastModified: new Date(),
      input:
        `${failures.length} file(s) could not be downloaded and were skipped:\n\n` +
        lines.join("\n") +
        "\n",
    };
  }
}

export async function runExport(options: {
  manifest: ExportManifest;
  signal: AbortSignal;
  onProgress: (completed: number, total: number) => void;
}): Promise<ExportResult> {
  const { manifest, signal, onProgress } = options;
  const planned = planFiles(manifest);
  const failures: ExportFailure[] = [];
  const zipName = `${sanitizeName(manifest.accountName)} - FieldView Export.zip`;

  const makeResponse = () =>
    downloadZip(zipEntries(manifest, planned, failures, signal, onProgress));

  try {
    if (supportsStreamingSave()) {
      let handle: FileSystemFileHandle;
      try {
        handle = await (window as any).showSaveFilePicker({
          suggestedName: zipName,
          types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
        });
      } catch (err: any) {
        if (err?.name === "AbortError") {
          // User dismissed the save dialog — treat as cancel, not error.
          return { totalFiles: planned.length, downloadedFiles: 0, failures: [], cancelled: true };
        }
        throw err;
      }
      const writable = await handle.createWritable();
      try {
        await makeResponse().body!.pipeTo(writable, { signal });
      } catch (err) {
        await writable.abort().catch(() => {});
        throw err;
      }
    } else {
      const blob = await makeResponse().blob();
      if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
  } catch (err: any) {
    if (signal.aborted || err?.name === "AbortError") {
      return {
        totalFiles: planned.length,
        downloadedFiles: 0,
        failures,
        cancelled: true,
      };
    }
    throw err;
  }

  return {
    totalFiles: planned.length,
    downloadedFiles: planned.length - failures.length,
    failures,
    cancelled: false,
  };
}
