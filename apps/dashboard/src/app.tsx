import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { ROLE_RANK, type Auth, type Role, type Session } from "./auth.js";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { factoryFor, TaskId, teamFor, ViewShare, type LedgerEvent, type SavedView, type Team, type TaskRecord } from "@openfactory/contracts";
import { FactoryApiError, type FactoryApi, type FactoryInfo, type HealthReport } from "@openfactory/client";
import type { Child } from "hono/jsx";
import { dailySeries, inbox, insights, isOpen, taskFacts, type TaskFacts } from "./insights.js";
import { explore, filterQuery, matches, parseFilters, people, scopeParam, type Filters, type Scope } from "./model.js";
import {
  FactoriesPage,
  FactoryPage,
  FactoryTabs,
  ImprovePage,
  InboxPage,
  InsightsPage,
  NewTaskPage,
  PersonPage,
  SaveViewForm,
  ScopeBar,
  scopeOptions,
  ScorersInScope,
  ProviderSigninPage,
  SigninPage,
  TasksPage,
  TeamPage,
  TeamsPage,
  versionRows,
} from "./pages.js";
import { HealthAlert, Shell, type Nav } from "./ui.js";
import { homeFor, PeoplePage, SetupPage, SourcesPage } from "./org.js";
import { teamSuites } from "./mix.js";
import { TeamSuites, VersionDefs } from "./suites.js";
import type { OrgState, Persona } from "@openfactory/contracts";
import { AgentPage, AgentsPage, AppsPage, AutomationsPage, BenchPage, DashboardPage, EnvironmentsPage, ErrorPage, parseTranscript, SecretsPage, TaskPage, TranscriptPage } from "./views.js";

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

/** Refetch at most every `ttlMs`; on failure keep the last value (or the fallback). Never fails a page. */
function cached<T>(load: () => Promise<T>, fallback: T, ttlMs = 60_000) {
  let hit: { at: number; v: T } | null = null;
  return async (): Promise<T> => {
    if (hit && Date.now() - hit.at < ttlMs) return hit.v;
    try {
      hit = { at: Date.now(), v: await load() };
    } catch {
      hit = { at: Date.now() - ttlMs + 10_000, v: hit?.v ?? fallback };
    }
    return hit.v;
  };
}

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const SESSION_COOKIE = "of_session";
const STATE_COOKIE = "of_auth";
const pathAndQuery = (c: Context) => {
  const u = new URL(c.req.url);
  return `${u.pathname}${u.search}`;
};
/** The least role each form post needs. Viewers save views; engineers work tasks; admins change factories and spend. */
function roleFor(path: string): Role {
  if (path === "/signout" || path === "/views" || /^\/views\/[^/]+\/delete$/.test(path)) return "viewer";
  if (/^\/factories\/[^/]+\/rollout$/.test(path) || path === "/bench/runs" || path.startsWith("/setup/")) return "admin";
  return "engineer";
}
const msg = (path: string, m: string) => `${path}${path.includes("?") ? "&" : "?"}msg=${encodeURIComponent(m)}`;
/** Only same-app paths are followed after a form post. */
const safePath = (p: unknown, fallback = "/") => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? p : fallback);

/**
 * The factory app: inbox, tasks, Insights, teams and people, factories and their versions,
 * benchmarks and scorers, all around one scope (org › team › person) and one set of filters.
 * Server-rendered; every read and write goes through the factory server's API.
 * Basic auth protects the whole app when a password is set; the viewer picks who they are on /signin.
 */
