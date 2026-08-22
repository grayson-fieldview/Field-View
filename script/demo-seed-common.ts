import { existsSync } from "fs";
import { readFile, rename, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEMO_MANIFEST_PATH = resolve(SCRIPT_DIR, "seed-demo-manifest.json");
const LOCAL_ENV_PATH = resolve(process.cwd(), ".env.local");
// Snapshot before .env.local is loaded so a file cannot redefine which
// database this development runtime is attached to.
const STARTUP_DATABASE_URL = process.env.DATABASE_URL;
const STARTUP_DEMO_DEV_DATABASE_ID = process.env.DEMO_DEV_DATABASE_ID;

async function loadLocalEnvironment(): Promise<void> {
  if (!existsSync(LOCAL_ENV_PATH)) return;

  try {
    // Keep dotenv optional because this repository's mixed npm/pnpm layout can
    // prevent adding packages. Node 20's compatible parser below is the safe
    // fallback on clean installs where dotenv is unavailable.
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<{
      config: (options: {
        path: string;
        override: boolean;
        quiet: boolean;
      }) => { error?: Error };
    }>;
    const dotenv = await dynamicImport("dotenv");
    const result = dotenv.config({
      path: LOCAL_ENV_PATH,
      override: false,
      quiet: true,
    });
    if (result.error) throw result.error;
    return;
  } catch (dotenvError) {
    const loadEnvFile = (
      process as NodeJS.Process & { loadEnvFile?: (path: string) => void }
    ).loadEnvFile;
    if (typeof loadEnvFile === "function") {
      loadEnvFile(LOCAL_ENV_PATH);
      return;
    }
    throw new Error(
      `Unable to load .env.local. Install dotenv or use Node with process.loadEnvFile support. ` +
        `Cause: ${dotenvError instanceof Error ? dotenvError.message : String(dotenvError)}`,
    );
  }
}

await loadLocalEnvironment();

export type Credential = {
  label: string;
  email: string;
  password: string;
};

export type AuthUser = {
  id: string;
  email?: string | null;
  role?: string | null;
  accountId?: string | null;
  isOwner?: boolean;
};

export type ApiProject = {
  id: number;
  name: string;
  accountId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  coverPhotoId?: number | null;
  [key: string]: unknown;
};

export type ApiMedia = {
  id: number;
  projectId: number;
  filename: string;
  originalName: string;
  mimeType: string;
  url: string;
  thumbUrl?: string | null;
  aiCaption?: string | null;
  uploadedById?: string | null;
  [key: string]: unknown;
};

export type ProjectDetail = {
  project: ApiProject;
  media: ApiMedia[];
};

export type ManifestPhoto = {
  pexelsId: number;
  pexelsPageUrl: string;
  sourceUrl: string;
  photographer: string;
  width: number;
  height: number;
  originalName: string;
  takenAt: string;
  uploaderSlot: number;
  humanCaption: string | null;
  s3Key?: string;
  publicUrl?: string;
  s3UploadedAt?: string;
  mediaId?: number;
  thumbUrl?: string;
  thumbnailResolvedAt?: string;
  captionResolvedAt?: string;
  processingFailedAt?: string;
};

export type ManifestProject = {
  slug: string;
  name: string;
  description: string;
  status: "active" | "completed" | "on_hold";
  address: string;
  color: string;
  tags: string[];
  pexelsQuery: string;
  targetPhotoCount: number;
  projectId?: number;
  latitude?: number;
  longitude?: number;
  coverPhotoId?: number;
  photos: ManifestPhoto[];
};

export type DemoManifest = {
  version: 1;
  baseUrl: string;
  generatedAt: string;
  timelineEndAt: string;
  accountId?: string;
  projects: ManifestProject[];
  teardown?: {
    startedAt: string;
    accountId: string;
    projects: Array<{
      projectId: number;
      projectName: string;
      mediaCount: number;
      keys: string[];
      projectDeletedAt?: string;
      cleanupVerifiedAt?: string;
    }>;
  };
};

export type SeedConfig = {
  baseUrl: string;
  origin: string;
  dryRun: boolean;
  pexelsApiKey: string;
  credentials: Credential[];
};

export type UnseedConfig = {
  baseUrl: string;
  origin: string;
  dryRun: boolean;
  owner: Credential;
};

function requireEnvironment(names: string[]): Record<string, string> {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }

  return Object.fromEntries(names.map((name) => [name, process.env[name]!.trim()]));
}

