// Upload helper for per-checklist-item photo attachments (Stage 2).
//
// Reuses the existing 3-step pattern (sign → S3 PUT → finalize media row),
// then attaches each created media row to the target checklist item via the
// new join endpoint.
//
// Design notes:
//   - Files are signed with folder='checklists' (server whitelist extended in
//     Stage 2). The S3 key prefix differs from regular project photos so that
//     S3-side lifecycle / inventory tooling can tell them apart.
//   - We attach in a SECOND request — not in /api/projects/:id/media — to keep
//     the existing media route un-touched and to allow attaching previously-
//     uploaded media in the future without re-uploading.
//   - Per-file failures are surfaced as `failed` entries in the result; the
//     caller decides whether to toast partial success.

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export interface UploadChecklistPhotoResult {
  ok: boolean;
  file: File;
  mediaId?: number;
  error?: string;
}

interface SignedUpload {
  key: string;
  uploadUrl: string;
  publicUrl: string;
}

/**
 * Upload an array of files as photos attached to a single checklist item.
 * Returns a per-file result array so the caller can show "3 of 4 uploaded"
 * style messaging.
 */
export async function uploadChecklistItemPhotos(
  files: File[],
  projectId: string | number,
  itemId: number,
): Promise<UploadChecklistPhotoResult[]> {
  if (files.length === 0) return [];

  // Pre-flight: bail any oversize files locally so we don't hit a 400 from sign.
  const results: UploadChecklistPhotoResult[] = files.map((f) => {
    const limit = f.type.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (!(f.size > 0 && f.size <= limit)) {
      return { ok: false, file: f, error: `File too large or empty: ${f.name}` };
    }
    return { ok: true, file: f };
  });
  const validIdx = results.map((r, i) => (r.ok ? i : -1)).filter((i) => i >= 0);
  if (validIdx.length === 0) return results;

  const validFiles = validIdx.map((i) => files[i]);

  // Step 1 — sign all valid files in one round trip.
  const signRes = await fetch(`/api/uploads/sign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      files: validFiles.map((f) => ({
        originalName: f.name,
        mimeType: f.type || "application/octet-stream",
        fileSize: f.size,
        folder: "checklists",
      })),
    }),
  });
  if (!signRes.ok) {
    const errText = await signRes.text();
    validIdx.forEach((i) => { results[i] = { ok: false, file: files[i], error: errText || "Sign failed" }; });
    return results;
  }
  const signed: SignedUpload[] = await signRes.json();

  // Step 2 — PUT each file to S3 in parallel.
  type PutResult = { ok: true; signed: SignedUpload; file: File; resultIdx: number }
                 | { ok: false; resultIdx: number; error: string };
  const puts: PutResult[] = await Promise.all(
    validFiles.map(async (file, n): Promise<PutResult> => {
      const resultIdx = validIdx[n];
      try {
        const put = await fetch(signed[n].uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) throw new Error(`S3 upload failed (${put.status})`);
        return { ok: true, signed: signed[n], file, resultIdx };
      } catch (err: any) {
        return { ok: false, resultIdx, error: err?.message || "Upload failed" };
      }
    }),
  );
  for (const p of puts) if (!p.ok) results[p.resultIdx] = { ok: false, file: files[p.resultIdx], error: p.error };

  const succeededPuts = puts.filter((p): p is Extract<PutResult, { ok: true }> => p.ok);
  if (succeededPuts.length === 0) return results;

  // Step 3 — create media rows. Returns an array preserving input order.
  const finalizeRes = await fetch(`/api/projects/${projectId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      files: succeededPuts.map((p) => ({
        key: p.signed.key,
        publicUrl: p.signed.publicUrl,
        originalName: p.file.name,
        mimeType: p.file.type || "application/octet-stream",
      })),
    }),
  });
  if (!finalizeRes.ok) {
    const errText = await finalizeRes.text();
    succeededPuts.forEach((p) => { results[p.resultIdx] = { ok: false, file: files[p.resultIdx], error: errText || "Finalize failed" }; });
    return results;
  }
  const created: { id: number }[] = await finalizeRes.json();
  if (!Array.isArray(created) || created.length !== succeededPuts.length) {
    succeededPuts.forEach((p) => { results[p.resultIdx] = { ok: false, file: files[p.resultIdx], error: "Finalize returned unexpected shape" }; });
    return results;
  }

  // Step 4 — attach all created media rows to the checklist item in a single call.
  // Bulk attach so the photos_required gate flips at most once even for N files.
  const mediaIds = created.map((m) => m.id);
  const attachRes = await fetch(`/api/checklist-items/${itemId}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ mediaIds }),
  });
  if (!attachRes.ok) {
    const errText = await attachRes.text();
    succeededPuts.forEach((p, i) => {
      results[p.resultIdx] = { ok: false, file: files[p.resultIdx], error: errText || "Attach failed", mediaId: mediaIds[i] };
    });
    return results;
  }
  succeededPuts.forEach((p, i) => {
    results[p.resultIdx] = { ok: true, file: files[p.resultIdx], mediaId: mediaIds[i] };
  });
  return results;
}
