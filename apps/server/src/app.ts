/**
 * HTTP surface of the factory server:
 *   GET  /healthz
 *   GET  /v1/tasks[?status=&limit=]  GET /v1/tasks/:id  GET /v1/tasks/:id/events  POST /v1/tasks/:id/cancel
 *   POST /v1/tasks/:id/retry         try a failed or stopped task again
 *   GET  /v1/health                  start-up checks (code host, repos, model gateway, routed models)
 *   GET  /v1/factory                 version, providers, models, prompts (no secrets)
 *   POST /v1/egress                  egress proxy collector reports
 *   POST /v1/signals                 inject a contract Signal (tests, CLI, other tools)
 *   /v1/...                          benchmark routes (packages/bench)
 *   POST /webhooks/github            GitHub webhooks (optional; polling is the default)
 *   GET  /evidence/:taskId/:file     evidence copied out of sandboxes, linked from PRs
 *   /v1/org..., /v1/events            org setup and inbound CloudEvents (org-api.ts)
 *   GET  /v1/openapi.json            OpenAPI 3.1 for /v1 (generated from the Zod contracts)
 *   POST /mcp                        the factory's MCP server (Streamable HTTP), same bearer token as /v1
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Signal, TaskId, TaskStatus, type RolloutState, type TaskRecord, type Team } from "@openfactory/contracts";
import type { AppStore, Ledger } from "@openfactory/ledger";
import type { EvidenceStore } from "@openfactory/task-job";
import { Hono } from "hono";
import type { z } from "zod";
import { ApproveTask, buildOpenApi, CancelTask, RetryTask, type HealthReport, EgressReport, FactoryApi, NewTaskRequest, PostMessage, SaveView, SetRollout, type FactoryInfo, type FactoryView } from "@openfactory/client";
import { createMcpHttpHandler } from "@openfactory/mcp";

const SAFE = /^[A-Za-z0-9._-]{1,200}$/;

export function fileEvidenceStore(dir: string, publicUrl: string): EvidenceStore & { read(taskId: string, name: string): Promise<{ bytes: Buffer; type: string } | null> } {
  return {
    async put(taskId, name, bytes, contentType) {
      if (!SAFE.test(taskId) || !SAFE.test(name)) throw new Error("bad evidence name");
      await mkdir(join(dir, taskId), { recursive: true });
      await writeFile(join(dir, taskId, name), bytes);
      await writeFile(join(dir, taskId, `${name}.type`), contentType);
      return { url: `${publicUrl.replace(/\/$/, "")}/evidence/${taskId}/${encodeURIComponent(name)}` };
    },
    async read(taskId, name) {
      if (!SAFE.test(taskId) || !SAFE.test(name) || name.endsWith(".type")) return null;
      try {
        const bytes = await readFile(join(dir, taskId, name));
        const type = await readFile(join(dir, taskId, `${name}.type`), "utf8").catch(() => "application/octet-stream");
        return { bytes, type };
      } catch {
        return null;
      }
    },
  };
}

export type AppDeps = {
  ledger: Ledger;
  onSignal: (s: Signal) => Promise<unknown>;
  evidence: ReturnType<typeof fileEvidenceStore>;
  apiToken: string | undefined;
  webhook: ((headers: { event: string | null; delivery: string | null; signature: string | null }, body: string) => Promise<Signal | null>) | null;
  bench: Hono | null;
  /** GET /v1/factory. */
  factory: () => Promise<z.infer<typeof FactoryInfo>>;
  /** POST /v1/tasks/:id/cancel; null when the task is unknown. */
  cancel: (taskId: TaskId, by: string, reason?: string) => Promise<TaskRecord | null>;
  /** POST /v1/tasks/:id/approve; null when the task is unknown, an Error when it has no open PR. */
  approve: (taskId: TaskId, by: string, note?: string) => Promise<TaskRecord | null>;
  /** POST /v1/tasks/:id/retry; null when the task is unknown. */
  retry: (taskId: TaskId, by: string) => Promise<TaskRecord | null>;
  /** GET /v1/health: the latest start-up checks. */
  health: () => Promise<HealthReport>;
  /** Public base URL, used in the OpenAPI document's `servers`. */
  publicUrl: string | null;
  log: (m: string, f?: object) => void;
  /** Saved views and rollouts. */
  store: AppStore;
  /** Teams from the org's directory. */
  teams: () => Promise<Team[]>;
  /** The org default and team factories. */
  factories: () => Promise<FactoryView[]>;
  /** Write to a task as a person; null when the task is unknown. */
  message: (taskId: TaskId, author: string, text: string) => Promise<{ task: TaskRecord; url: string | null } | null>;
  /** Ask for a new task from the app; throws a message for the person when it can't. */
  ask: (input: { ask: string; repo: string | null; requestedBy: string; origin?: { label: string; url: string | null } | null; labels?: string[] }) => Promise<{ issueUrl: string; repo: string; issueNumber: number }>;
  /** Org setup and inbound CloudEvents (org-api.ts), mounted under /v1. */
  org?: Hono | null;
};

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    // Another factory server runs this task's job right now (see TaskJobs leases): the caller can try again.
    if (err.name === "TaskBusy") return c.json({ code: "BUSY", message: err.message }, 409);
    d.log("http error", { path: c.req.path, error: String(err) });
    return c.json({ code: "INTERNAL", message: "internal error" }, 500);
  });
  app.get("/healthz", (c) => c.json({ ok: true }));

  const v1 = new Hono();
  const requireToken = async (c: { req: { header(n: string): string | undefined }; json(b: unknown, s: 401): Response }, next: () => Promise<void>) => {
    if (d.apiToken && c.req.header("authorization") !== `Bearer ${d.apiToken}`) return c.json({ code: "UNAUTHORIZED", message: "bearer token required" }, 401);
    await next();
  };
  v1.use("*", requireToken);
  const openapi = buildOpenApi({ serverUrl: d.publicUrl, version: "0.0.1" });
  v1.get("/openapi.json", (c) => c.json(openapi));
  v1.get("/tasks", async (c) => {
    const status = c.req.query("status");
    const limit = Number(c.req.query("limit") ?? 100);
    const parsed = status ? TaskStatus.safeParse(status) : null;
    if (parsed && !parsed.success) return c.json({ code: "INVALID_REQUEST", message: "unknown status" }, 400);
    return c.json({ tasks: await d.ledger.listTasks({ ...(parsed?.success ? { status: parsed.data } : {}), limit: Math.min(Math.max(limit, 1), 500) }) });
  });
  v1.get("/tasks/:id", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    const t = id.success ? await d.ledger.getTask(id.data) : null;
    return t ? c.json({ task: t }) : c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
  });
  v1.get("/tasks/:id/events", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
    return c.json({ events: await d.ledger.events(id.data) });
  });
  v1.get("/factory", async (c) => c.json({ factory: await d.factory() }));
  v1.post("/tasks/:id/cancel", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
    const body = CancelTask.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: "INVALID_REQUEST", message: "bad cancel request", issues: body.error.issues }, 400);
    const task = await d.cancel(id.data, body.data.by ?? "api", body.data.reason);
    return task ? c.json({ task }) : c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
  });
  v1.post("/tasks/:id/retry", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
    const body = RetryTask.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: "INVALID_REQUEST", message: "bad retry request", issues: body.error.issues }, 400);
    const task = await d.retry(id.data, body.data.by ?? "api");
    return task ? c.json({ task }) : c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
  });
  v1.post("/tasks/:id/approve", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
    const body = ApproveTask.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: "INVALID_REQUEST", message: "bad approval", issues: body.error.issues }, 400);
    try {
      const task = await d.approve(id.data, body.data.by, body.data.note);
      return task ? c.json({ task }) : c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
    } catch (e) {
      return c.json({ code: "NOT_REVIEWABLE", message: e instanceof Error ? e.message : String(e) }, 409);
    }
  });
  v1.get("/health", async (c) => c.json({ health: await d.health() }));
  v1.post("/signals", async (c) => {
    const s = Signal.safeParse(await c.req.json());
    if (!s.success) return c.json({ code: "INVALID_REQUEST", message: "not a Signal", issues: s.error.issues }, 400);
    return c.json({ result: await d.onSignal(s.data) }, 202);
  });
  /** The egress proxy's collector reports what each task's sandbox reached; denied hosts show on the task timeline. */
  v1.post("/egress", async (c) => {
    const body = EgressReport.safeParse(await c.req.json());
    if (!body.success) return c.json({ code: "INVALID_REQUEST", message: "bad egress report", issues: body.error.issues }, 400);
    let recorded = 0;
    for (const e of body.data.entries) {
      const id = TaskId.safeParse(e.taskId);
      if (!id.success || !(await d.ledger.getTask(id.data))) continue;
      const { taskId, ...data } = e;
      await d.ledger.append(id.data, "egress", data, { dedupeKey: `egress:${taskId}:${e.host}:${e.allowed}:${e.from}` });
      recorded++;
    }
    return c.json({ recorded }, 202);
  });
  v1.post("/tasks", async (c) => {
    const body = NewTaskRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: "INVALID_REQUEST", message: "bad task request", issues: body.error.issues }, 400);
    try {
      return c.json(await d.ask(body.data), 202);
    } catch (e) {
      return c.json({ code: "INVALID_REQUEST", message: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
  v1.post("/tasks/:id/messages", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
    const body = PostMessage.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: "INVALID_REQUEST", message: "bad message", issues: body.error.issues }, 400);
    const r = await d.message(id.data, body.data.author, body.data.text);
    return r ? c.json(r) : c.json({ code: "TASK_NOT_FOUND", message: "no such task" }, 404);
  });
  v1.get("/teams", async (c) => c.json({ teams: await d.teams() }));
  v1.get("/factories", async (c) => {
    const [factories, rollouts] = await Promise.all([d.factories(), d.store.listRollouts()]);
    return c.json({ factories, rollouts });
  });
  const knownFactory = async (slug: string) => (await d.factories()).some((f) => f.slug === slug);
  v1.get("/rollout/:factory", async (c) => {
    const slug = c.req.param("factory");
    if (!(await knownFactory(slug))) return c.json({ code: "FACTORY_NOT_FOUND", message: "no such factory" }, 404);
    const r = await d.store.rollout(slug);
    return c.json({ rollout: r?.state ?? null, history: r?.history ?? [] });
  });
  v1.post("/rollout/:factory", async (c) => {
    const slug = c.req.param("factory");
    if (!(await knownFactory(slug))) return c.json({ code: "FACTORY_NOT_FOUND", message: "no such factory" }, 404);
    const body = SetRollout.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: "INVALID_REQUEST", message: "bad rollout", issues: body.error.issues }, 400);
    const b = body.data;
    if (b.candidate === null && b.share > 0) return c.json({ code: "INVALID_REQUEST", message: "a share needs a candidate" }, 400);
    const state: Omit<RolloutState, "updatedAt"> = { factory: slug, live: b.live, candidate: b.candidate, share: b.candidate === null ? 0 : b.share, updatedBy: b.by, note: b.note };
    const rollout = await d.store.setRollout(state);
    d.log("rollout changed", { ...rollout });
    return c.json({ rollout });
  });
  v1.get("/views", async (c) => {
    const viewer = c.req.query("viewer");
    if (!viewer) return c.json({ code: "INVALID_REQUEST", message: "viewer is required" }, 400);
    const teams = (await d.teams()).filter((t) => t.members.some((m) => m.login.toLowerCase() === viewer.toLowerCase())).map((t) => t.slug);
    return c.json({ views: await d.store.listViews({ login: viewer, teams }) });
  });
  v1.get("/views/:id", async (c) => {
    const v = await d.store.getView(c.req.param("id"));
    return v ? c.json({ view: v }) : c.json({ code: "VIEW_NOT_FOUND", message: "no such view" }, 404);
  });
  v1.post("/views", async (c) => {
    const body = SaveView.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ code: "INVALID_REQUEST", message: "bad view", issues: body.error.issues }, 400);
    if (body.data.share === "team" && !body.data.team) return c.json({ code: "INVALID_REQUEST", message: "a team view needs a team" }, 400);
    const { id, ...rest } = body.data;
    return c.json({ view: await d.store.saveView(id ? { id, ...rest } : rest) });
  });
  v1.post("/views/:id/delete", async (c) => {
    const by = (await c.req.json().catch(() => ({}))) as { by?: unknown };
    if (typeof by.by !== "string" || by.by === "") return c.json({ code: "INVALID_REQUEST", message: "by is required" }, 400);
    return c.json({ deleted: await d.store.deleteView(c.req.param("id"), by.by) });
  });
  if (d.bench) v1.route("/", d.bench);
  if (d.org) v1.route("/", d.org);
  app.route("/v1", v1);

  // MCP tools call /v1 in-process with the same token, so they can never do more than the API allows.
  const self = new FactoryApi({ baseUrl: "http://in-process", token: d.apiToken ?? null, fetch: (input, init) => Promise.resolve(app.fetch(new Request(input, init))) });
  const mcp = createMcpHttpHandler(self, { version: "0.0.1" });
  app.use("/mcp", requireToken);
  app.all("/mcp", (c) => mcp(c.req.raw));

  if (d.webhook) {
    const parse = d.webhook;
    app.post("/webhooks/github", async (c) => {
      const body = await c.req.text();
      let s: Signal | null;
      try {
        s = await parse(
          { event: c.req.header("x-github-event") ?? null, delivery: c.req.header("x-github-delivery") ?? null, signature: c.req.header("x-hub-signature-256") ?? null },
          body,
        );
      } catch {
        return c.json({ code: "UNAUTHORIZED", message: "bad signature" }, 401);
      }
      if (s) void d.onSignal(s).catch((e) => d.log("webhook signal failed", { error: String(e) }));
      return c.json({ accepted: Boolean(s) }, 202);
    });
  }

  // Screenshots and test output are public so they render in PRs. Transcripts hold the agent's whole session
  // (code, prompts, tool output), so they need the API token.
  app.get("/evidence/:taskId/:file", async (c) => {
    const name = decodeURIComponent(c.req.param("file"));
    const isPrivate = name.startsWith("transcript-");
    if (isPrivate && d.apiToken && c.req.header("authorization") !== `Bearer ${d.apiToken}`)
      return c.json({ code: "UNAUTHORIZED", message: "bearer token required" }, 401);
    const f = await d.evidence.read(c.req.param("taskId"), name);
    if (!f) return c.notFound();
    const cache = isPrivate ? "private, no-store" : "public, max-age=86400";
    return new Response(new Uint8Array(f.bytes), { headers: { "content-type": f.type, "cache-control": cache, "x-content-type-options": "nosniff" } });
  });
  return app;
}