function parseDryRun(): boolean {
  const raw = process.env.DRY_RUN?.trim().toLowerCase();
  if (raw == null || raw === "") return true;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  throw new Error("DRY_RUN must be true or false.");
}

function developmentUrl(
  raw: string,
  allowProductionWithExplicitConfirmation = false,
): { baseUrl: string; origin: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("BASE_URL must be a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("BASE_URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("BASE_URL must not contain credentials.");
  }

  const host = parsed.hostname.toLowerCase();
  const isDevelopmentHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".replit.dev");

  const productionConfirmed =
    process.env.SEED_DEMO_ALLOW_PROD === "yes" &&
    process.argv.includes("--i-understand-this-is-production");
  if (
    !isDevelopmentHost &&
    (!allowProductionWithExplicitConfirmation || !productionConfirmed)
  ) {
    throw new Error(
      `BASE_URL host '${host}' is not a development host. Refusing by default. ` +
        "Set SEED_DEMO_ALLOW_PROD=yes and pass --i-understand-this-is-production to proceed.",
    );
  }

  const baseUrl = parsed.toString().replace(/\/$/, "");
  return { baseUrl, origin: parsed.origin };
}

type DatabaseIdentity = {
  host: string;
  port: string;
  database: string;
};

function databaseIdentity(raw: string, label: string): DatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL.`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${label} must use the postgres or postgresql protocol.`);
  }
  const host = parsed.hostname.toLowerCase();
  const isDevelopmentHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".neon.tech");
  if (!isDevelopmentHost || host.endsWith(".rds.amazonaws.com")) {
    throw new Error(`${label} does not point to an allowed development database host.`);
  }
  return {
    host,
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "")),
  };
}

function databaseIdentityKey(identity: DatabaseIdentity): string {
  return `${identity.host}:${identity.port}/${identity.database}`;
}

export function assertAttachedDevelopmentDatabase(candidateUrl: string): string {
  if (!STARTUP_DATABASE_URL) {
    throw new Error(
      "This runtime did not start with DATABASE_URL, so the backdate target cannot be verified.",
    );
  }
  const expected = databaseIdentity(STARTUP_DATABASE_URL, "Attached DATABASE_URL");
  const candidate = databaseIdentity(candidateUrl, "Entered DATABASE_URL");
  if (!STARTUP_DEMO_DEV_DATABASE_ID) {
    throw new Error(
      "DEMO_DEV_DATABASE_ID must be supplied at process startup for backdate " +
        "(format: hostname:port/database; do not put it in .env.local).",
    );
  }
  if (databaseIdentityKey(expected) !== STARTUP_DEMO_DEV_DATABASE_ID) {
    throw new Error(
      "The database attached to this runtime does not match DEMO_DEV_DATABASE_ID.",
    );
  }
  if (
    candidate.host !== expected.host ||
    candidate.port !== expected.port ||
    candidate.database !== expected.database
  ) {
    throw new Error(
      "Entered DATABASE_URL does not identify the database attached to this development runtime.",
    );
  }
  return candidate.host;
}

function normalizedCredential(label: string, email: string, password: string): Credential {
  if (password.length < 8) {
    throw new Error(`${label} password must be at least 8 characters.`);
  }
  return { label, email: email.trim().toLowerCase(), password };
}