export function createDashboard(
  api: FactoryApi,
  opts: { password: string | null; models: [string, string]; now?: () => string; factoryName?: string; mcpUrl?: string | null; auth?: Auth | null; publicApiUrl?: string | null },
): Hono {
  const auth = opts.auth ?? null;
  const app = new Hono();
  const cache = new EventCache(api);
  const now = opts.now ?? (() => new Date().toISOString());
  const LIMIT = 500;
  const loadAll = async () => {
    const tasks = await api.listTasks({ limit: LIMIT });
    return { tasks, facts: await cache.facts(tasks) };
  };
  const factory = cached<FactoryInfo | null>(() => api.factory(), null);
  const teamsOf = cached<Team[]>(() => api.teams(), [], 30_000);
  const healthOf = cached<HealthReport | null>(() => api.health(), null, 30_000);
  /** The org as set up in the app; null on a server without org setup. Busted after every setup write. */
  const loadOrg = () => cached<OrgState | null>(() => api.org(), null, 15_000);
  let orgOf = loadOrg();
  type Factories = Awaited<ReturnType<FactoryApi["factories"]>>;
  const loadFactories = () => cached<Factories>(() => api.factories(), { factories: [], rollouts: [] }, 10_000);
  let factoriesOf = loadFactories();
  /** Rollout changes show at once: start a fresh cache after a write. */
  const factoriesCacheBust = () => {
    factoriesOf = loadFactories();
  };
  const requireFactory = async () => {
    const f = await factory();
    if (f === null) throw new FactoryApiError(502, "The factory server did not return its configuration.");
    return f;
  };
  const name = opts.factoryName ?? "main";
  /** Who is using the app: the signed-in person with a provider, else the name picked on /signin (dev fallback). */
  const sessionOf = (c: Context): Session | null => (auth ? auth.session(getCookie(c, SESSION_COOKIE)) : null);
  const viewerOf = (c: Context) => {
    if (auth) return sessionOf(c)?.login ?? null;
    const v = getCookie(c, "of_user");
    return v && LOGIN.test(v) ? v : null;
  };

  type PageOpts = { title: string; nav: Nav; inboxCount?: number; refreshSec?: number | undefined; flash?: string | null; scope?: Child };
  const page = async (c: Context, p: PageOpts, body: Child) => {
    const [f, h, o] = await Promise.all([factory(), healthOf(), orgOf()]);
    const left = o ? o.setup.filter((x) => !x.done).length : 0;
    return (
      <Shell setupLeft={left || undefined} simulated={o?.org?.simulated ? o.org.name : null} title={p.title} nav={p.nav} flash={p.flash === undefined ? (c.req.query("msg") ?? null) : p.flash} inboxCount={p.inboxCount} refreshSec={p.refreshSec} factory={{ name, version: f?.version ?? "" }} viewer={viewerOf(c)} scope={p.scope}>
        {h && !h.ok ? <HealthAlert health={h} /> : null}
        {body}
      </Shell>
    );
  };

  /** Everything a scoped page needs: filters from the query, tasks in scope, the scope bar. */
  const scoped = async (c: Context, base: string, fallback?: Scope) => {
    const viewer = viewerOf(c);
    const f = parseFilters((k) => c.req.query(k), fallback ?? { kind: "org" });
    const [{ tasks, facts }, teams] = await Promise.all([loadAll(), teamsOf()]);
    const n = now();
    const inScope = facts.filter((x) => matches(x, f, teams, n));
    const bar = (extra?: Child) => <ScopeBar f={f} teams={teams} viewer={viewer} base={base} opts={scopeOptions(facts)} extra={extra} />;
    const mineInbox = viewer ? inbox(facts.filter((x) => x.task.requestedBy === viewer), n).length : inbox(facts, n).length;
    return { viewer, f, tasks, facts, inScope, teams, n, bar, inboxCount: mineInbox };
  };
  const pathOf = (c: Context) => {
    const u = new URL(c.req.url);
    u.searchParams.delete("msg");
    u.searchParams.delete("view");
    return `${u.pathname}${u.search}`;
  };
  const viewFor = async (c: Context): Promise<SavedView | null> => {
    const id = c.req.query("view");
    return id ? await api.view(id).catch(() => null) : null;
  };

  app.get("/healthz", (c) => c.json({ ok: true }));
  const fontPath = createRequire(import.meta.url).resolve("@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2");
  let font: Buffer | null = null;
  app.get("/assets/mona-sans.woff2", async (c) => {
    font ??= await readFile(fontPath);
    return c.body(new Uint8Array(font), 200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" });
  });
  if (auth) {
    // Signed-in only: everything but sign-in itself, health and the font needs a session.
    app.use("*", async (c, next) => {
      const path = c.req.path;
      if (path === "/signin" || path.startsWith("/auth/") || path === "/healthz" || path.startsWith("/assets/")) return next();
      const s = sessionOf(c);
      if (!s) {
        if (c.req.method === "GET") return c.redirect(`/signin?back=${encodeURIComponent(pathAndQuery(c))}`, 303);
        return c.text("Sign in first.", 401);
      }
      if (c.req.method === "POST") {
        // Forms only from this app (the session cookie is SameSite=Lax too).
        const origin = c.req.header("origin");
        if (origin && origin !== auth.origin) return c.text("Cross-site request refused.", 403);
        const need = roleFor(path);
        if (ROLE_RANK[s.role] < ROLE_RANK[need]) return c.redirect(msg(safePath(c.req.header("referer") ? new URL(c.req.header("referer")!).pathname : "/"), `That needs the ${need} role; you are ${s.role === "viewer" ? "a viewer" : `an ${s.role}`}. Ask a factory admin.`), 303);
      }
      return next();
    });
  } else if (opts.password !== null) app.use("*", basicAuth({ username: "factory", password: opts.password }));

  app.onError(async (err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    const m = err instanceof FactoryApiError ? err.message : err instanceof z.ZodError ? "The factory server returned data in an unexpected shape." : "Unexpected error.";
    if (!(err instanceof FactoryApiError)) console.error("dashboard:", err);
    return c.html(<Shell title="Error" nav="none" flash={null} factory={{ name, version: "" }} viewer={viewerOf(c)}><ErrorPage message={m} /></Shell>, 502);
  });

  // ── identity ──
  app.get("/signin", async (c) => {
    if (auth) {
      const back = safePath(c.req.query("back"));
      if (sessionOf(c)) return c.redirect(back, 303);
      return c.html(<Shell title="Sign in" nav="none" flash={c.req.query("msg") ?? null} factory={{ name, version: "" }} viewer={null}><ProviderSigninPage provider={auth.cfg.provider} back={back} /></Shell>);
    }
    const [{ facts }, teams] = await Promise.all([loadAll(), teamsOf()]);
    return c.html(await page(c, { title: "Sign in", nav: "none" }, <SigninPage people={people(facts, teams, { kind: "org" })} viewer={viewerOf(c)} back={safePath(c.req.query("back"))} />));
  });
  app.get("/auth/start", async (c) => {
    if (!auth) return c.notFound();
    const { url, state } = await auth.start(safePath(c.req.query("back")));
    setCookie(c, STATE_COOKIE, state, { path: "/auth", httpOnly: true, secure: auth.origin.startsWith("https:"), sameSite: "Lax", maxAge: 600 });
    return c.redirect(url, 302);
  });
  app.get("/auth/callback", async (c) => {
    if (!auth) return c.notFound();
    try {
      const { session, back } = await auth.finish({ code: c.req.query("code"), state: c.req.query("state"), cookie: getCookie(c, STATE_COOKIE) });
      deleteCookie(c, STATE_COOKIE, { path: "/auth" });
      setCookie(c, SESSION_COOKIE, auth.sign(session), { path: "/", httpOnly: true, secure: auth.origin.startsWith("https:"), sameSite: "Lax", maxAge: Math.floor((session.exp - Date.now()) / 1000) });
      return c.redirect(safePath(back), 303);
    } catch (e) {
      return c.redirect(msg("/signin", e instanceof Error ? e.message : "Sign-in failed."), 303);
    }
  });
  app.post("/signout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    deleteCookie(c, "of_user", { path: "/" });
    return c.redirect("/signin", 303);
  });

  app.post("/signin", async (c) => {
    if (auth) return c.redirect("/signin", 303);
    const form = await c.req.parseBody();
    const login = typeof form.login === "string" ? form.login.trim() : "";
    if (!LOGIN.test(login)) return c.redirect(msg("/signin", "That doesn't look like a login."), 303);
    setCookie(c, "of_user", login, { path: "/", httpOnly: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
    const back = safePath(form.back);
    if (back !== "/") return c.redirect(back, 303);
    // Each persona lands on the page that answers their first question.
    const [o, teams] = await Promise.all([orgOf(), teamsOf()]);
    const persona = (o?.people.find((p) => p.login.toLowerCase() === login.toLowerCase())?.persona ?? null) as Persona | null;
    return c.redirect(homeFor(persona, teams, login), 303);
  });

  // ── inbox ──
  app.get("/", async (c) => {
    const viewer = viewerOf(c);
    const s = await scoped(c, "/", viewer ? { kind: "person", login: viewer } : { kind: "org" });
    // The inbox ignores the period: anything still waiting on a person shows, however old.
    const items = s.facts.filter((x) => matches(x, { ...s.f, days: 0 }, s.teams, s.n));
    const live = items.some((x) => isOpen(x.task.status) && x.task.status !== "awaiting_review");
    // A person also reviews for their team: teammates' PRs waiting on a reviewer.
    const scope = s.f.scope;
    const teamReviews =
      scope.kind === "person"
        ? s.facts.filter((x) => x.task.status === "awaiting_review" && x.task.requestedBy !== scope.login && s.teams.some((t) => t.members.some((m) => m.login === scope.login) && t.members.some((m) => m.login === x.task.requestedBy)))
        : [];
    return c.html(await page(c, { title: "Inbox", nav: "inbox", inboxCount: s.inboxCount, refreshSec: live ? 20 : undefined, scope: s.bar() }, <InboxPage facts={items} now={s.n} viewer={viewer} scope={scope} teamReviews={teamReviews} />));
  });
  app.get("/activity", (c) => c.redirect("/", 301));

  // ── tasks ──
  app.get("/tasks", async (c) => {
    const s = await scoped(c, "/tasks");
    const current = await viewFor(c);
    const save = <SaveViewForm path={pathOf(c)} viewer={s.viewer} teams={s.teams} current={current && current.owner === s.viewer ? current : null} />;
    const title = current ? current.name : "Tasks";
    return c.html(await page(c, { title, nav: "tasks", inboxCount: s.inboxCount, scope: s.bar() }, <TasksPage facts={s.inScope} f={s.f} now={s.n} saveForm={save} total={s.facts.length} />));
  });
  app.get("/runs", (c) => c.redirect(`/tasks${c.req.query("q") ? `?q=${encodeURIComponent(c.req.query("q")!)}` : ""}`, 301));

  app.get("/tasks/new", async (c) => {
    const teams = await teamsOf();
    const viewer = viewerOf(c);
    const mine = teams.filter((t) => t.members.some((m) => m.login === viewer)).flatMap((t) => t.repos);
    const repos = [...new Set([...mine, ...teams.flatMap((t) => t.repos)])];
    return c.html(await page(c, { title: "New task", nav: "inbox" }, viewer ? <NewTaskPage repos={repos} label={(await factory())?.rules.label ?? "factory"} /> : <ErrorPage message="Sign in first, so the task is asked by you." />));
  });
  app.post("/tasks/new", async (c) => {
    const viewer = viewerOf(c);
    if (!viewer) return c.redirect("/signin?back=/tasks/new", 303);
    const form = await c.req.parseBody();
    const ask = typeof form.ask === "string" ? form.ask.trim() : "";
    const repo = typeof form.repo === "string" && form.repo !== "" ? form.repo : null;
    try {
      const r = await api.createTask({ ask, repo, requestedBy: viewer });
      return c.redirect(msg("/", `Started. Issue ${r.repo}#${r.issueNumber} holds the conversation; the task shows here in a moment.`), 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500) return c.redirect(msg("/tasks/new", `Couldn't start it: ${err.message}`), 303);
      throw err;
    }
  });

  app.get("/tasks/:id", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    const t = id.success ? await api.getTask(id.data) : null;
    if (!id.success || t === null) return c.html(await page(c, { title: "Not found", nav: "tasks", flash: null }, <ErrorPage message="No such task." />), 404);
    const [events, teams, fs] = await Promise.all([cache.events(t), teamsOf(), factoriesOf()]);
    const live = isOpen(t.status) && t.status !== "awaiting_review";
    const team = teamFor(teams, { requestedBy: t.requestedBy, repo: t.source.repo });
    const fa = fs.factories.find((x) => x.slug === (team?.factory ?? "default")) ?? null;
    return c.html(await page(c, { title: t.title, nav: "tasks", refreshSec: live ? 15 : undefined }, <TaskPage t={t} events={events} facts={taskFacts(t, events)} now={now()} viewer={viewerOf(c)} team={team} factory={fa} />));
  });

  app.post("/tasks/:id/messages", async (c) => {
    const id = TaskId.parse(c.req.param("id"));
    const viewer = viewerOf(c);
    if (!viewer) return c.redirect(`/signin?back=/tasks/${id}`, 303);
    const form = await c.req.parseBody();
    const text = typeof form.text === "string" ? form.text.trim() : "";
    if (text === "") return c.redirect(`/tasks/${id}`, 303);
    try {
      const r = await api.postMessage(id, { author: viewer, text: text.slice(0, 10_000) });
      return c.redirect(msg(`/tasks/${id}`, r.url ? "Sent. It's on the PR too, and the agent picks it up now." : "Sent to the agent."), 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500) return c.redirect(msg(`/tasks/${id}`, `Couldn't send: ${err.message}`), 303);
      throw err;
    }
  });

  app.get("/tasks/:id/transcripts/:key", async (c) => {
    const id = TaskId.safeParse(c.req.param("id"));
    const key = c.req.param("key");
    const t = id.success ? await api.getTask(id.data) : null;
    const body = t !== null && /^transcript-\d+\.jsonl$/.test(key) ? await api.transcript(t.id, key) : null;
    if (t === null || body === null) return c.html(await page(c, { title: "Not found", nav: "tasks", flash: null }, <ErrorPage message="No such transcript." />), 404);
    const turn = Number(/^transcript-(\d+)/.exec(key)?.[1] ?? NaN);
    return c.html(await page(c, { title: `Session · ${t.title}`, nav: "tasks", flash: null }, <TranscriptPage t={t} turn={Number.isFinite(turn) ? turn : null} lines={parseTranscript(body)} />));
  });

  app.post("/tasks/:id/retry", async (c) => {
    const id = TaskId.parse(c.req.param("id"));
    const back = typeof (await c.req.parseBody()).back === "string" ? "/" : `/tasks/${id}`;
    try {
      const t = await api.retry(id, { by: viewerOf(c) ?? "dashboard" });
      return c.redirect(msg(back, t.status === "failed" ? "Retrying. The agent picks it up in a moment." : "It's already running again."), 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500) return c.redirect(msg(back, `Couldn't retry: ${err.message}`), 303);
      throw err;
    }
  });

  app.post("/tasks/:id/cancel", async (c) => {
    const id = TaskId.parse(c.req.param("id"));
    const form = await c.req.parseBody();
    const reason = typeof form.reason === "string" && form.reason.trim() !== "" ? form.reason.trim().slice(0, 1000) : undefined;
    try {
      await api.cancel(id, { by: viewerOf(c) ?? "dashboard", ...(reason ? { reason } : {}) });
      return c.redirect(msg(`/tasks/${id}`, "Stopped. The environment is asleep; write to the task to resume."), 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500) return c.redirect(msg(`/tasks/${id}`, `Couldn't stop: ${err.message}`), 303);
      throw err;
    }
  });

  app.post("/tasks/:id/benchmark", async (c) => {
    const id = TaskId.parse(c.req.param("id"));
    try {
      const b = await api.addToBenchmark(id);
      return c.redirect(msg("/bench", `Added ${b.id} to the benchmark.`), 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500) return c.redirect(msg(`/tasks/${id}`, `Couldn't add to benchmark: ${err.message}`), 303);
      throw err;
    }
  });

  // ── insights and saved views ──
  app.get("/insights", async (c) => {
    const s = await scoped(c, "/insights");
    const ex = explore(s.inScope, { measure: c.req.query("measure") ?? "came_back", by: c.req.query("by") ?? "kind", split: c.req.query("split") ?? "none" }, s.teams, s.n);
    const views = s.viewer ? await api.views(s.viewer).catch(() => []) : [];
    const current = await viewFor(c);
    const save = <SaveViewForm path={pathOf(c)} viewer={s.viewer} teams={s.teams} current={current && current.owner === s.viewer ? current : null} />;
    return c.html(await page(c, { title: current?.name ?? "Insights", nav: "insights", inboxCount: s.inboxCount, scope: s.bar() }, <InsightsPage ex={ex} f={s.f} views={views} viewer={s.viewer} teams={s.teams} saveForm={save} now={s.n} />));
  });
  app.get("/overview", async (c) => {
    const { facts } = await loadAll();
    const d = [7, 30, 90].includes(Number(c.req.query("days"))) ? Number(c.req.query("days")) : 30;
    return c.html(await page(c, { title: "Overview", nav: "insights" }, <DashboardPage i={insights(facts, now(), d)} days={dailySeries(facts, now(), d)} now={now()} />));
  });
  app.get("/metrics", (c) => c.redirect("/insights", 301));

  app.get("/views/:id", async (c) => {
    const v = await api.view(c.req.param("id"));
    if (!v) return c.html(await page(c, { title: "Not found", nav: "insights", flash: null }, <ErrorPage message="No such view." />), 404);
    return c.redirect(`${v.path}${v.path.includes("?") ? "&" : "?"}view=${v.id}`, 302);
  });
  app.post("/views", async (c) => {
    const viewer = viewerOf(c);
    if (!viewer) return c.redirect("/signin", 303);
    const form = await c.req.parseBody();
    const path = safePath(form.path, "/insights");
    const shareRaw = typeof form.share === "string" ? form.share : "me";
    const [shareKind, team] = shareRaw.startsWith("team:") ? ["team", shareRaw.slice(5)] : [shareRaw, null];
    const share = ViewShare.safeParse(shareKind);
    const nameV = typeof form.name === "string" ? form.name.trim().slice(0, 120) : "";
    if (!share.success || nameV === "") return c.redirect(msg(path, "A view needs a name."), 303);
    const v = await api.saveView({ ...(typeof form.id === "string" && form.id ? { id: form.id } : {}), name: nameV, path, owner: viewer, share: share.data, team });
    const who = v.share === "me" ? "only you" : v.share === "team" ? `the ${v.team} team` : v.share === "org" ? "everyone in the org" : "anyone with the link";
    return c.redirect(msg(`${path}${path.includes("?") ? "&" : "?"}view=${v.id}`, `Saved "${v.name}" for ${who}.`), 303);
  });
  app.post("/views/:id/delete", async (c) => {
    const viewer = viewerOf(c);
    if (!viewer) return c.redirect("/signin", 303);
    const ok = await api.deleteView(c.req.param("id"), viewer);
    return c.redirect(msg("/insights", ok ? "View deleted." : "Only its owner can delete a view."), 303);
  });

  // ── org: setup, people, sources ──
  const eventsUrl = `${(opts.publicApiUrl ?? "https://<factory>").replace(/\/$/, "")}/v1/events`;
  const requireOrg = async () => {
    const o = await api.org();
    orgOf = loadOrg();
    return o;
  };
  app.get("/setup", async (c) => {
    const [o, teams] = await Promise.all([requireOrg(), teamsOf()]);
    return c.html(await page(c, { title: "Setup", nav: "setup" }, <SetupPage s={o} viewer={viewerOf(c)} eventsUrl={eventsUrl} teams={teams} />));
  });
  app.get("/people", async (c) => {
    const [o, teams] = await Promise.all([requireOrg(), teamsOf()]);
    return c.html(await page(c, { title: "People", nav: "people" }, <PeoplePage s={o} teams={teams} />));
  });
  app.get("/sources", async (c) => {
    const only = c.req.query("source") ?? null;
    const [o, events] = await Promise.all([requireOrg(), api.inboundEvents({ ...(only ? { source: only } : {}), limit: 200 })]);
    return c.html(await page(c, { title: "Sources", nav: "sources", refreshSec: 30 }, <SourcesPage s={o} events={events} only={only} eventsUrl={eventsUrl} />));
  });
  const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const setupPost = (path: string, anchor: string, run: (form: Record<string, string | File | (string | File)[]>, by: string) => Promise<string>) =>
    app.post(path, async (c) => {
      const by = viewerOf(c);
      if (!by) return c.redirect(`/signin?back=/setup`, 303);
      const form = await c.req.parseBody({ all: true });
      try {
        const said = await run(form, by);
        orgOf = loadOrg();
        return c.redirect(msg(`/setup#${anchor}`, said), 303);
      } catch (err) {
        if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500) return c.redirect(msg(`/setup#${anchor}`, `Couldn't save: ${err.message}`), 303);
        throw err;
      }
    });
  setupPost("/setup/org", "org", async (f, by) => {
    await api.setOrg({ name: text(f.name) ?? "", by });
    return "Saved the org's name.";
  });
  setupPost("/setup/repo", "repo", async (f, by) => {
    await api.connectRepo({ repo: text(f.repo) ?? "", by });
    return `Connected ${text(f.repo)}.`;
  });
  setupPost("/setup/source", "sources", async (f, by) => {
    const uses = (Array.isArray(f.uses) ? f.uses : f.uses ? [f.uses] : []).filter((x): x is string => typeof x === "string") as Array<"asks" | "outcomes" | "deploys">;
    const routes = Object.fromEntries(list(f.routes).map((r) => r.split("=").map((x) => x.trim())).filter((r) => r.length === 2 && r[0] && r[1]));
    await api.connectSource({ id: text(f.id) ?? "", kind: (text(f.kind) ?? "cdevents") as never, name: text(f.name) ?? "", ceSource: text(f.ceSource) ?? "", uses, routes, by });
    return `Connected ${text(f.name)}.`;
  });
  setupPost("/setup/factory", "factories", async (f, by) => {
    const high = list(f.high);
    const low = list(f.low);
    await api.saveFactory({ slug: text(f.slug) ?? "", description: text(f.description), scorers: list(f.scorers), benchmarks: list(f.benchmarks), world: text(f.world), mergeRisk: high.length || low.length ? { high, low } : null, by });
    factoriesCacheBust();
    return `Saved the ${text(f.slug)} factory.`;
  });
  setupPost("/setup/team", "teams", async (f, by) => {
    const members = list(f.members).map((login, i) => ({ login, role: i === 0 ? ("maintainer" as const) : ("member" as const) }));
    await api.saveTeam({ slug: text(f.slug) ?? "", name: text(f.name) ?? "", description: text(f.description), repos: list(f.repos), factory: text(f.factory) ?? "default", members, scope: { paths: list(f.paths), labels: list(f.labels) }, by });
    return `Saved team ${text(f.name)}.`;
  });
  setupPost("/setup/person", "people", async (f, by) => {
    const ids = Object.fromEntries((["slack", "msteams", "jira"] as const).map((k) => [k, text(f[k])]).filter(([, v]) => v)) as Record<string, string>;
    await api.invite({ login: text(f.login) ?? "", name: text(f.name), email: text(f.email), persona: (text(f.persona) ?? "engineer") as Persona, ...(text(f.role) ? { role: text(f.role) as "viewer" } : {}), identities: ids, by });
    return `Invited ${text(f.name) ?? text(f.login)}.`;
  });

  // ── teams and people ──
  app.get("/teams", async (c) => {
    const s = await scoped(c, "/teams");
    const inPeriod = s.facts.filter((x) => matches(x, { ...s.f, scope: { kind: "org" } }, s.teams, s.n));
    return c.html(await page(c, { title: "Teams", nav: "teams", inboxCount: s.inboxCount, scope: s.bar() }, <TeamsPage teams={s.teams} facts={inPeriod} now={s.n} f={s.f} />));
  });
  app.get("/teams/:slug", async (c) => {
    const slug = c.req.param("slug");
    const s = await scoped(c, `/teams/${slug}`, { kind: "team", team: slug });
    const team = s.teams.find((t) => t.slug === slug);
    if (!team) return c.html(await page(c, { title: "Not found", nav: "teams", flash: null }, <ErrorPage message="No such team." />), 404);
    const f: Filters = { ...s.f, scope: { kind: "team", team: slug } };
    const facts = s.facts.filter((x) => matches(x, f, s.teams, s.n));
    const [fs, views] = await Promise.all([factoriesOf(), s.viewer ? api.views(s.viewer).catch(() => []) : Promise.resolve([])]);
    return c.html(
      await page(c, { title: team.name, nav: "teams", inboxCount: s.inboxCount, scope: <ScopeBar f={f} teams={s.teams} viewer={s.viewer} base={`/teams/${slug}`} opts={scopeOptions(s.facts)} /> },
        <TeamPage team={team} facts={facts} now={s.n} f={f} factory={fs.factories.find((x) => x.slug === team.factory) ?? null} views={views.filter((v) => v.share === "team" && v.team === slug)} viewer={s.viewer} />),
    );
  });
  app.get("/people/:login", async (c) => {
    const login = c.req.param("login");
    if (!LOGIN.test(login)) return c.notFound();
    const s = await scoped(c, `/people/${login}`, { kind: "person", login });
    const f: Filters = { ...s.f, scope: { kind: "person", login } };
    const facts = s.facts.filter((x) => matches(x, f, s.teams, s.n));
    return c.html(await page(c, { title: login, nav: "teams", inboxCount: s.inboxCount, scope: <ScopeBar f={f} teams={s.teams} viewer={s.viewer} base={`/people/${login}`} opts={scopeOptions(s.facts)} /> }, <PersonPage login={login} teams={s.teams} facts={facts} now={s.n} f={f} viewer={s.viewer} />));
  });

  // ── factories ──
  app.get("/factories", async (c) => {
    const [{ facts }, fs, info, runs, teams] = await Promise.all([loadAll(), factoriesOf(), factory(), api.benchRuns().catch(() => []), teamsOf()]);
    const rows = new Map(fs.factories.map((fa) => [fa.slug, versionRows(facts.filter((x) => factorySlugOf(x.task, teams) === fa.slug), runs, now())]));
    return c.html(await page(c, { title: "Factories", nav: "factories" }, <FactoriesPage factories={fs.factories} rollouts={fs.rollouts} info={info} rows={rows} />));
  });
  app.get("/factories/:slug", async (c) => {
    const slug = c.req.param("slug");
    const [{ facts }, fs, info, runs, teams] = await Promise.all([loadAll(), factoriesOf(), factory(), api.benchRuns().catch(() => []), teamsOf()]);
    const fa = fs.factories.find((x) => x.slug === slug);
    if (!fa) return c.html(await page(c, { title: "Not found", nav: "factories", flash: null }, <ErrorPage message="No such factory." />), 404);
    const r = await api.rollout(slug);
    const rows = versionRows(facts.filter((x) => factorySlugOf(x.task, teams) === slug), runs, now());
    return c.html(await page(c, { title: `${slug} factory`, nav: "factories" }, <><FactoryPage fa={fa} info={info} rollout={r.rollout} history={r.history} rows={rows} viewer={viewerOf(c)} runs={runs} tabs={<FactoryTabs slug={slug} on={`/factories/${slug}`} />} /><VersionDefs versions={info?.versions} /></>));
  });
  app.post("/factories/:slug/rollout", async (c) => {
    const slug = c.req.param("slug");
    const viewer = viewerOf(c);
    if (!viewer) return c.redirect(`/signin?back=/factories/${slug}`, 303);
    const form = await c.req.parseBody();
    const s = (k: string) => (typeof form[k] === "string" && (form[k] as string).trim() !== "" ? (form[k] as string).trim() : null);
    const share = Number(s("share") ?? 0);
    try {
      const r = await api.setRollout(slug, { live: s("live"), candidate: s("candidate"), share: Number.isFinite(share) ? share : 0, by: viewer, note: s("note") });
      factoriesCacheBust();
      const said = r.candidate ? `${r.candidate} now gets ${Math.round(r.share * 100)}% of new tasks.` : `New tasks run on ${r.live ?? "the server's version"}.`;
      return c.redirect(msg(`/factories/${slug}`, said), 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500) return c.redirect(msg(`/factories/${slug}`, `Couldn't change the rollout: ${err.message}`), 303);
      throw err;
    }
  });
  app.get("/versions", (c) => c.redirect("/factories/default", 301));

  const tabbed = async (c: Context, title: string, on: string, body: Child) =>
    c.html(await page(c, { title, nav: "factories" }, <><FactoryTabs slug="default" on={on} />{body}</>));
  app.get("/agents", async (c) => tabbed(c, "Agents", "/agents", <AgentsPage f={await requireFactory()} />));
  app.get("/agents/:role", async (c) => {
    const role = c.req.param("role");
    if (role !== "implementation" && role !== "foreman") return c.html(await page(c, { title: "Not found", nav: "factories", flash: null }, <ErrorPage message="No such agent." />), 404);
    return tabbed(c, role, "/agents", <AgentPage f={await requireFactory()} role={role} prompt={c.req.query("prompt") ?? "system"} mcpUrl={opts.mcpUrl ?? null} />);
  });
  app.get("/automations", async (c) => tabbed(c, "Automations", "/automations", <AutomationsPage f={await requireFactory()} />));
  app.get("/apps", async (c) => tabbed(c, "MCPs and apps", "/apps", <AppsPage f={await requireFactory()} mcpUrl={opts.mcpUrl ?? null} />));
  app.get("/secrets", async (c) => tabbed(c, "Secrets", "/secrets", <SecretsPage f={await requireFactory()} />));
  app.get("/environments", async (c) => {
    const [f, tasks] = await Promise.all([requireFactory(), api.listTasks({ limit: LIMIT })]);
    return tabbed(c, "Environments", "/environments", <EnvironmentsPage f={f} active={tasks.filter((t) => isOpen(t.status) && t.environment !== null)} />);
  });
  app.get("/factory", (c) => c.redirect("/factories/default", 301));

  // ── scorers and improve ──
  app.get("/scorers", async (c) => {
    const s = await scoped(c, "/scorers");
    const fs = await factoriesOf();
    const team = s.f.scope.kind === "team" ? (s.teams.find((t) => s.f.scope.kind === "team" && t.slug === s.f.scope.team) ?? null) : null;
    return c.html(await page(c, { title: "Scorers", nav: "scorers", inboxCount: s.inboxCount, scope: s.bar() }, <ScorersInScope facts={s.inScope} factories={fs.factories} team={team} f={s.f} />));
  });
  app.get("/improve", async (c) => {
    const s = await scoped(c, "/improve");
    const team = s.f.scope.kind === "team" ? (s.teams.find((t) => s.f.scope.kind === "team" && t.slug === s.f.scope.team) ?? null) : null;
    const [runs, r] = await Promise.all([api.benchRuns().catch(() => []), api.rollout(team?.factory ?? "default").catch(() => ({ rollout: null, history: [] }))]);
    return c.html(await page(c, { title: "Improve", nav: "teams", inboxCount: s.inboxCount, scope: s.bar() }, <ImprovePage facts={s.inScope} now={s.n} f={s.f} runs={runs} team={team} rollout={r.rollout} />));
  });

  // ── benchmarks ──
  app.get("/bench", async (c) => {
    const [tasks, runs, all, teams, fs] = await Promise.all([api.benchTasks(), api.benchRuns(), api.listTasks({ limit: 500 }), teamsOf(), factoriesOf()]);
    const versions = [...new Set(all.map((t) => t.factoryVersion))];
    const suites = teamSuites({ teams, factories: fs.factories, bench: tasks, tasks: all, runs, now: now() });
    return c.html(await page(c, { title: "Benchmarks", nav: "bench" }, <><BenchPage tasks={tasks} runs={runs} versions={versions} models={opts.models} /><TeamSuites suites={suites} days={30} /></>));
  });
  app.get("/bench/runs/:id", (c) => c.redirect(`/bench#${encodeURIComponent(c.req.param("id"))}`, 302));

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
      return c.redirect(msg("/bench", `Started ${run.id}. Refresh to see results as they land.`), 303);
    } catch (err) {
      if (err instanceof FactoryApiError && err.status >= 400 && err.status < 500) return c.redirect(msg("/bench", `Couldn't start the run: ${err.message}`), 303);
      throw err;
    }
  });

  return app;
}

const factorySlugOf = (t: TaskRecord, teams: readonly Team[]) => t.factory ?? factoryFor(teams, { requestedBy: t.requestedBy, repo: t.source.repo });

export { filterQuery, scopeParam };
