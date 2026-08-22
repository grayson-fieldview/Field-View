/**
 * Development-only teardown for the dedicated demo account.
 *
 * Preview only (default):
 *   npx tsx script/unseed-demo-account.ts
 *
 * Delete all projects in the authenticated demo account and their generated
 * original/thumbnail S3 objects:
 *   DRY_RUN=false UNSEED_DEMO_CONFIRM=yes npx tsx script/unseed-demo-account.ts
 */

import { rename } from "fs/promises";
import {
  ApiMedia,
  ApiProject,
  ApiSession,
  DEMO_MANIFEST_PATH,
  DemoManifest,
  ProjectDetail,
  assertManifestTarget,
  invokedDirectly,
  loadUnseedConfig,
  readManifest,
  sleep,
  writeManifest,
} from "./demo-seed-common";

type ProjectInventory = {
  project: ApiProject;
  keys: string[];
  mediaCount: number;
};

type TeardownProject = NonNullable<DemoManifest["teardown"]>["projects"][number];

const GENERATED_PHOTO_KEY = /^photos\/(?:thumbs\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeGeneratedKey(candidate: string | null | undefined): string | null {
  if (!candidate || !GENERATED_PHOTO_KEY.test(candidate)) return null;
  return candidate;
}

function deterministicThumbnailKey(originalKey: string): string {
  const basename = originalKey.split("/").pop()!.replace(/\.[^.]+$/, "");
  return `photos/thumbs/${basename}.jpg`;
}

async function inventoryProject(
  owner: ApiSession,
  project: ApiProject,
  extractS3KeyFromUrl: (url: string) => string | null,
): Promise<ProjectInventory> {
  const detail = await owner.request<ProjectDetail>(`/api/projects/${project.id}`);
  const keys = new Set<string>();

  for (const item of detail.media as ApiMedia[]) {
    const original =
      safeGeneratedKey(item.filename) || safeGeneratedKey(extractS3KeyFromUrl(item.url));
    if (!original) {
      throw new Error(
        `Media ${item.id} in project ${project.id} has an unexpected original-object key; ` +
          "refusing teardown before any project deletion.",
      );
    }
    keys.add(original);
    // Thumbnail generation uses this deterministic key even when thumbUrl has
    // not reached the database yet. Include it unconditionally to close the
    // inventory-vs-worker race; S3 DeleteObject is idempotent.
    keys.add(deterministicThumbnailKey(original));

    if (item.thumbUrl) {
      const thumbnail = safeGeneratedKey(extractS3KeyFromUrl(item.thumbUrl));
      if (!thumbnail || !thumbnail.startsWith("photos/thumbs/")) {
        throw new Error(
          `Media ${item.id} in project ${project.id} has an unexpected thumbnail key; ` +
            "refusing teardown before any project deletion.",
        );
      }
      keys.add(thumbnail);
    }
  }

  return {
    project: detail.project,
    keys: [...keys],
    mediaCount: detail.media.length,
  };
}

function archiveName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return DEMO_MANIFEST_PATH.replace(/\.json$/, `.unseeded-${stamp}.json`);
}

function quietWindowMs(): number {
  const raw = process.env.DEMO_UNSEED_QUIET_SECONDS?.trim() || "30";
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 300) {
    throw new Error("DEMO_UNSEED_QUIET_SECONDS must be between 10 and 300.");
  }
  return seconds * 1_000;
}

function cleanupTimeoutMs(): number {
  const raw = process.env.DEMO_UNSEED_CLEANUP_TIMEOUT_MINUTES?.trim() || "5";
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 30) {
    throw new Error("DEMO_UNSEED_CLEANUP_TIMEOUT_MINUTES must be between 1 and 30.");
  }
  return minutes * 60 * 1_000;
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.name === "NotFound" ||
    candidate.name === "NoSuchKey" ||
    candidate.Code === "NoSuchKey"
  );
}

async function objectExists(
  key: string,
  getObjectSize: (key: string) => Promise<number>,
): Promise<boolean> {
  try {
    await getObjectSize(key);
    return true;
  } catch (error) {
    if (isMissingObjectError(error)) return false;
    throw error;
  }
}

async function deleteAll(
  item: TeardownProject,
  deleteFromS3: (key: string) => Promise<void>,
): Promise<void> {
  for (const key of item.keys) {
    await deleteFromS3(key);
    await sleep(50);
  }
}

async function verifyQuietCleanup(
  items: TeardownProject[],
  deleteFromS3: (key: string) => Promise<void>,
  getObjectSize: (key: string) => Promise<number>,
): Promise<void> {
  const keys = [...new Set(items.flatMap((item) => item.keys))];
  const requiredQuietMs = quietWindowMs();
  const deadline = Date.now() + cleanupTimeoutMs();
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    let foundObject = false;
    for (const key of keys) {
      if (await objectExists(key, getObjectSize)) {
        foundObject = true;
        await deleteFromS3(key);
      }
    }
    if (foundObject) quietSince = Date.now();
    if (Date.now() - quietSince >= requiredQuietMs) return;
    await sleep(2_000);
  }

  throw new Error(
    `Recorded S3 keys did not remain absent for ` +
      `${Math.round(requiredQuietMs / 1_000)} seconds before cleanup timeout.`,
  );
}