export function loadSeedConfig(mode: "seed" | "backdate" = "seed"): SeedConfig {
  const env = requireEnvironment([
    "DEMO_OWNER_EMAIL",
    "DEMO_OWNER_PASSWORD",
    "DEMO_CREW_1_EMAIL",
    "DEMO_CREW_1_PASSWORD",
    "DEMO_CREW_2_EMAIL",
    "DEMO_CREW_2_PASSWORD",
    "DEMO_CREW_3_EMAIL",
    "DEMO_CREW_3_PASSWORD",
    "PEXELS_API_KEY",
  ]);
  const dryRun = parseDryRun();
  const url = developmentUrl(
    process.env.BASE_URL?.trim() || "http://127.0.0.1:5000",
    true,
  );

  if (!dryRun && process.env.SEED_DEMO_CONFIRM !== "yes") {
    throw new Error("SEED_DEMO_CONFIRM must equal 'yes' when DRY_RUN=false.");
  }
  if (!dryRun && mode === "backdate" && process.env.BACKDATE_DEMO_CONFIRM !== "yes") {
    throw new Error("BACKDATE_DEMO_CONFIRM must equal 'yes' for the backdate pass.");
  }

  const credentials = [
    normalizedCredential("Demo owner", env.DEMO_OWNER_EMAIL, env.DEMO_OWNER_PASSWORD),
    normalizedCredential("Demo crew 1", env.DEMO_CREW_1_EMAIL, env.DEMO_CREW_1_PASSWORD),
    normalizedCredential("Demo crew 2", env.DEMO_CREW_2_EMAIL, env.DEMO_CREW_2_PASSWORD),
    normalizedCredential("Demo crew 3", env.DEMO_CREW_3_EMAIL, env.DEMO_CREW_3_PASSWORD),
  ];
  if (new Set(credentials.map((item) => item.email)).size !== credentials.length) {
    throw new Error("All four demo-user email addresses must be unique.");
  }

  return {
    ...url,
    dryRun,
    pexelsApiKey: env.PEXELS_API_KEY,
    credentials,
  };
}

export function loadUnseedConfig(): UnseedConfig {
  const env = requireEnvironment(["DEMO_OWNER_EMAIL", "DEMO_OWNER_PASSWORD"]);
  const dryRun = parseDryRun();
  const url = developmentUrl(process.env.BASE_URL?.trim() || "http://127.0.0.1:5000");

  if (!dryRun && process.env.UNSEED_DEMO_CONFIRM !== "yes") {
    throw new Error("UNSEED_DEMO_CONFIRM must equal 'yes' when DRY_RUN=false.");
  }

  return {
    ...url,
    dryRun,
    owner: normalizedCredential("Demo owner", env.DEMO_OWNER_EMAIL, env.DEMO_OWNER_PASSWORD),
  };
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(500, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(500, date - Date.now());
  }
  return Math.min(30_000, 1_000 * 2 ** attempt);
}

export async function fetchWith429Retry(
  url: string,
  init: RequestInit,
  label: string,
  maxAttempts = 5,
): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429) return response;
    lastResponse = response;
    const waitMs = retryDelay(response, attempt);
    console.warn(`${label} was rate-limited; retrying in ${Math.ceil(waitMs / 1_000)}s.`);
    await response.body?.cancel().catch(() => undefined);
    await sleep(waitMs);
  }
  return lastResponse!;
}

async function errorBody(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return "(empty response)";
  try {
    const parsed = JSON.parse(text);
    return parsed?.message || parsed?.error?.message || JSON.stringify(parsed);
  } catch {
    return text.slice(0, 500);
  }
}

function sessionCookie(headers: Headers): string {
  const values =
    typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : [headers.get("set-cookie") || ""];
  const cookies = values
    .filter(Boolean)
    .map((value) => value.split(";", 1)[0])
    .filter(Boolean);
  if (cookies.length === 0) {
    throw new Error("Login succeeded but the response did not include a session cookie.");
  }
  return cookies.join("; ");
}

export class ApiSession {
  readonly baseUrl: string;
  readonly origin: string;
  readonly credential: Credential;
  private cookie = "";
  user: AuthUser | null = null;

