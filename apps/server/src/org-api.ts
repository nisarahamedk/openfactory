/**
 * Org setup and inbound events:
 *
 *   GET  /v1/org                         the org, its repos, people, teams, factories, sources and setup steps
 *   POST /v1/org                         name the org (first step of setup)
 *   POST /v1/org/repos                   connect a repo
 *   POST /v1/org/people                  invite a person with a persona and role
 *   POST /v1/org/people/:login/join      the invited person signed in
 *   POST /v1/org/teams                   create or change a team (members, repos, scope, factory)
 *   POST /v1/org/factories               create or change a team factory
 *   POST /v1/org/sources                 connect a tool (Slack, Microsoft Teams, Jira, Datadog, Rootly, ...)
 *   POST /v1/events                      CloudEvents 1.0 from any connected tool (structured, batch or binary)
 *   GET  /v1/events[?source=&limit=]     what arrived and what the factory did with it
 *
 * Every inbound event is kept with its result, so a person can see why a Slack ask did or didn't start work.
 */
import { CloudEventsError, kindOf, parseCloudEvents, translate, type Intake, type TaskMatch } from "@openfactory/cloudevents";
import {
  ConnectedSource,
  DEFAULT_ROLE,
  OrgFactory,
  OrgTeam,
  Person,
  type CloudEvent,
  type IntakeResult,
  type OrgState,
  type Outcome,
  type RepoRef,
  type SetupStep,
  type Signal,
  type Team,
  type TaskId,
  type TaskRecord,
} from "@openfactory/contracts";
import type { Ledger, OrgStore } from "@openfactory/ledger";
import { ConnectOrgRepo, ConnectOrgSource, InvitePerson, SaveOrgFactory, SaveOrgTeam, SetOrg } from "@openfactory/client";
import { Hono } from "hono";

export type AskInput = { ask: string; repo: string | null; requestedBy: string; origin?: { label: string; url: string | null } | null; labels?: string[]; team?: string | null };

export type OrgDeps = {
  store: OrgStore;
  ledger: Ledger;
  ask: (input: AskInput) => Promise<{ issueUrl: string; repo: string; issueNumber: number }>;
  onSignal: (s: Signal) => Promise<unknown>;
  /** Record a late outcome on a task and rescore it (deduped on ref). */
  addOutcome: (taskId: TaskId, outcome: Outcome, ref: string, source: string) => Promise<boolean>;
  /** Repos the factory polls (FACTORY_REPOS): outcome matching by sha searches these and connected repos. */
  repos: () => RepoRef[];
  factoryLabel: string;
  now: () => string;
  log: (m: string, f?: object) => void;
};

const repoRef = (s: string): RepoRef => {
  const [owner = "", name = ""] = s.split("/");
  return { host: "github", owner, name };
};

/** Setup progress, computed from what exists (never stored). */
export function setupSteps(s: Omit<OrgState, "setup">, taskCount: number): SetupStep[] {
  const joined = s.people.filter((p) => p.status === "joined").length;
  const askSources = s.sources.filter((x) => x.uses.includes("asks"));
  const outcomeSources = s.sources.filter((x) => x.uses.includes("outcomes") || x.uses.includes("deploys"));
  const teamFactories = s.teams.filter((t) => t.factory !== "default").length;
  return [
    { key: "org", title: "Name your org", done: s.org !== null, detail: s.org ? s.org.name : "Give the factory your org's name.", href: "/setup#org" },
    { key: "repo", title: "Connect a repo", done: s.repos.length > 0, detail: s.repos.length ? s.repos.map((r) => r.repo).join(", ") : "The factory opens PRs here.", href: "/setup#repo" },
    {
      key: "sources",
      title: "Connect where work comes from and where outcomes land",
      done: askSources.length > 0 && outcomeSources.length > 0,
      detail: s.sources.length ? `${askSources.length} for asks, ${outcomeSources.length} for deploys and incidents` : "Slack, Microsoft Teams or Jira for asks; Datadog, Rootly or your CD tool for what happens after merge.",
      href: "/setup#sources",
    },
    { key: "teams", title: "Create teams", done: s.teams.length > 0, detail: s.teams.length ? s.teams.map((t) => t.name).join(", ") : "Each team gets its own scope, factory and numbers.", href: "/setup#teams" },
    { key: "factories", title: "Give teams their factory", done: s.teams.length > 0 && (teamFactories > 0 || s.factories.length === 0), detail: teamFactories ? `${teamFactories} team${teamFactories === 1 ? "" : "s"} on a team factory` : "Teams start on the org default; a team factory adds its own scorers, benchmarks, world and merge rules.", href: "/setup#factories" },
    { key: "people", title: "Invite people", done: s.people.length > 1, detail: s.people.length ? `${s.people.length} invited, ${joined} joined` : "Engineers, managers, directors, the factory and platform owners, and the VP.", href: "/setup#people" },
    { key: "first_task", title: "Run a first task", done: taskCount > 0, detail: taskCount ? `${taskCount} task${taskCount === 1 ? "" : "s"} so far` : "Ask in Slack, Teams, Jira or the app.", href: "/tasks/new" },
  ];
}

