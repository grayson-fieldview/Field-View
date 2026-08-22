/**
 * Development-only demo-data seed.
 *
 * Required values belong in the Git-ignored .env.local; never commit them.
 *
 * Preview only (default):
 *   npx tsx script/seed-demo-account.ts
 *
 * Apply to the local development server:
 *   DRY_RUN=false SEED_DEMO_CONFIRM=yes npx tsx script/seed-demo-account.ts
 *
 * Apply to a non-development target only with both explicit acknowledgements:
 *   DRY_RUN=false SEED_DEMO_CONFIRM=yes SEED_DEMO_ALLOW_PROD=yes \
 *     npx tsx script/seed-demo-account.ts --i-understand-this-is-production
 *
 * Independently backdate the six seeded projects after a successful seed:
 *   DRY_RUN=false SEED_DEMO_CONFIRM=yes BACKDATE_DEMO_CONFIRM=yes \
 *     npx tsx script/seed-demo-account.ts --backdate
 * The command prompts once for the development DATABASE_URL without echoing or
 * persisting it, then verifies it matches this runtime's attached database.
 */

import pg from "pg";
import {
  ApiProject,
  ApiSession,
  DemoManifest,
  ManifestPhoto,
  ManifestProject,
  ProjectDetail,
  SeedConfig,
  assertAttachedDevelopmentDatabase,
  assertManifestTarget,
  fetchWith429Retry,
  invokedDirectly,
  loadSeedConfig,
  loginDemoUsers,
  readManifest,
  sleep,
  writeManifest,
} from "./demo-seed-common";

const { Pool } = pg;

const PROJECT_DEFINITIONS: Omit<ManifestProject, "photos" | "projectId" | "latitude" | "longitude" | "coverPhotoId">[] = [
  {
    slug: "caldwell-interior-repaint",
    name: "Caldwell Residence — Interior Repaint",
    description: "Interior prep, patching, priming, and finish coats throughout the residence.",
    status: "active",
    address: "101 S Clematis St, West Palm Beach, FL 33401",
    color: "#F09004",
    tags: ["painting", "interior", "residential"],
    pexelsQuery: "interior house painting construction",
    targetPhotoCount: 18,
  },
  {
    slug: "mariner-kitchen-remodel",
    name: "Mariner House — Kitchen Remodel",
    description: "Kitchen demolition, rough-in, cabinetry, counters, and finish installation.",
    status: "active",
    address: "6000 Glades Rd, Boca Raton, FL 33431",
    color: "#2563EB",
    tags: ["remodeling", "kitchen", "residential"],
    pexelsQuery: "kitchen remodeling contractor construction",
    targetPhotoCount: 20,
  },
  {
    slug: "avery-roof-replacement",
    name: "Avery Residence — Roof Replacement",
    description: "Tear-off, deck inspection, dry-in, flashing, and roofing-system replacement.",
    status: "completed",
    address: "100 N Ocean Blvd, Delray Beach, FL 33483",
    color: "#7C3AED",
    tags: ["roofing", "exterior", "completed"],
    pexelsQuery: "roofing contractor roof construction",
    targetPhotoCount: 17,
  },
  {
    slug: "bennett-electrical-retrofit",
    name: "Bennett Offices — Electrical Retrofit",
    description: "Panel, branch-circuit, device, and lighting upgrades across occupied offices.",
    status: "active",
    address: "414 Lake Ave, Lake Worth Beach, FL 33460",
    color: "#EAB308",
    tags: ["electrical", "commercial", "retrofit"],
    pexelsQuery: "electrician electrical wiring construction",
    targetPhotoCount: 22,
  },
  {
    slug: "seabrook-landscape-renovation",
    name: "Seabrook Residence — Landscape Renovation",
    description: "Drainage, grading, hardscape, irrigation, and planting improvements.",
    status: "active",
    address: "805 N US Highway 1, Jupiter, FL 33477",
    color: "#16A34A",
    tags: ["landscaping", "drainage", "hardscape"],
    pexelsQuery: "landscape contractor outdoor construction",
    targetPhotoCount: 19,
  },
  {
    slug: "northwood-plumbing-upgrade",
    name: "Northwood Residence — Plumbing Upgrade",
    description: "Supply, drain, fixture, and water-heater upgrades during a phased renovation.",
    status: "on_hold",
    address: "1100 Royal Palm Beach Blvd, Royal Palm Beach, FL 33411",
    color: "#0891B2",
    tags: ["plumbing", "renovation", "on-hold"],
    pexelsQuery: "plumber plumbing pipes construction",
    targetPhotoCount: 24,
  },
];

