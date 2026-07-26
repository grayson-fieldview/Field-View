/**
 * Integration test — task photo requirement gate in PATCH /api/tasks/:id.
 *
 * Locks in three behaviors:
 *   1. NO-REQUIREMENT PASS-THROUGH: required_photo_count=0 (the default)
 *      never blocks the done transition.
 *   2. 422 SHAPE: transitioning to done below the requirement gets
 *      422 { code: "PHOTOS_REQUIRED", required, attached }.
 *   3. PRE-UPDATE SEMANTICS: a single PATCH sending BOTH status:"done" and a
 *      new requiredPhotoCount is gated against the requirement that was on
 *      the task BEFORE the PATCH — the new value persists but does not block
 *      this same request.
 *
 * Runs a real in-process HTTP server (same registerRoutes as production) on
 * an ephemeral port against the DEV DATABASE — refuses to run unless the
 * DATABASE_URL host is *.neon.tech and NODE_ENV=development. Creates a
 * throwaway account/project/task over the API and deletes the rows it
 * created at the end.
 *
 * Run: NODE_ENV=development npx tsx scripts/tests/test_task_photo_requirement.ts
 */
import express from "express";
import { createServer } from "http";
import { eq } from "drizzle-orm";

// ── Safety guards ──────────────────────────────────────────────────────────
const url = process.env.DATABASE_URL || "";
let host = "";
try { host = new URL(url).hostname; } catch { /* handled below */ }
if (!host.includes("neon.tech")) {
  console.error(`Refusing to run: DATABASE_URL host "${host}" is not a dev Neon database.`);
  process.exit(1);
}
if (process.env.NODE_ENV !== "development") {
  console.error("Refusing to run: NODE_ENV must be 'development' (recaptcha dev bypass required).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : ""); }
}

async function main() {
  const { registerRoutes } = await import("../../server/routes");
  const { db } = await import("../../server/db");
  const { tasks } = await import("../../shared/schema");
  const { users, accounts } = await import("../../shared/models/auth");

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = (httpServer.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  // Cookie jar + CSRF mobile-header bypass (no Origin on node fetch).
  let cookie = "";
  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-fieldview-client": "mobile-1",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let json: any = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  }

  const email = `photoreq-test-${Date.now()}@example.com`;
  let accountId: string | undefined;
  let userId: string | undefined;
  let projectId: number | undefined;

  try {
    // ── Setup: register throwaway admin account, project, task ────────────
    const reg = await api("POST", "/api/register", {
      email, password: "test-password-1", companyName: "PhotoReq Test Co", termsAccepted: true,
    });
    if (reg.status !== 200 && reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
    const me = await api("GET", "/api/auth/user");
    accountId = me.json?.accountId;
    userId = me.json?.id;
    if (!accountId) throw new Error(`no accountId on /api/auth/user: ${JSON.stringify(me.json)}`);

    const proj = await api("POST", "/api/projects", { name: "PhotoReq Test Project" });
    if (proj.status !== 200 && proj.status !== 201) throw new Error(`project create failed: ${proj.status} ${JSON.stringify(proj.json)}`);
    projectId = proj.json.id;

    const taskRes = await api("POST", `/api/projects/${projectId}/tasks`, { title: "PhotoReq task" });
    if (taskRes.status !== 200 && taskRes.status !== 201) throw new Error(`task create failed: ${taskRes.status} ${JSON.stringify(taskRes.json)}`);
    const taskId: number = taskRes.json.id;

    // ── 1. No requirement (default 0) ⇒ done transition passes ────────────
    console.log("1. No requirement (required_photo_count=0 default):");
    const r1 = await api("PATCH", `/api/tasks/${taskId}`, { status: "done" });
    check("PATCH status:done succeeds (200)", r1.status === 200, r1);
    check("task is done", r1.json?.status === "done");

    // ── 2. Requirement set ⇒ 422 with exact shape on the done transition ──
    console.log("2. 422 shape (requirement=2, 0 attached):");
    await api("PATCH", `/api/tasks/${taskId}`, { status: "todo" }); // reset
    await db.update(tasks).set({ requiredPhotoCount: 2 }).where(eq(tasks.id, taskId));
    const r2 = await api("PATCH", `/api/tasks/${taskId}`, { status: "done" });
    check("returns 422", r2.status === 422, r2);
    check('code === "PHOTOS_REQUIRED"', r2.json?.code === "PHOTOS_REQUIRED", r2.json);
    check("required === 2", r2.json?.required === 2, r2.json);
    check("attached === 0", r2.json?.attached === 0, r2.json);

    // ── 3. Combined PATCH: gate uses PRE-update requirement ───────────────
    console.log("3. Combined PATCH {status:done, requiredPhotoCount:3} on a task whose pre-update requirement is 0:");
    await db.update(tasks).set({ requiredPhotoCount: 0, status: "todo" }).where(eq(tasks.id, taskId));
    const r3 = await api("PATCH", `/api/tasks/${taskId}`, { status: "done", requiredPhotoCount: 3 });
    check("succeeds (200) — gated on pre-update value 0", r3.status === 200, r3);
    check("status persisted as done", r3.json?.status === "done");
    check("new requiredPhotoCount=3 persisted", r3.json?.requiredPhotoCount === 3, r3.json);
    // …and the new value DOES gate the NEXT transition:
    await api("PATCH", `/api/tasks/${taskId}`, { status: "todo" });
    const r3b = await api("PATCH", `/api/tasks/${taskId}`, { status: "done" });
    check("next done-transition is gated by the new value (422)", r3b.status === 422, r3b);

    // ── 3b. Inverse: pre-update requirement 2, PATCH lowers to 0 + done ───
    console.log("3b. Combined PATCH {status:done, requiredPhotoCount:0} on a task whose pre-update requirement is 2:");
    await db.update(tasks).set({ requiredPhotoCount: 2, status: "todo" }).where(eq(tasks.id, taskId));
    const r4 = await api("PATCH", `/api/tasks/${taskId}`, { status: "done", requiredPhotoCount: 0 });
    check("blocked (422) — gated on pre-update value 2, not the incoming 0", r4.status === 422, r4);
  } finally {
    // ── Cleanup: remove everything this test created ───────────────────────
    try {
      if (projectId) await api("DELETE", `/api/projects/${projectId}`);
      if (userId) await db.delete(users).where(eq(users.id, userId));
      if (accountId) await db.delete(accounts).where(eq(accounts.id, accountId));
    } catch (e) {
      console.warn("cleanup warning:", (e as Error).message);
    }
    httpServer.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