/** Teams made in the app, as the directory's Team shape. */
export const asTeam = (t: OrgTeam): Team => ({
  slug: t.slug,
  name: t.name,
  source: "app",
  members: t.members.map((m) => ({ login: m.login, name: null, role: m.role })),
  repos: t.repos,
  factory: t.factory,
});

/** Config teams win on a slug clash: factory.yaml is the reviewed source. */
export function mergeTeams(directory: Team[], app: OrgTeam[]): Team[] {
  // The inferred "everyone" team is only a stand-in for an org with no teams; once teams exist it would
  // claim every person first and send all their work to the default factory.
  const config = app.length ? directory.filter((t) => t.source !== "inferred") : directory;
  const seen = new Set(config.map((t) => t.slug));
  return [...config, ...app.filter((t) => !seen.has(t.slug)).map(asTeam)];
}

export async function orgState(d: Pick<OrgDeps, "store" | "ledger">): Promise<OrgState> {
  const [org, repos, people, teams, factories, sources, tasks] = await Promise.all([
    d.store.org(),
    d.store.repos(),
    d.store.people(),
    d.store.teams(),
    d.store.factories(),
    d.store.sources(),
    d.ledger.listTasks({ limit: 1 }),
  ]);
  const s = { org, repos, people, teams, factories, sources };
  return { ...s, setup: setupSteps(s, tasks.length) };
}

/** Find the task an outcome event points at. */
export async function findTask(d: Pick<OrgDeps, "ledger" | "repos" | "store">, m: TaskMatch): Promise<TaskRecord | null> {
  if (m.taskId) return d.ledger.getTask(m.taskId as TaskId);
  if (m.repo && m.prNumber !== undefined) return d.ledger.findByPr(repoRef(m.repo), m.prNumber);
  if (m.sha) {
    const repos = [...d.repos(), ...(await d.store.repos()).map((r) => repoRef(r.repo))];
    for (const r of repos) {
      const t = await d.ledger.findByHeadSha(r, m.sha);
      if (t) return t;
    }
    // A merge sha (recorded as "merge <sha>" on the merged outcome).
    const recent = await d.ledger.listTasks({ status: "merged", limit: 500 });
    return recent.find((t) => t.outcomes.some((o) => o.kind === "merged" && o.detail.includes(m.sha!))) ?? null;
  }
  return null;
}

/** Act on one inbound event. Never throws: failures become an "error" result the app shows. */
export async function intake(d: OrgDeps, ev: CloudEvent): Promise<{ result: IntakeResult; duplicate: boolean }> {
  const sources = await d.store.sources();
  const source = sources.filter((s) => ev.source.startsWith(s.ceSource)).sort((a, b) => b.ceSource.length - a.ceSource.length)[0] ?? null;
  const kind = kindOf(ev, source);
  const pending: IntakeResult = { kind: "ignored", detail: "received", taskId: null, url: null };
  const fresh = await d.store.recordEvent({ event: ev, sourceId: source?.id ?? null, kind, result: pending });
  if (!fresh) return { result: pending, duplicate: true };
  let result: IntakeResult;
  try {
    const it = translate(ev, { factoryLabel: d.factoryLabel, source, now: d.now() });
    result = await act(d, ev, it, source);
  } catch (e) {
    result = { kind: "error", detail: e instanceof Error ? e.message : String(e), taskId: null, url: null };
  }
  await d.store.setEventResult(ev, result);
  d.log("event", { source: ev.source, type: ev.type, id: ev.id, result: result.kind, detail: result.detail });
  return { result, duplicate: false };
}