const HUMAN_NOTES = [
  "Existing conditions documented before work started.",
  "Prep complete in the main work area.",
  "Rough-in checked before closing the wall.",
  "Material delivery verified on site.",
  "Progress at the end of today’s shift.",
  "Final detail ready for supervisor review.",
];

type PexelsPhoto = {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  src: { large?: string };
};

type PexelsResponse = {
  photos?: PexelsPhoto[];
};

type SignedUpload = {
  key: string;
  uploadUrl: string;
  publicUrl: string;
};

function newManifest(baseUrl: string): DemoManifest {
  const generatedAt = new Date();
  const timelineEndAt = new Date(generatedAt.getTime() - 3 * 24 * 60 * 60 * 1_000);
  return {
    version: 1,
    baseUrl,
    generatedAt: generatedAt.toISOString(),
    timelineEndAt: timelineEndAt.toISOString(),
    projects: PROJECT_DEFINITIONS.map((project) => ({ ...project, photos: [] })),
  };
}

function validateManifestShape(manifest: DemoManifest): void {
  const expected = PROJECT_DEFINITIONS.map((project) => project.slug);
  const actual = manifest.projects.map((project) => project.slug);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      "The existing manifest does not contain the expected six project definitions. " +
        "Move it aside before starting a different seed.",
    );
  }
}

function takenAtForPhoto(
  manifest: DemoManifest,
  projectIndex: number,
  photoIndex: number,
  photoCount: number,
): string {
  const end = new Date(manifest.timelineEndAt).getTime() - projectIndex * 18 * 60 * 60 * 1_000;
  const start = end - (39 - projectIndex * 2) * 24 * 60 * 60 * 1_000;
  const sessionSize = 4;
  const sessionCount = Math.ceil(photoCount / sessionSize);
  const sessionIndex = Math.floor(photoIndex / sessionSize);
  const sessionFraction = sessionCount <= 1 ? 0 : sessionIndex / (sessionCount - 1);
  const sessionStart = start + (end - start) * sessionFraction;
  const withinSession = photoIndex % sessionSize;
  const hourOffset = (8 + withinSession * 2) * 60 * 60 * 1_000;
  const minuteOffset = ((projectIndex * 11 + photoIndex * 17) % 45) * 60 * 1_000;
  return new Date(sessionStart + hourOffset + minuteOffset).toISOString();
}

async function pexelsPage(
  config: SeedConfig,
  project: ManifestProject,
  page: number,
): Promise<PexelsPhoto[]> {
  const perPage = Math.min(80, project.targetPhotoCount * 2);
  const url = new URL("https://api.pexels.com/v1/search");
  url.searchParams.set("query", project.pexelsQuery);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));

  const response = await fetchWith429Retry(
    url.toString(),
    { headers: { Authorization: config.pexelsApiKey } },
    `Pexels query for ${project.name}`,
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Pexels query for ${project.name} failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as PexelsResponse;
  return Array.isArray(data.photos) ? data.photos : [];
}