  constructor(baseUrl: string, origin: string, credential: Credential) {
    this.baseUrl = baseUrl;
    this.origin = origin;
    this.credential = credential;
  }

  async login(): Promise<AuthUser> {
    const response = await fetchWith429Retry(
      `${this.baseUrl}/api/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: this.origin,
          "X-FieldView-Client": "mobile-1",
        },
        body: JSON.stringify({
          email: this.credential.email,
          password: this.credential.password,
        }),
      },
      `${this.credential.label} login`,
    );
    if (!response.ok) {
      throw new Error(
        `${this.credential.label} login failed (${response.status}): ${await errorBody(response)}`,
      );
    }
    this.cookie = sessionCookie(response.headers);
    await response.body?.cancel().catch(() => undefined);

    const user = await this.request<AuthUser>("/api/auth/user");
    if (!user.id || !user.accountId) {
      throw new Error(`${this.credential.label} authenticated without an id/accountId.`);
    }
    this.user = user;
    return user;
  }

  async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      expectedStatuses?: number[];
    } = {},
  ): Promise<T> {
    if (!this.cookie) throw new Error(`${this.credential.label} has not logged in.`);
    const method = options.method || "GET";
    const headers: Record<string, string> = {
      Accept: "application/json",
      Cookie: this.cookie,
      Origin: this.origin,
      "X-FieldView-Client": "mobile-1",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetchWith429Retry(
      `${this.baseUrl}${path}`,
      {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      },
      `${method} ${path}`,
    );
    const expected = options.expectedStatuses || [];
    if (!response.ok && !expected.includes(response.status)) {
      throw new Error(`${method} ${path} failed (${response.status}): ${await errorBody(response)}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export async function loginDemoUsers(config: SeedConfig): Promise<ApiSession[]> {
  const sessions: ApiSession[] = [];
  for (const credential of config.credentials) {
    const session = new ApiSession(config.baseUrl, config.origin, credential);
    await session.login();
    sessions.push(session);
    await sleep(250);
  }

  const accountIds = new Set(sessions.map((session) => session.user?.accountId));
  if (accountIds.size !== 1 || accountIds.has(null) || accountIds.has(undefined)) {
    throw new Error("All four demo users must belong to the same account.");
  }
  if (!sessions[0].user?.isOwner) {
    throw new Error("DEMO_OWNER_EMAIL authenticated successfully but is not the account owner.");
  }
  const restrictedCrew = sessions.slice(1).filter((session) => session.user?.role === "restricted");
  if (restrictedCrew.length > 0) {
    throw new Error(
      `Restricted crew users cannot upload to newly created projects without assignments: ` +
        restrictedCrew.map((session) => session.credential.label).join(", "),
    );
  }

  return sessions;
}

export async function readManifest(): Promise<DemoManifest | null> {
  if (!existsSync(DEMO_MANIFEST_PATH)) return null;
  const parsed = JSON.parse(await readFile(DEMO_MANIFEST_PATH, "utf8")) as DemoManifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
    throw new Error(`Unsupported or malformed manifest: ${DEMO_MANIFEST_PATH}`);
  }
  return parsed;
}

export async function writeManifest(manifest: DemoManifest): Promise<void> {
  const temporaryPath = `${DEMO_MANIFEST_PATH}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, DEMO_MANIFEST_PATH);
}

export function assertManifestTarget(
  manifest: DemoManifest,
  baseUrl: string,
  accountId: string,
): void {
  if (new URL(manifest.baseUrl).origin !== new URL(baseUrl).origin) {
    throw new Error(
      `Existing manifest targets ${manifest.baseUrl}, not ${baseUrl}. ` +
        "Move or remove the manifest before targeting another environment.",
    );
  }
  if (manifest.accountId && manifest.accountId !== accountId) {
    throw new Error(
      "Existing manifest belongs to a different account. Move or remove it before continuing.",
    );
  }
}

export function invokedDirectly(importMetaUrl: string): boolean {
  return !!process.argv[1] && fileURLToPath(importMetaUrl) === resolve(process.argv[1]);
}