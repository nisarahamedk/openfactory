import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { TaskId } from "@openfactory/contracts";
import { FactoryApiError, type FactoryApi } from "./api.js";
import { BenchPage, ErrorPage, Layout, TaskPage, TasksPage, VersionsPage } from "./views.js";

/**
 * The factory page: tasks, cost, scores, factory versions and benchmarks.
 * Server-rendered; every read and write goes through the factory server's API.
 * Basic auth protects the whole page when a password is set.
 */
export function createDashboard(api: FactoryApi, opts: { password: string | null; models: [string, string] }): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  if (opts.password !== null) app.use("*", basicAuth({ username: "factory", password: opts.password }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const msg = err instanceof FactoryApiError ? err.message : err instanceof z.ZodError ? "The factory server returned data in an unexpected shape." : "Unexpected error.";
    if (!(err instanceof FactoryApiError)) console.error("dashboard:", err);
    return c.html(<Layout title="Error" nav="tasks" flash={null}><ErrorPage message={msg} /></Layout>, 502);
  });

  const flash = (c: { req: { query(k: string): string | undefined } }) => c.req.query("msg") ?? null;

  app.get("/", async (c) => {
    const tasks = await api.listTasks({ limit: 200 });
    return c.html(<Layout title="Tasks" nav="tasks" flash={flash(c)}><TasksPage tasks={tasks} /></Layout>);
  });

  app.get("/versions", async (c) => {
    const tasks = await api.listTasks({ limit: 500 });
    return c.html(<Layout title="Factory versions" nav="versions" flash={flash(c)}><VersionsPage tasks={tasks} /></Layout>);
  });

  app.get("/tasks/:id", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    const t = id.success ? await api.getTask(id.data) : null;
    if (!id.success || t === null) return c.html(<Layout title="Not found" nav="tasks" flash={null}><ErrorPage message="No such task." /></Layout>, 404);
    const events = await api.events(id.data);
    return c.html(<Layout title={t.title} nav="tasks" flash={flash(c)}><TaskPage t={t} events={events} /></Layout>);
  });

  app.post("/tasks/:id/benchmark", async (c) => {
    const id = TaskId.parse(c.req.param("id"));
    try {
      const b = await api.addToBenchmark(id);
      return c.redirect(`/bench?msg=${encodeURIComponent(`Added ${b.id} to the benchmark.`)}`, 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500)
        return c.redirect(`/tasks/${id}?msg=${encodeURIComponent(`Couldn't add to benchmark: ${err.message}`)}`, 303);
      throw err;
    }
  });

  app.get("/bench", async (c) => {
    const [tasks, runs, all] = await Promise.all([api.benchTasks(), api.benchRuns(), api.listTasks({ limit: 500 })]);
    const versions = [...new Set(all.map((t) => t.factoryVersion))];
    return c.html(<Layout title="Benchmarks" nav="bench" flash={flash(c)}><BenchPage tasks={tasks} runs={runs} versions={versions} models={opts.models} /></Layout>);
  });

  app.post("/bench/runs", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const str = (k: string) => {
      const v = form[k];
      return typeof v === "string" ? v.trim() : "";
    };
    const raw = form.taskIds;
    const taskIds = (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string");
    try {
      const run = await api.startBenchRun({
        taskIds,
        arms: [
          { label: "A", model: str("modelA"), factoryVersion: str("versionA"), systemPrompt: str("promptA") },
          { label: "B", model: str("modelB"), factoryVersion: str("versionB"), systemPrompt: str("promptB") },
        ],
        repeats: Number(str("repeats")),
        maxCostUsd: Number(str("maxCostUsd")),
      });
      return c.redirect(`/bench?msg=${encodeURIComponent(`Started ${run.id}. Refresh to see results as they land.`)}`, 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500)
        return c.redirect(`/bench?msg=${encodeURIComponent(`Couldn't start the run: ${err.message}`)}`, 303);
      throw err;
    }
  });

  return app;
}