async function sourcePhotos(config: SeedConfig, manifest: DemoManifest): Promise<void> {
  const usedIds = new Set(
    manifest.projects.flatMap((project) => project.photos.map((photo) => photo.pexelsId)),
  );

  for (let projectIndex = 0; projectIndex < manifest.projects.length; projectIndex += 1) {
    const project = manifest.projects[projectIndex];
    if (project.photos.length > project.targetPhotoCount) {
      throw new Error(`${project.name} has more manifest photos than its configured target.`);
    }

    let page = 1;
    while (project.photos.length < project.targetPhotoCount && page <= 5) {
      const candidates = await pexelsPage(config, project, page);
      if (candidates.length === 0) break;

      for (const candidate of candidates) {
        if (project.photos.length >= project.targetPhotoCount) break;
        if (
          usedIds.has(candidate.id) ||
          !candidate.src?.large ||
          !Number.isFinite(candidate.width) ||
          !Number.isFinite(candidate.height)
        ) {
          continue;
        }

        const photoIndex = project.photos.length;
        const photo: ManifestPhoto = {
          pexelsId: candidate.id,
          pexelsPageUrl: candidate.url,
          sourceUrl: candidate.src.large,
          photographer: candidate.photographer,
          width: candidate.width,
          height: candidate.height,
          originalName: `pexels-${candidate.id}.jpg`,
          takenAt: takenAtForPhoto(
            manifest,
            projectIndex,
            photoIndex,
            project.targetPhotoCount,
          ),
          uploaderSlot: (projectIndex + photoIndex) % 4,
          humanCaption:
            photoIndex % 4 === 0
              ? HUMAN_NOTES[(projectIndex + Math.floor(photoIndex / 4)) % HUMAN_NOTES.length]
              : null,
        };
        project.photos.push(photo);
        usedIds.add(candidate.id);
      }
      page += 1;
    }

    if (project.photos.length !== project.targetPhotoCount) {
      throw new Error(
        `Pexels returned only ${project.photos.length} unique usable photos for ${project.name}; ` +
          `${project.targetPhotoCount} are required.`,
      );
    }
    if (!project.photos.some((photo) => photo.width > photo.height)) {
      throw new Error(`${project.name} has no landscape photo suitable for a cover.`);
    }
    await writeManifest(manifest);
    console.log(`Selected ${project.photos.length} photos for ${project.name}.`);
  }
}

async function ensureProjects(owner: ApiSession, manifest: DemoManifest): Promise<void> {
  const accountProjects = await owner.request<ApiProject[]>("/api/projects");
  for (const project of manifest.projects) {
    let current: ApiProject;
    if (project.projectId) {
      const detail = await owner.request<ProjectDetail>(`/api/projects/${project.projectId}`);
      current = detail.project;
      if (current.name !== project.name) {
        throw new Error(
          `Manifest project ${project.projectId} is named '${current.name}', expected '${project.name}'.`,
        );
      }
    } else {
      const matches = accountProjects.filter((candidate) => candidate.name === project.name);
      if (matches.length > 1) {
        throw new Error(
          `Found ${matches.length} existing projects named '${project.name}'; ` +
            "cannot safely reconcile an uncertain create response.",
        );
      }
      if (matches.length === 1) {
        current = matches[0];
        console.log(`Reconciled existing project ${current.id}: ${project.name}`);
      } else {
        current = await owner.request<ApiProject>("/api/projects", {
          method: "POST",
          body: {
            name: project.name,
            description: project.description,
            status: project.status,
            address: project.address,
            color: project.color,
            tags: project.tags,
          },
        });
        accountProjects.push(current);
        console.log(`Created project ${current.id}: ${project.name}`);
      }
      project.projectId = current.id;
      await writeManifest(manifest);
    }

    if (current.latitude == null || current.longitude == null) {
      throw new Error(
        `Server-side geocoding did not resolve ${project.name}. ` +
          "Fix GOOGLE_MAPS_API_KEY/geocoding before uploading photos.",
      );
    }
    project.latitude = current.latitude;
    project.longitude = current.longitude;
    await writeManifest(manifest);
  }
}