async function main(): Promise<void> {
  const config = loadUnseedConfig();
  console.log("=".repeat(72));
  console.log("Field View demo teardown");
  console.log(`Mode   : ${config.dryRun ? "DRY RUN (no network or data mutations)" : "UNSEED"}`);
  console.log(`Target : ${config.baseUrl}`);
  console.log("Scope  : every project in the authenticated dedicated demo account");
  console.log("=".repeat(72));

  if (config.dryRun) {
    console.log("Configuration and development-host guards passed.");
    console.log("No login, API request, database mutation, or S3 operation was made.");
    return;
  }

  const missingAws = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].filter(
    (name) => !process.env[name]?.trim(),
  );
  if (missingAws.length > 0) {
    throw new Error(
      `Missing required environment variable${missingAws.length === 1 ? "" : "s"} for S3 cleanup: ` +
        missingAws.join(", "),
    );
  }

  const owner = new ApiSession(config.baseUrl, config.origin, config.owner);
  const user = await owner.login();
  if (!user.isOwner || !user.accountId) {
    throw new Error("DEMO_OWNER_EMAIL is not the owner of an account; refusing teardown.");
  }

  const manifest = await readManifest();
  if (!manifest?.accountId) {
    throw new Error(
      "A seed-demo manifest bound to an account is required before teardown.",
    );
  }
  assertManifestTarget(manifest, config.baseUrl, user.accountId);

  const { deleteFromS3, extractS3KeyFromUrl, getObjectSize } = await import("../server/s3");
  const projects = await owner.request<ApiProject[]>("/api/projects");
  console.log(`Authenticated owner for account ${user.accountId}; found ${projects.length} projects.`);

  if (manifest.teardown) {
    if (manifest.teardown.accountId !== user.accountId) {
      throw new Error("Existing teardown ledger belongs to a different account.");
    }
    const recordedIds = new Set(
      manifest.teardown.projects.map((project) => project.projectId),
    );
    const unrecorded = projects.filter((project) => !recordedIds.has(project.id));
    if (unrecorded.length > 0) {
      throw new Error(
        `Found ${unrecorded.length} project(s) created after teardown inventory. ` +
          "Refusing to expand a destructive ledger automatically.",
      );
    }
    console.log("Resuming the persisted teardown ledger.");
  } else {
    // Finish every safety check and persist every retry key before the first
    // destructive S3 or API request.
    const inventory: ProjectInventory[] = [];
    for (const project of projects) {
      inventory.push(await inventoryProject(owner, project, extractS3KeyFromUrl));
    }
    manifest.teardown = {
      startedAt: new Date().toISOString(),
      accountId: user.accountId,
      projects: inventory.map((item) => ({
        projectId: item.project.id,
        projectName: item.project.name,
        mediaCount: item.mediaCount,
        keys: item.keys,
      })),
    };
    await writeManifest(manifest);
  }

  const ledger = manifest.teardown;
  const mediaCount = ledger.projects.reduce((total, item) => total + item.mediaCount, 0);
  const objectCount = new Set(ledger.projects.flatMap((item) => item.keys)).size;
  console.log(`Inventory complete: ${mediaCount} media rows, ${objectCount} S3 objects.`);

  const liveProjectIds = new Set(projects.map((project) => project.id));
  const failures: string[] = [];

  for (const item of ledger.projects) {
    try {
      await deleteAll(item, deleteFromS3);
      if (!item.projectDeletedAt) {
        if (liveProjectIds.has(item.projectId)) {
          try {
            await owner.request<{ message: string }>(`/api/projects/${item.projectId}`, {
              method: "DELETE",
            });
          } catch (error) {
            // Reconcile a crash/timeout where the API committed before the
            // client observed the response.
            if (!(error instanceof Error) || !error.message.includes("(404)")) throw error;
          }
        }
        item.projectDeletedAt = new Date().toISOString();
        await writeManifest(manifest);
        console.log(`Deleted project ${item.projectId}: ${item.projectName}`);
      }
    } catch (error) {
      failures.push(
        `Project ${item.projectId} teardown phase failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  const deletedItems = ledger.projects.filter((item) => item.projectDeletedAt);
  if (deletedItems.length > 0) {
    try {
      await verifyQuietCleanup(deletedItems, deleteFromS3, getObjectSize);
      const verifiedAt = new Date().toISOString();
      for (const item of deletedItems) {
        item.cleanupVerifiedAt = verifiedAt;
      }
      await writeManifest(manifest);
    } catch (error) {
      failures.push(
        `Post-cascade S3 verification failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  const deletedProjects = ledger.projects.filter((item) => item.projectDeletedAt).length;
  const verifiedProjects = ledger.projects.filter((item) => item.cleanupVerifiedAt).length;
  console.log("");
  console.log("Teardown summary.");
  console.log(`  Projects deleted : ${deletedProjects}/${ledger.projects.length}`);
  console.log(`  Media rows       : ${mediaCount} (removed by project cascade)`);
  console.log(`  S3 cleanup       : ${verifiedProjects}/${ledger.projects.length} projects verified`);

  const incomplete = ledger.projects.filter(
    (item) => !item.projectDeletedAt || !item.cleanupVerifiedAt,
  );
  if (failures.length > 0 || incomplete.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    if (incomplete.length > 0) {
      console.error(
        `  - Persisted ledger still has ${incomplete.length} incomplete project(s); rerun safely.`,
      );
    }
    throw new Error(
      `Teardown is incomplete; the manifest ledger was retained for a safe retry.`,
    );
  }

  // One final idempotent sweep immediately before archive. This cannot lose
  // retry state: any failure leaves the manifest and its complete ledger.
  try {
    for (const item of ledger.projects) {
      for (const key of item.keys) {
        try {
          await deleteFromS3(key);
        } catch (error) {
          throw new Error(
            `Final S3 sweep failed for ${key}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }
  } catch (error) {
    throw error;
  }

  const archived = archiveName();
  await rename(DEMO_MANIFEST_PATH, archived);
  console.log(`  S3 objects       : ${objectCount} recorded keys absent`);
  console.log(`  Manifest archived: ${archived.replace(`${process.cwd()}/`, "")}`);
}

if (invokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error("Fatal:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { main };