import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { TaskId, type LedgerEvent, type TaskRecord } from "@openfactory/contracts";
import { FactoryApiError, type FactoryApi, type FactoryInfo } from "@openfactory/client";
import type { Child } from "hono/jsx";
import { dailySeries, filterTasks, inbox, insights, isOpen, parseFilter, summarizeScorers, taskFacts, type TaskFacts } from "./insights.js";
import { Shell, type Nav } from "./ui.js";
import { ActivityPage, AgentPage, AgentsPage, AppsPage, AutomationsPage, BenchPage, DashboardPage, EnvironmentsPage, ErrorPage, parseTranscript, RunsPage, ScorersPage, SecretsPage, TaskPage, TranscriptPage, VersionsPage, type Stage } from "./views.js";

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
 * The factory dashboard: runs, activity, cost and outcomes, agents, scorers and benchmarks.
 * Server-rendered; every read and write goes through the factory server's API.
 * Basic auth protects the whole page when a password is set.
 */
export function createDashboard(
  api: FactoryApi,
  opts: { password: string | null; models: [string, string]; now?: () => string; factoryName?: string; mcpUrl?: string | null },
): Hono {
  const app = new Hono();
  const cache = new EventCache(api);
  const now = opts.now ?? (() => new Date().toISOString());
  const LIMIT = 500;
  const loadAll = async () => {
    const tasks = await api.listTasks({ limit: LIMIT });
    return { tasks, facts: await cache.facts(tasks) };
  };
  // The factory's config changes only on deploy; refetch at most once a minute and never fail a page on it.
  let info: { at: number; f: FactoryInfo | null } = { at: 0, f: null };
  const factory = async (): Promise<FactoryInfo | null> => {
    if (Date.now() - info.at > 60_000) {
      try {
        info = { at: Date.now(), f: await api.factory() };
      } catch {
        info = { at: Date.now() - 50_000, f: info.f };
      }
    }
    return info.f;
  };
  const requireFactory = async () => {
    const f = await factory();
    if (f === null) throw new FactoryApiError(502, "The factory server did not return its configuration.");
    return f;
  };
  const name = opts.factoryName ?? "main";
  const page = async (c: { req: { query(k: string): string | undefined } }, p: { title: string; nav: Nav; inboxCount?: number; refreshSec?: number | undefined; flash?: string | null }, body: Child) => {
    const f = await factory();
    return (
      <Shell title={p.title} nav={p.nav} flash={p.flash === undefined ? (c.req.query("msg") ?? null) : p.flash} inboxCount={p.inboxCount} refreshSec={p.refreshSec} factory={{ name, version: f?.version ?? "" }}>
        {body}
      </Shell>
    );
  };
  const inboxCount = (facts: TaskFacts[]) => inbox(facts, now()).length;
  const days = (q: string | undefined) => ([7, 30, 90].includes(Number(q)) ? Number(q) : 30);

  app.get("/healthz", (c) => c.json({ ok: true }));
  const fontPath = createRequire(import.meta.url).resolve("@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2");
  let font: Buffer | null = null;
  app.get("/assets/mona-sans.woff2", async (c) => {
    font ??= await readFile(fontPath);
    return c.body(new Uint8Array(font), 200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" });
  });
  if (opts.password !== null) app.use("*", basicAuth({ username: "factory", password: opts.password }));

  app.onError(async (err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const msg = err instanceof FactoryApiError ? err.message : err instanceof z.ZodError ? "The factory server returned data in an unexpected shape." : "Unexpected error.";
    if (!(err instanceof FactoryApiError)) console.error("dashboard:", err);
    return c.html(<Shell title="Error" nav="dashboard" flash={null} factory={{ name, version: info.f?.version ?? "" }}><ErrorPage message={msg} /></Shell>, 502);
  });

  app.get("/", async (c) => {
    const { facts } = await loadAll();
    const d = days(c.req.query("days"));
    return c.html(await page(c, { title: "Dashboard", nav: "dashboard", inboxCount: inboxCount(facts) }, <DashboardPage i={insights(facts, now(), d)} days={dailySeries(facts, now(), d)} now={now()} />));
  });
  app.get("/metrics", (c) => c.redirect(`/${c.req.query("days") ? `?days=${c.req.query("days")}` : ""}`, 301));

  app.get("/activity", async (c) => {
    const { facts } = await loadAll();
    const items = inbox(facts, now());
    const q = c.req.query("stage");
    const stage: Stage = q === "needs_you" || q === "working" || q === "review" || q === "merged" || q === "ended" ? q : "all";
    const live = facts.some((f) => isOpen(f.task.status) && f.task.status !== "awaiting_review");
    return c.html(await page(c, { title: "Activity", nav: "activity", inboxCount: items.length, refreshSec: live ? 20 : undefined }, <ActivityPage items={items} facts={facts} now={now()} stage={stage} />));
  });

  app.get("/runs", async (c) => {
    const { tasks, facts } = await loadAll();
    const filter = parseFilter((k) => c.req.query(k));
    const live = c.req.query("live") === "1";
    const nav: Nav = c.req.query("scope") === "factory" ? "factory-runs" : "runs";
    return c.html(
      await page(c, { title: "Runs", nav, inboxCount: inboxCount(facts), refreshSec: live ? 15 : undefined },
        <RunsPage tasks={filterTasks(tasks, filter)} all={tasks} filter={filter} facts={new Map(facts.map((f) => [f.task.id, f]))} now={now()} live={live} />),
    );
  });

  app.get("/scorers", async (c) => {
    const { facts } = await loadAll();
    return c.html(await page(c, { title: "Scorers", nav: "scorers", inboxCount: inboxCount(facts) }, <ScorersPage scorers={summarizeScorers(facts.map((f) => f.task))} />));
  });

  app.get("/versions", async (c) => {
    const { tasks, facts } = await loadAll();
    return c.html(await page(c, { title: "Versions", nav: "versions", inboxCount: inboxCount(facts) }, <VersionsPage tasks={tasks} />));
  });

  app.get("/agents", async (c) => c.html(await page(c, { title: "Agents", nav: "agents" }, <AgentsPage f={await requireFactory()} />)));
  app.get("/agents/:role", async (c) => {
    const role = c.req.param("role");
    if (role !== "implementation" && role !== "foreman") return c.html(await page(c, { title: "Not found", nav: "agents", flash: null }, <ErrorPage message="No such agent." />), 404);
    return c.html(await page(c, { title: role, nav: "agents" }, <AgentPage f={await requireFactory()} role={role} prompt={c.req.query("prompt") ?? "system"} mcpUrl={opts.mcpUrl ?? null} />));
  });
  app.get("/automations", async (c) => c.html(await page(c, { title: "Automations", nav: "automations" }, <AutomationsPage f={await requireFactory()} />)));
  app.get("/apps", async (c) => c.html(await page(c, { title: "MCPs and apps", nav: "apps" }, <AppsPage f={await requireFactory()} mcpUrl={opts.mcpUrl ?? null} />)));
  app.get("/secrets", async (c) => c.html(await page(c, { title: "Secrets", nav: "secrets" }, <SecretsPage f={await requireFactory()} />)));
  app.get("/environments", async (c) => {
    const [f, tasks] = await Promise.all([requireFactory(), api.listTasks({ limit: LIMIT })]);
    return c.html(await page(c, { title: "Environments", nav: "environments" }, <EnvironmentsPage f={f} active={tasks.filter((t) => isOpen(t.status) && t.environment !== null)} />));
  });
  app.get("/factory", (c) => c.redirect("/agents", 301));

  app.get("/tasks/:id", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    const t = id.success ? await api.getTask(id.data) : null;
    if (!id.success || t === null) return c.html(await page(c, { title: "Not found", nav: "runs", flash: null }, <ErrorPage message="No such task." />), 404);
    const events = await cache.events(t);
    const live = isOpen(t.status) && t.status !== "awaiting_review";
    return c.html(await page(c, { title: t.title, nav: "runs", refreshSec: live ? 15 : undefined }, <TaskPage t={t} events={events} facts={taskFacts(t, events)} now={now()} />));
  });

  app.get("/tasks/:id/transcripts/:key", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    const key = c.req.param("key");
    const t = id.success ? await api.getTask(id.data) : null;
    const body = t !== null && /^transcript-\d+\.jsonl$/.test(key) ? await api.transcript(t.id, key) : null;
    if (t === null || body === null) return c.html(await page(c, { title: "Not found", nav: "runs", flash: null }, <ErrorPage message="No such transcript." />), 404);
    const turn = Number(/^transcript-(\d+)/.exec(key)?.[1] ?? NaN);
    return c.html(await page(c, { title: `Session · ${t.title}`, nav: "runs", flash: null }, <TranscriptPage t={t} turn={Number.isFinite(turn) ? turn : null} lines={parseTranscript(body)} />));
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
    return c.html(await page(c, { title: "Benchmarks", nav: "bench" }, <BenchPage tasks={tasks} runs={runs} versions={versions} models={opts.models} />));
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