async function downloadJpeg(photo: ManifestPhoto, projectName: string): Promise<Buffer> {
  const response = await fetchWith429Retry(
    photo.sourceUrl,
    { headers: { Accept: "image/jpeg" } },
    `Pexels download ${photo.pexelsId} for ${projectName}`,
  );
  if (!response.ok) {
    throw new Error(
      `Pexels download ${photo.pexelsId} failed (${response.status}) for ${projectName}.`,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("image/jpeg")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `Pexels photo ${photo.pexelsId} returned '${contentType || "unknown"}', not image/jpeg.`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error(`Pexels photo ${photo.pexelsId} downloaded empty.`);
  return buffer;
}

function deterministicThumbnailKey(originalKey: string): string {
  const basename = originalKey.split("/").pop()!.replace(/\.[^.]+$/, "");
  return `photos/thumbs/${basename}.jpg`;
}

async function publicObjectExists(photo: ManifestPhoto, projectName: string): Promise<boolean> {
  if (!photo.publicUrl) return false;
  const response = await fetchWith429Retry(
    photo.publicUrl,
    {
      method: "HEAD",
      headers: { "Cache-Control": "no-cache" },
    },
    `S3 object check for ${photo.originalName}`,
  );
  await response.body?.cancel().catch(() => undefined);
  if (response.ok) return true;
  if (response.status === 403 || response.status === 404) return false;
  throw new Error(
    `Unable to verify S3 object for ${photo.originalName} in ${projectName} ` +
      `(status ${response.status}).`,
  );
}

async function resetTimedOutMedia(
  owner: ApiSession,
  manifest: DemoManifest,
): Promise<void> {
  const failedCount = manifest.projects.reduce(
    (total, project) =>
      total + project.photos.filter((photo) => photo.processingFailedAt).length,
    0,
  );
  if (failedCount === 0) return;

  const { deleteFromS3 } = await import("../server/s3");
  console.log(`Retrying ${failedCount} media rows that previously timed out.`);
  for (const project of manifest.projects) {
    const failedPhotos = project.photos.filter((photo) => photo.processingFailedAt);
    if (failedPhotos.length === 0) continue;
    if (!project.projectId) throw new Error(`Project id missing for ${project.name}.`);
    const detail = await owner.request<ProjectDetail>(`/api/projects/${project.projectId}`);
    const liveMediaIds = new Set(detail.media.map((row) => row.id));

    for (const photo of failedPhotos) {
      if (photo.s3Key) {
        // Clean objects before deleting the retry source row. Both deletes are
        // idempotent, so a crash can safely resume from the same manifest state.
        await deleteFromS3(photo.s3Key);
        await deleteFromS3(deterministicThumbnailKey(photo.s3Key));
      }
      if (photo.mediaId && liveMediaIds.has(photo.mediaId)) {
        try {
          await owner.request<{ success: boolean }>(`/api/media/${photo.mediaId}`, {
            method: "DELETE",
          });
        } catch (error) {
          // A concurrent/prior retry may have committed the DELETE after the
          // detail read. Missing is the desired state; other failures are not.
          if (!(error instanceof Error) || !error.message.includes("(404)")) throw error;
        }
      }
      if (photo.s3Key) {
        // Close a late thumbnail-write race after the media row is gone.
        await deleteFromS3(photo.s3Key);
        await deleteFromS3(deterministicThumbnailKey(photo.s3Key));
      }
      delete photo.s3Key;
      delete photo.publicUrl;
      delete photo.s3UploadedAt;
      delete photo.mediaId;
      delete photo.thumbUrl;
      delete photo.thumbnailResolvedAt;
      delete photo.captionResolvedAt;
      delete photo.processingFailedAt;
      await writeManifest(manifest);
      console.log(`Reset timed-out media for ${project.name}: ${photo.originalName}`);
    }
  }
}

async function uploadPhotos(
  sessions: ApiSession[],
  manifest: DemoManifest,
): Promise<void> {
  for (const project of manifest.projects) {
    if (!project.projectId) throw new Error(`Project id missing for ${project.name}.`);
    const current = await sessions[0].request<ProjectDetail>(
      `/api/projects/${project.projectId}`,
    );

    for (let photoIndex = 0; photoIndex < project.photos.length; photoIndex += 1) {
      const photo = project.photos[photoIndex];
      const session = sessions[photo.uploaderSlot];
      if (!session) throw new Error(`Invalid uploader slot ${photo.uploaderSlot}.`);

      if (photo.s3Key) {
        const matches = current.media.filter((row) => row.filename === photo.s3Key);
        if (matches.length > 1) {
          throw new Error(
            `Found ${matches.length} media rows for S3 key ${photo.s3Key}; ` +
              "cannot safely reconcile an uncertain registration response.",
          );
        }
        if (photo.mediaId && matches.length === 0) {
          throw new Error(
            `Manifest media ${photo.mediaId} is missing from project ${project.projectId}.`,
          );
        }
        if (!photo.mediaId && matches.length === 1) {
          photo.mediaId = matches[0].id;
          await writeManifest(manifest);
          console.log(`Reconciled media ${photo.mediaId}: ${photo.originalName}`);
        }
      }
      if (photo.mediaId) continue;

      let objectReady =
        !!photo.s3Key &&
        !!photo.publicUrl &&
        (await publicObjectExists(photo, project.name));
      if (objectReady && !photo.s3UploadedAt) {
        photo.s3UploadedAt = new Date().toISOString();
        await writeManifest(manifest);
      }

      if (!objectReady) {
        const bytes = await downloadJpeg(photo, project.name);
        const signed = await session.request<SignedUpload[]>("/api/uploads/sign", {
          method: "POST",
          body: {
            files: [
              {
                originalName: photo.originalName,
                mimeType: "image/jpeg",
                fileSize: bytes.length,
              },
            ],
          },
        });
        if (!Array.isArray(signed) || signed.length !== 1) {
          throw new Error(`Upload signing returned an unexpected shape for ${photo.originalName}.`);
        }
        // Checkpoint the generated key before PUT. If the process stops after
        // S3 accepts bytes, a rerun can HEAD this public URL and continue
        // without generating an orphan or duplicate object.
        photo.s3Key = signed[0].key;
        photo.publicUrl = signed[0].publicUrl;
        delete photo.s3UploadedAt;
        await writeManifest(manifest);

        const putResponse = await fetchWith429Retry(
          signed[0].uploadUrl,
          {
            method: "PUT",
            headers: {
              "Content-Type": "image/jpeg",
              "Content-Length": String(bytes.length),
            },
            body: bytes,
          },
          `S3 upload for ${photo.originalName}`,
        );
        if (!putResponse.ok) {
          const body = (await putResponse.text()).slice(0, 500);
          throw new Error(
            `S3 upload failed for ${photo.originalName} (${putResponse.status}): ${body}`,
          );
        }
        await putResponse.body?.cancel().catch(() => undefined);
        photo.s3UploadedAt = new Date().toISOString();
        await writeManifest(manifest);
        objectReady = true;
      }

      if (!objectReady || !photo.s3Key || !photo.publicUrl) {
        throw new Error(`S3 object was not ready for ${photo.originalName}.`);
      }
      const created = await session.request<Array<{ id: number }>>(
        `/api/projects/${project.projectId}/media`,
        {
          method: "POST",
          body: {
            files: [
              {
                key: photo.s3Key,
                publicUrl: photo.publicUrl,
                originalName: photo.originalName,
                mimeType: "image/jpeg",
                takenAt: photo.takenAt,
              },
            ],
            caption: photo.humanCaption,
            tags: project.tags,
          },
        },
      );
      if (!Array.isArray(created) || !created[0]?.id) {
        throw new Error(`Media registration returned an unexpected shape for ${photo.originalName}.`);
      }
      photo.mediaId = created[0].id;
      delete photo.processingFailedAt;
      await writeManifest(manifest);
      console.log(
        `Uploaded ${project.name} ${photoIndex + 1}/${project.photos.length} ` +
          `as ${session.credential.label}.`,
      );
      await sleep(650);
    }
  }
}

function processingTimeoutMs(): number {
  const raw = process.env.DEMO_PROCESSING_TIMEOUT_MINUTES?.trim() || "20";
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) {
    throw new Error("DEMO_PROCESSING_TIMEOUT_MINUTES must be greater than 0 and at most 120.");
  }
  return minutes * 60 * 1_000;
}

async function waitForProcessing(owner: ApiSession, manifest: DemoManifest): Promise<void> {
  const deadline = Date.now() + processingTimeoutMs();
  let lastUnresolved: string[] = [];

  while (Date.now() < deadline) {
    const unresolved: string[] = [];
    for (const project of manifest.projects) {
      if (!project.projectId) throw new Error(`Project id missing for ${project.name}.`);
      const detail = await owner.request<ProjectDetail>(`/api/projects/${project.projectId}`);
      const byId = new Map(detail.media.map((media) => [media.id, media]));

      for (const photo of project.photos) {
        if (!photo.mediaId) {
          unresolved.push(`${project.slug}/pexels-${photo.pexelsId}: no media id`);
          continue;
        }
        const row = byId.get(photo.mediaId);
        if (!row) {
          unresolved.push(`${project.slug}/media-${photo.mediaId}: row not found`);
          continue;
        }
        if (row.thumbUrl) {
          photo.thumbUrl = row.thumbUrl;
          photo.thumbnailResolvedAt ||= new Date().toISOString();
        } else {
          unresolved.push(`${project.slug}/media-${photo.mediaId}: thumbnail`);
        }
        if (row.aiCaption != null) {
          photo.captionResolvedAt ||= new Date().toISOString();
        } else {
          unresolved.push(`${project.slug}/media-${photo.mediaId}: AI caption`);
        }
        if (row.thumbUrl && row.aiCaption != null) {
          delete photo.processingFailedAt;
        }
      }
    }

    await writeManifest(manifest);
    if (unresolved.length === 0) {
      console.log("All thumbnails and AI captions resolved.");
      return;
    }
    lastUnresolved = unresolved;
    console.log(`Waiting for ${unresolved.length} unresolved media outputs...`);
    await sleep(10_000);
  }

  const failedAt = new Date().toISOString();
  for (const project of manifest.projects) {
    for (const photo of project.photos) {
      if (!photo.thumbnailResolvedAt || !photo.captionResolvedAt) {
        photo.processingFailedAt = failedAt;
      }
    }
  }
  await writeManifest(manifest);
  const sample = lastUnresolved.slice(0, 20).join("\n  - ");
  throw new Error(
    `${lastUnresolved.length} media outputs did not resolve before timeout:\n  - ${sample}`,
  );
}

async function setCoverPhotos(owner: ApiSession, manifest: DemoManifest): Promise<void> {
  for (const project of manifest.projects) {
    if (!project.projectId) throw new Error(`Project id missing for ${project.name}.`);
    const cover = project.photos.find(
      (photo) => photo.width > photo.height && photo.mediaId != null,
    );
    if (!cover?.mediaId) throw new Error(`No landscape cover candidate for ${project.name}.`);

    if (project.coverPhotoId !== cover.mediaId) {
      await owner.request<ApiProject>(`/api/projects/${project.projectId}`, {
        method: "PATCH",
        body: { coverPhotoId: cover.mediaId },
      });
      project.coverPhotoId = cover.mediaId;
      await writeManifest(manifest);
    }
    console.log(`Set cover for ${project.name} to media ${cover.mediaId}.`);
  }
}

async function promptForDatabaseUrl(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stdout.isTTY || typeof input.setRawMode !== "function") {
    throw new Error(
      "Backdate requires an interactive terminal for the hidden one-time DATABASE_URL prompt.",
    );
  }

  process.stdout.write("Development DATABASE_URL (hidden): ");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = "";
    const finish = (error?: Error) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Backdate database prompt cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
  });
}

