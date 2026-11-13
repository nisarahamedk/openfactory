/**
 * HTTP surface of the factory server:
 *   GET  /healthz
 *   GET  /v1/tasks[?status=&limit=]  GET /v1/tasks/:id  GET /v1/tasks/:id/events
 *   POST /v1/signals                 inject a contract Signal (tests, CLI, other tools)
 *   /v1/...                          benchmark routes (packages/bench)
 *   POST /webhooks/github            GitHub webhooks (optional; polling is the default)
 *   GET  /evidence/:taskId/:file     evidence copied out of sandboxes, linked from PRs
 *   GET  /v1/openapi.json            OpenAPI 3.1 for /v1 (generated from the Zod contracts)
 *   POST /mcp                        the factory's MCP server (Streamable HTTP), same bearer token as /v1
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Signal, TaskId, TaskStatus } from "@openfactory/contracts";
import type { Ledger } from "@openfactory/ledger";
import type { EvidenceStore } from "@openfactory/task-job";
import { Hono } from "hono";
import { buildOpenApi, EgressReport, FactoryApi } from "@openfactory/client";
import { createMcpHttpHandler } from "@openfactory/mcp";
import { z } from "zod";


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
  /** Public base URL, used in the OpenAPI document's `servers`. */
  publicUrl: string | null;
  log: (m: string, f?: object) => void;
};

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  app.onError((err, c) => {
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
      if (!(await d.ledger.getTask(e.taskId))) continue;
      const { taskId, ...data } = e;
      await d.ledger.append(taskId, "egress", data, { dedupeKey: `egress:${taskId}:${e.host}:${e.allowed}:${e.from}` });
      recorded++;
    }
    return c.json({ recorded }, 202);
  });
  if (d.bench) v1.route("/", d.bench);
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

  app.get("/evidence/:taskId/:file", async (c) => {
    const f = await d.evidence.read(c.req.param("taskId"), decodeURIComponent(c.req.param("file")));
    if (!f) return c.notFound();
    return new Response(new Uint8Array(f.bytes), { headers: { "content-type": f.type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" } });
  });
  return app;
}
