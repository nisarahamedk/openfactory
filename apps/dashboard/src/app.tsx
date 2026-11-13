import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { TaskId, type LedgerEvent, type TaskRecord } from "@openfactory/contracts";
import { FactoryApiError, type FactoryApi } from "@openfactory/client";
import { filterTasks, inbox, insights, isOpen, parseFilter, summarizeScorers, taskFacts, type TaskFacts } from "./insights.js";
import { BenchPage, ErrorPage, FactoryPage, HomePage, Layout, MetricsPage, parseTranscript, RunsPage, ScorersPage, TaskPage, TranscriptPage, VersionsPage } from "./views.js";

/**
 * Event logs per task, refetched only when the task's updatedAt moves. Terminal tasks
 * stop changing, so after the first page load most reads are cache hits.
 */
export class EventCache {
  private readonly cache = new Map<string, { updatedAt: string; events: LedgerEvent[] }>();
  constructor(private readonly api: FactoryApi, private readonly concurrency = 8) {}

  async facts(tasks: readonly TaskRecord[]): Promise<TaskFacts[]> {
    const out: TaskFacts[] = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const i = next++;
        const t = tasks[i]!;
        out[i] = taskFacts(t, await this.events(t));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, tasks.length) }, worker));
    return out;
  }

  async events(t: TaskRecord): Promise<LedgerEvent[]> {
    const hit = this.cache.get(t.id);
    if (hit && hit.updatedAt === t.updatedAt) return hit.events;
    const events = await this.api.events(t.id);
    this.cache.set(t.id, { updatedAt: t.updatedAt, events });
    return events;
  }
}

/**
 * The factory page: tasks, cost, scores, factory versions and benchmarks.
 * Server-rendered; every read and write goes through the factory server's API.
 * Basic auth protects the whole page when a password is set.
 */
export function createDashboard(api: FactoryApi, opts: { password: string | null; models: [string, string]; now?: () => string }): Hono {
  const app = new Hono();
  const cache = new EventCache(api);
  const now = opts.now ?? (() => new Date().toISOString());
  const LIMIT = 500;
  const loadAll = async () => {
    const tasks = await api.listTasks({ limit: LIMIT });
    return { tasks, facts: await cache.facts(tasks) };
  };
  const inboxCount = (facts: TaskFacts[]) => inbox(facts, now()).length;
  app.get("/healthz", (c) => c.json({ ok: true }));
  if (opts.password !== null) app.use("*", basicAuth({ username: "factory", password: opts.password }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const msg = err instanceof FactoryApiError ? err.message : err instanceof z.ZodError ? "The factory server returned data in an unexpected shape." : "Unexpected error.";
    if (!(err instanceof FactoryApiError)) console.error("dashboard:", err);
    return c.html(<Layout title="Error" nav="home" flash={null}><ErrorPage message={msg} /></Layout>, 502);
  });

  const flash = (c: { req: { query(k: string): string | undefined } }) => c.req.query("msg") ?? null;

  app.get("/", async (c) => {
    const { facts } = await loadAll();
    const items = inbox(facts, now());
    const live = facts.filter((f) => isOpen(f.task.status) && f.task.status !== "awaiting_review");
    return c.html(
      <Layout title="Home" nav="home" flash={flash(c)} inboxCount={items.length} refreshSec={live.length > 0 ? 20 : undefined}>
        <HomePage items={items} live={live} now={now()} i={insights(facts, now(), 7)} />
      </Layout>,
    );
  });

  app.get("/runs", async (c) => {
    const { tasks, facts } = await loadAll();
    const filter = parseFilter((k) => c.req.query(k));
    const live = c.req.query("live") === "1";
    return c.html(
      <Layout title="Runs" nav="runs" flash={flash(c)} inboxCount={inboxCount(facts)} refreshSec={live ? 15 : undefined}>
        <RunsPage tasks={filterTasks(tasks, filter)} all={tasks} filter={filter} facts={new Map(facts.map((f) => [f.task.id, f]))} now={now()} live={live} />
      </Layout>,
    );
  });

  app.get("/metrics", async (c) => {
    const days = [7, 30, 90].includes(Number(c.req.query("days"))) ? Number(c.req.query("days")) : 30;
    const { facts } = await loadAll();
    return c.html(<Layout title="Dashboard" nav="metrics" flash={flash(c)} inboxCount={inboxCount(facts)}><MetricsPage i={insights(facts, now(), days)} /></Layout>);
  });

  app.get("/scorers", async (c) => {
    const tasks = await api.listTasks({ limit: LIMIT });
    return c.html(<Layout title="Scorers" nav="scorers" flash={flash(c)}><ScorersPage scorers={summarizeScorers(tasks)} /></Layout>);
  });

  app.get("/versions", async (c) => {
    const tasks = await api.listTasks({ limit: LIMIT });
    return c.html(<Layout title="Factory versions" nav="versions" flash={flash(c)}><VersionsPage tasks={tasks} /></Layout>);
  });

  app.get("/tasks/:id", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    const t = id.success ? await api.getTask(id.data) : null;
    if (!id.success || t === null) return c.html(<Layout title="Not found" nav="runs" flash={null}><ErrorPage message="No such task." /></Layout>, 404);
    const events = await cache.events(t);
    const live = isOpen(t.status) && t.status !== "awaiting_review";
    return c.html(
      <Layout title={t.title} nav="runs" flash={flash(c)} refreshSec={live ? 15 : undefined}>
        <TaskPage t={t} events={events} facts={taskFacts(t, events)} now={now()} />
      </Layout>,
    );
  });

  app.get("/tasks/:id/transcripts/:key", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    const key = c.req.param("key");
    const t = id.success ? await api.getTask(id.data) : null;
    const body = t !== null && /^transcript-\d+\.jsonl$/.test(key) ? await api.transcript(t.id, key) : null;
    if (t === null || body === null) return c.html(<Layout title="Not found" nav="runs" flash={null}><ErrorPage message="No such transcript." /></Layout>, 404);
    const turn = Number(/^transcript-(\d+)/.exec(key)?.[1] ?? NaN);
    return c.html(<Layout title={`Session · ${t.title}`} nav="runs" flash={null}><TranscriptPage t={t} turn={Number.isFinite(turn) ? turn : null} lines={parseTranscript(body)} /></Layout>);
  });

  app.post("/tasks/:id/cancel", async (c) => {
    const id = TaskId.parse(c.req.param("id"));
    const form = await c.req.parseBody();
    const reason = typeof form.reason === "string" && form.reason.trim() !== "" ? form.reason.trim().slice(0, 1000) : undefined;
    try {
      await api.cancel(id, { by: "dashboard", ...(reason ? { reason } : {}) });
      return c.redirect(`/tasks/${id}?msg=${encodeURIComponent("Stopped. The environment is asleep; comment on the issue or PR to resume.")}`, 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500)
        return c.redirect(`/tasks/${id}?msg=${encodeURIComponent(`Couldn't stop: ${err.message}`)}`, 303);
      throw err;
    }
  });

  app.get("/factory", async (c) => {
    const f = await api.factory();
    return c.html(<Layout title="Factory" nav="factory" flash={flash(c)}><FactoryPage f={f} /></Layout>);
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