function backdateRows(manifest: DemoManifest) {
  return manifest.projects.map((project) => {
    if (!project.projectId || project.photos.some((photo) => !photo.mediaId)) {
      throw new Error(`Cannot backdate incomplete project ${project.name}.`);
    }
    if (
      project.photos.some(
        (photo) => !photo.thumbnailResolvedAt || !photo.captionResolvedAt,
      )
    ) {
      throw new Error(`Cannot backdate ${project.name} before all media processing resolves.`);
    }
    const times = project.photos.map((photo) => new Date(photo.takenAt).getTime());
    const createdAt = new Date(Math.min(...times) - 24 * 60 * 60 * 1_000);
    const updatedAt = new Date(Math.max(...times) + 2 * 60 * 60 * 1_000);
    return {
      id: project.projectId,
      created_at: createdAt.toISOString(),
      updated_at: updatedAt.toISOString(),
    };
  });
}

async function runBackdate(
  config: SeedConfig,
  manifest: DemoManifest,
  owner: ApiSession,
): Promise<void> {
  const accountId = owner.user?.accountId;
  if (!accountId) throw new Error("Authenticated owner has no account id.");
  const rows = backdateRows(manifest);

  if (config.dryRun) {
    console.log("DRY RUN: backdate would update these project timestamps:");
    for (const row of rows) {
      console.log(`  ${row.id}: ${row.created_at} -> ${row.updated_at}`);
    }
    return;
  }

  const databaseUrl = await promptForDatabaseUrl();
  const host = assertAttachedDevelopmentDatabase(databaseUrl);
  console.log(`Backdating ${rows.length} projects in one transaction on dev host ${host}.`);

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ id: number }>(
      `UPDATE projects AS p
          SET created_at = (v.created_at::timestamptz AT TIME ZONE 'UTC'),
              updated_at = (v.updated_at::timestamptz AT TIME ZONE 'UTC')
         FROM jsonb_to_recordset($2::jsonb)
              AS v(id integer, created_at text, updated_at text)
        WHERE p.id = v.id
          AND p.account_id = $1
      RETURNING p.id`,
      [accountId, JSON.stringify(rows)],
    );
    if (updated.rowCount !== rows.length) {
      throw new Error(
        `Backdate scope mismatch: expected ${rows.length} rows, updated ${updated.rowCount}.`,
      );
    }
    await client.query("COMMIT");
    console.log(`Backdated ${updated.rowCount} projects.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function printPlan(config: SeedConfig, mode: "seed" | "backdate"): void {
  console.log("=".repeat(72));
  console.log("Field View demo seed");
  console.log(`Mode     : ${config.dryRun ? "DRY RUN (no network or data mutations)" : mode.toUpperCase()}`);
  console.log(`Target host : ${new URL(config.baseUrl).host}`);
  console.log(`Projects : ${PROJECT_DEFINITIONS.length}`);
  console.log(
    `Photos   : ${PROJECT_DEFINITIONS.reduce((total, project) => total + project.targetPhotoCount, 0)}`,
  );
  console.log("=".repeat(72));
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--backdate") ? "backdate" : "seed";
  const config = loadSeedConfig(mode);
  printPlan(config, mode);

  if (config.dryRun) {
    console.log("Configuration and development-host guards passed.");
    console.log("No login, Pexels request, S3 upload, API mutation, or database query was made.");
    return;
  }

  const sessions = await loginDemoUsers(config);
  const owner = sessions[0];
  const accountId = owner.user!.accountId!;
  console.log(`Authenticated four users in demo account ${accountId}.`);

  let manifest = await readManifest();
  if (!manifest) {
    manifest = newManifest(config.baseUrl);
  }
  validateManifestShape(manifest);
  assertManifestTarget(manifest, config.baseUrl, accountId);
  manifest.accountId = accountId;
  await writeManifest(manifest);

  if (mode === "backdate") {
    await runBackdate(config, manifest, owner);
    return;
  }

  await ensureProjects(owner, manifest);
  await sourcePhotos(config, manifest);
  await resetTimedOutMedia(owner, manifest);
  await uploadPhotos(sessions, manifest);
  await waitForProcessing(owner, manifest);
  await setCoverPhotos(owner, manifest);

  const mediaCount = manifest.projects.reduce(
    (total, project) => total + project.photos.filter((photo) => photo.mediaId).length,
    0,
  );
  const thumbnailCount = manifest.projects.reduce(
    (total, project) => total + project.photos.filter((photo) => photo.thumbnailResolvedAt).length,
    0,
  );
  const captionCount = manifest.projects.reduce(
    (total, project) => total + project.photos.filter((photo) => photo.captionResolvedAt).length,
    0,
  );
  console.log("");
  console.log("Seed complete.");
  console.log(`  Projects created/resumed : ${manifest.projects.length}`);
  console.log(`  Media rows created       : ${mediaCount}`);
  console.log(`  Thumbnails resolved      : ${thumbnailCount}`);
  console.log(`  AI captions resolved     : ${captionCount}`);
  console.log(`  Manifest                 : script/seed-demo-manifest.json`);
}

if (invokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { main };