async function act(d: OrgDeps, ev: CloudEvent, it: Intake, source: ConnectedSource | null): Promise<IntakeResult> {
  const r = (kind: IntakeResult["kind"], detail: string, taskId: string | null = null, url: string | null = null): IntakeResult => ({ kind, detail, taskId, url });
  switch (it.kind) {
    case "ignore":
      return r("ignored", it.reason);
    case "ask": {
      if (source && !source.uses.includes("asks")) return r("ignored", `${source.name} is connected for ${source.uses.join(" and ")}, not asks`);
      const people = await d.store.people();
      const byId = it.actor.id ? people.find((p) => p.identities[it.actor.kind as "slack" | "msteams" | "jira"] === it.actor.id) : undefined;
      const byEmail = it.actor.email ? people.find((p) => p.email?.toLowerCase() === it.actor.email!.toLowerCase()) : undefined;
      const person = byId ?? byEmail;
      if (!person) return r("error", `Nobody in the org is linked to ${it.actor.kind} user ${it.actor.id ?? it.actor.email ?? "?"}. Invite them, or add that id to their profile.`);
      const team = it.place && source ? (source.routes[it.place] ?? null) : null;
      const teamRepo = team ? ((await d.store.team(team))?.repos[0] ?? null) : null;
      const out = await d.ask({ ask: it.ask, repo: teamRepo, requestedBy: person.login, origin: it.origin, labels: it.labels, team });
      return r("ask", `Asked by ${person.login}${team ? ` for team ${team}` : ""}: ${out.repo}#${out.issueNumber}`, null, out.issueUrl);
    }
    case "merge":
    case "close": {
      const task = await d.ledger.findByPr(repoRef(it.repo), it.prNumber);
      if (!task) return r("ignored", `${it.repo}#${it.prNumber} isn't a factory PR`);
      const base = { id: `ce:${ev.source}#${ev.id}`, repo: repoRef(it.repo), at: it.at, actor: { login: "cdevents", isBot: false }, prNumber: it.prNumber };
      if (it.kind === "merge") {
        const sha = task.pr?.headSha;
        if (!sha) return r("error", "the PR has no head commit yet", task.id);
        await d.onSignal({ ...base, type: "pr_merged", mergeSha: sha });
        return r("signal", `merged at ${sha.slice(0, 7)}`, task.id, task.pr?.url ?? null);
      }
      await d.onSignal({ ...base, type: "pr_closed" });
      return r("signal", "closed without merging", task.id, task.pr?.url ?? null);
    }
    case "outcome": {
      const task = await findTask(d, it.match);
      if (!task) return r("ignored", `no factory task matches ${JSON.stringify(it.match)}`);
      const added = await d.addOutcome(task.id, { ...it.outcome, source: source?.id ?? kindOf(ev, null) ?? "cloudevents", arrivedAt: d.now() }, it.ref, source?.id ?? "cloudevents");
      return r("outcome", `${it.outcome.kind}: ${it.outcome.detail}${added ? "" : " (already recorded)"}`, task.id);
    }
  }
}

export function createOrgRoutes(d: OrgDeps): Hono {
  const v1 = new Hono();
  const bad = (c: { json: (b: unknown, s: 400) => Response }, message: string, issues?: unknown) => c.json({ code: "INVALID_REQUEST", message, ...(issues ? { issues } : {}) }, 400);

  v1.get("/org", async (c) => c.json({ org: await orgState(d) }));
  v1.post("/org", async (c) => {
    const b = SetOrg.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return bad(c, "bad org", b.error.issues);
    const prev = await d.store.org();
    await d.store.setOrg({ name: b.data.name, createdBy: prev?.createdBy ?? b.data.by, createdAt: prev?.createdAt ?? d.now(), simulated: b.data.simulated ?? prev?.simulated ?? false });
    // Whoever names the org is its first admin.
    if (!(await d.store.person(b.data.by)))
      await d.store.putPerson({ login: b.data.by, name: null, email: null, persona: "platform_director", role: "admin", identities: {}, status: "joined", invitedBy: null, invitedAt: d.now(), joinedAt: d.now() });
    return c.json({ org: await orgState(d) });
  });
  v1.post("/org/repos", async (c) => {
    const b = ConnectOrgRepo.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return bad(c, "bad repo", b.error.issues);
    await d.store.addRepo({ repo: b.data.repo, connectedBy: b.data.by, connectedAt: d.now() });
    return c.json({ org: await orgState(d) });
  });
  v1.post("/org/people", async (c) => {
    const b = InvitePerson.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return bad(c, "bad invite", b.error.issues);
    const prev = await d.store.person(b.data.login);
    const p = Person.parse({
      login: b.data.login,
      name: b.data.name ?? prev?.name ?? null,
      email: b.data.email ?? prev?.email ?? null,
      persona: b.data.persona,
      role: b.data.role ?? DEFAULT_ROLE[b.data.persona],
      identities: { ...(prev?.identities ?? {}), ...(b.data.identities ?? {}) },
      status: prev?.status ?? "invited",
      invitedBy: prev?.invitedBy ?? b.data.by,
      invitedAt: prev?.invitedAt ?? d.now(),
      joinedAt: prev?.joinedAt ?? null,
    });
    return c.json({ person: await d.store.putPerson(p) });
  });
  v1.post("/org/people/:login/join", async (c) => {
    const p = await d.store.person(c.req.param("login"));
    if (!p) return c.json({ code: "PERSON_NOT_FOUND", message: "nobody invited by that login" }, 404);
    return c.json({ person: await d.store.putPerson({ ...p, status: "joined", joinedAt: p.joinedAt ?? d.now() }) });
  });
  v1.post("/org/teams", async (c) => {
    const b = SaveOrgTeam.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return bad(c, "bad team", b.error.issues);
    const prev = await d.store.team(b.data.slug);
    const { by, ...t } = b.data;
    const team = OrgTeam.parse({ ...t, createdBy: prev?.createdBy ?? by, createdAt: prev?.createdAt ?? d.now() });
    const factories = new Set(["default", ...(await d.store.factories()).map((f) => f.slug)]);
    if (!factories.has(team.factory)) return bad(c, `no factory "${team.factory}": create it first`);
    return c.json({ team: await d.store.putTeam(team) });
  });
  v1.post("/org/factories", async (c) => {
    const b = SaveOrgFactory.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return bad(c, "bad factory", b.error.issues);
    if (b.data.slug === "default") return bad(c, "the org default is defined by factory.yaml");
    const { by, ...f } = b.data;
    const prev = (await d.store.factories()).find((x) => x.slug === f.slug);
    return c.json({ factory: await d.store.putFactory(OrgFactory.parse({ ...f, createdBy: prev?.createdBy ?? by, createdAt: prev?.createdAt ?? d.now() })) });
  });
  v1.post("/org/sources", async (c) => {
    const b = ConnectOrgSource.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) return bad(c, "bad source", b.error.issues);
    const { by, ...s } = b.data;
    return c.json({ source: await d.store.putSource(ConnectedSource.parse({ ...s, connectedBy: by, connectedAt: d.now() })) });
  });
  v1.post("/events", async (c) => {
    let events: CloudEvent[];
    try {
      events = parseCloudEvents((n) => c.req.header(n), await c.req.text());
    } catch (e) {
      if (e instanceof CloudEventsError) return bad(c, e.message);
      throw e;
    }
    const results = [];
    for (const ev of events) results.push({ id: ev.id, source: ev.source, ...(await intake(d, ev)) });
    return c.json({ results }, 202);
  });
  v1.get("/events", async (c) => {
    const limit = Number(c.req.query("limit") ?? 200);
    const source = c.req.query("source");
    return c.json({ events: await d.store.events({ ...(source ? { sourceId: source } : {}), limit: Number.isFinite(limit) ? limit : 200 }) });
  });
  return v1;
}
