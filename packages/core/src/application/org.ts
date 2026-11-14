import { ConnectedSource, DEFAULT_ROLE, OrgFactory, OrgTeam, Person, TaskId, type CloudEvent, type Intake, type IntakeResult, type OrgState, type RepoRef, type TaskMatch, type TaskRecord } from "@openfactory/contracts";
import { personFor, type Actor } from "../domain/actor.js";
import { errors, fail } from "../domain/errors.js";
import { setupSteps } from "../domain/rules.js";
import type { CoreDeps } from "../ports/index.js";
import type { Registry } from "./capability.js";
import { ask } from "./tasks.js";

const repoRef = (s: string): RepoRef => {
  const [owner = "", name = ""] = s.split("/");
  return { host: "github", owner, name };
};

/** The org as set up in the app, with setup progress computed from what exists. */
export async function orgState(deps: CoreDeps): Promise<OrgState> {
  const [org, repos, people, teams, factories, sources, tasks] = await Promise.all([
    deps.org.org(),
    deps.org.repos(),
    deps.org.people(),
    deps.org.teams(),
    deps.org.factories(),
    deps.org.sources(),
    deps.tasks.listTasks({ limit: 1 }),
  ]);
  const s = { org, repos, people, teams, factories, sources };
  return { ...s, setup: setupSteps(s, tasks.length), replies: await deps.org.replies(50) };
}

/** Org setup. Admins change it; a person may mark themselves joined. */
export const orgCapabilities: Pick<Registry, "getOrg" | "setOrg" | "connectRepo" | "invitePerson" | "joinOrg" | "saveTeam" | "saveFactory" | "connectSource" | "listEvents"> = {
  getOrg: { audience: "viewer", risk: "read", mcp: true, target: null, run: async ({ deps }) => ({ org: await orgState(deps) }) },
  setOrg: {
    audience: "admin",
    risk: "reversible",
    mcp: true,
    target: null,
    run: async ({ deps, actor }, i) => {
      const by = personFor(actor, i.by);
      const prev = await deps.org.org();
      await deps.org.setOrg({ name: i.name, createdBy: prev?.createdBy ?? by, createdAt: prev?.createdAt ?? deps.now(), simulated: i.simulated ?? prev?.simulated ?? false });
      // Whoever names the org is its first admin.
      if (!(await deps.org.person(by)))
        await deps.org.putPerson({ login: by, name: null, email: null, persona: "platform_director", role: "admin", identities: {}, status: "joined", invitedBy: null, invitedAt: deps.now(), joinedAt: deps.now() });
      return { org: await orgState(deps) };
    },
  },
  connectRepo: {
    audience: "admin",
    risk: "reversible",
    mcp: true,
    target: (i) => i.repo,
    run: async ({ deps, actor }, i) => {
      await deps.org.addRepo({ repo: i.repo, connectedBy: personFor(actor, i.by), connectedAt: deps.now() });
      return { org: await orgState(deps) };
    },
  },
  invitePerson: {
    audience: "admin",
    risk: "reversible",
    mcp: true,
    target: (i) => `person:${i.login}`,
    run: async ({ deps, actor }, i) => {
      const prev = await deps.org.person(i.login);
      const p = Person.parse({
        login: i.login,
        name: i.name ?? prev?.name ?? null,
        email: i.email ?? prev?.email ?? null,
        persona: i.persona,
        role: i.role ?? DEFAULT_ROLE[i.persona],
        identities: { ...(prev?.identities ?? {}), ...(i.identities ?? {}) },
        status: prev?.status ?? "invited",
        invitedBy: prev?.invitedBy ?? personFor(actor, i.by),
        invitedAt: prev?.invitedAt ?? deps.now(),
        joinedAt: prev?.joinedAt ?? null,
      });
      return { person: await deps.org.putPerson(p) };
    },
  },
  // A person marks themselves joined when they first sign in; admins (and integration keys) may mark anyone.
  joinOrg: {
    audience: "viewer",
    risk: "reversible",
    mcp: false,
    target: (i) => `person:${i.login}`,
    run: async ({ deps, actor, role }, i) => {
      if (actor.principal.kind === "user" && role !== "admin" && actor.principal.login.toLowerCase() !== i.login.toLowerCase())
        fail({ code: "FORBIDDEN", operation: "joinOrg", reason: "not_owner", message: `Only ${i.login} or an admin can mark ${i.login} as joined.` });
      const p = (await deps.org.person(i.login)) ?? fail(errors.personNotFound(i.login));
      return { person: await deps.org.putPerson({ ...p, status: "joined", joinedAt: p.joinedAt ?? deps.now() }) };
    },
  },
  saveTeam: {
    audience: "admin",
    risk: "reversible",
    mcp: true,
    target: (i) => `team:${i.slug}`,
    run: async ({ deps, actor }, i) => {
      const prev = await deps.org.team(i.slug);
      const { by, ...t } = i;
      const team = OrgTeam.parse({ ...t, createdBy: prev?.createdBy ?? personFor(actor, by), createdAt: prev?.createdAt ?? deps.now() });
      const factories = new Set(["default", ...(await deps.org.factories()).map((f) => f.slug)]);
      if (!factories.has(team.factory)) fail(errors.invalid(`There is no factory "${team.factory}". Create the team factory first (saveFactory), or use "default".`, [{ path: "factory", message: "unknown factory" }]));
      return { team: await deps.org.putTeam(team) };
    },
  },
  saveFactory: {
    audience: "admin",
    // With a definitions repo this opens a pull request on the code host; either way it can be undone.
    risk: "external",
    mcp: true,
    target: (i) => `factory:${i.slug}`,
    run: async ({ deps, actor }, i) => {
      if (i.slug === "default") fail(errors.invalid("The org default factory is defined by factory.yaml; change it there.", [{ path: "slug", message: "reserved" }]));
      const { by, ...f } = i;
      const prev = (await deps.org.factories()).find((x) => x.slug === f.slug);
      const who = personFor(actor, by);
      const factory = OrgFactory.parse({ ...f, createdBy: prev?.createdBy ?? who, createdAt: prev?.createdAt ?? deps.now() });
      if (deps.definitions === null) return { factory: await deps.org.putFactory(factory), proposal: null };
      // Factories as code: the change is a pull request; it takes effect when merged and synced.
      const r = await deps.definitions.proposeFactory(factory, who);
      if (!r.ok) fail({ code: "CODE_HOST_UNAVAILABLE", repo: deps.definitions.where(), message: `Couldn't open a pull request in ${deps.definitions.where()}: ${r.reason}. Try again in a moment.` });
      return { factory, proposal: { number: r.number, url: r.url } };
    },
  },
  connectSource: {
    audience: "admin",
    risk: "reversible",
    mcp: true,
    target: (i) => `source:${i.id}`,
    run: async ({ deps, actor }, i) => {
      const { by, ...s } = i;
      return { source: await deps.org.putSource(ConnectedSource.parse({ ...s, connectedBy: personFor(actor, by), connectedAt: deps.now() })) };
    },
  },
  listEvents: {
    audience: "viewer",
    risk: "read",
    mcp: true,
    target: null,
    run: async ({ deps }, i) => ({ events: await deps.org.events({ ...(i.source ? { sourceId: i.source } : {}), limit: i.limit ?? 200 }) }),
  },
};

// ───────────────────────────── inbound CloudEvents ─────────────────────────────

/** Find the task an outcome event points at. */
async function findTask(deps: CoreDeps, m: TaskMatch): Promise<TaskRecord | null> {
  if (m.taskId) {
    const id = TaskId.safeParse(m.taskId);
    return id.success ? deps.tasks.getTask(id.data) : null;
  }
  if (m.repo && m.prNumber !== undefined) return deps.tasks.findByPr(repoRef(m.repo), m.prNumber);
  if (m.sha) {
    const sha = m.sha;
    const repos = [...deps.config.repos(), ...(await deps.org.repos()).map((r) => repoRef(r.repo))];
    for (const r of repos) {
      const t = await deps.tasks.findByHeadSha(r, sha);
      if (t) return t;
    }
    // A merge sha (recorded as "merge <sha>" on the merged outcome).
    const recent = await deps.tasks.listTasks({ status: "merged", limit: 500 });
    return recent.find((t) => t.outcomes.some((o) => o.kind === "merged" && o.detail.includes(sha))) ?? null;
  }
  return null;
}

/** What one inbound event did. */
export type EventResult = { id: string; source: string; result: IntakeResult; duplicate: boolean };

/**
 * Act on inbound CloudEvents (already parsed at the boundary). Each event is kept with its result, so a person
 * can see why a Slack ask did or didn't start work. Never throws for one bad event: it becomes an "error" result.
 */
export async function ingestEvents(deps: CoreDeps, actor: Actor, events: CloudEvent[]): Promise<EventResult[]> {
  const out: EventResult[] = [];
  for (const ev of events) out.push({ id: ev.id, source: ev.source, ...(await ingestOne(deps, actor, ev)) });
  return out;
}

async function ingestOne(deps: CoreDeps, actor: Actor, ev: CloudEvent): Promise<{ result: IntakeResult; duplicate: boolean }> {
  const sources = await deps.org.sources();
  const source = sources.filter((s) => ev.source.startsWith(s.ceSource)).sort((a, b) => b.ceSource.length - a.ceSource.length)[0] ?? null;
  const kind = deps.translator.kindOf(ev, source);
  const pending: IntakeResult = { kind: "ignored", detail: "received", taskId: null, url: null };
  const fresh = await deps.org.recordEvent({ event: ev, sourceId: source?.id ?? null, kind, result: pending });
  if (!fresh) return { result: pending, duplicate: true };
  let result: IntakeResult;
  try {
    const it = deps.translator.translate(ev, { factoryLabel: deps.config.factoryLabel, source, now: deps.now() });
    result = await act(deps, actor, ev, it, source);
  } catch (e) {
    result = { kind: "error", detail: e instanceof Error ? e.message : String(e), taskId: null, url: null };
  }
  await deps.org.setEventResult(ev, result);
  deps.log("event", { source: ev.source, type: ev.type, id: ev.id, result: result.kind, detail: result.detail });
  return { result, duplicate: false };
}

async function act(deps: CoreDeps, actor: Actor, ev: CloudEvent, it: Intake, source: ConnectedSource | null): Promise<IntakeResult> {
  const r = (kind: IntakeResult["kind"], detail: string, taskId: string | null = null, url: string | null = null): IntakeResult => ({ kind, detail, taskId, url });
  switch (it.kind) {
    case "ignore":
      return r("ignored", it.reason);
    case "ask": {
      if (source && !source.uses.includes("asks")) return r("ignored", `${source.name} is connected for ${source.uses.join(" and ")}, not asks`);
      const people = await deps.org.people();
      const toolKind = it.actor.kind;
      const id = it.actor.id;
      const email = it.actor.email?.toLowerCase() ?? null;
      const byId = id !== null && (toolKind === "slack" || toolKind === "msteams" || toolKind === "jira") ? people.find((p) => p.identities[toolKind] === id) : undefined;
      const byEmail = email !== null ? people.find((p) => p.email?.toLowerCase() === email) : undefined;
      const person = byId ?? byEmail;
      if (!person) return r("error", `Nobody in the org is linked to ${it.actor.kind} user ${it.actor.id ?? it.actor.email ?? "?"}. Invite them, or add that id to their profile.`);
      const team = it.place && source ? (source.routes[it.place] ?? null) : null;
      const teamRepo = team ? ((await deps.org.team(team))?.repos[0] ?? null) : null;
      const out = await ask(deps, actor, { ask: it.ask, repo: teamRepo, requestedBy: person.login, origin: it.origin, labels: it.labels, team });
      // Remember where to answer, so the asker hears back in their own thread or ticket.
      if (source && (it.reply.thread || it.place))
        await deps.org.putThread({
          key: `${source.id}:${ev.id}`,
          sourceId: source.id,
          kind: source.kind,
          place: it.place,
          thread: it.reply.thread,
          conversation: it.reply.conversation,
          serviceUrl: it.reply.serviceUrl,
          repo: out.repo,
          issueNumber: out.issueNumber,
          told: null,
          createdAt: deps.now(),
        });
      return r("ask", `Asked by ${person.login}${team ? ` for team ${team}` : ""}: ${out.repo}#${out.issueNumber}`, null, out.issueUrl);
    }
    case "merge":
    case "close": {
      const task = await deps.tasks.findByPr(repoRef(it.repo), it.prNumber);
      if (!task) return r("ignored", `${it.repo}#${it.prNumber} isn't a factory PR`);
      const base = { id: `ce:${ev.source}#${ev.id}`, repo: repoRef(it.repo), at: it.at, actor: { login: "cdevents", isBot: false }, prNumber: it.prNumber };
      if (it.kind === "merge") {
        const sha = task.pr?.headSha;
        if (!sha) return r("error", "the PR has no head commit yet", task.id);
        await deps.runner.signal({ ...base, type: "pr_merged", mergeSha: sha });
        return r("signal", `merged at ${sha.slice(0, 7)}`, task.id, task.pr?.url ?? null);
      }
      await deps.runner.signal({ ...base, type: "pr_closed" });
      return r("signal", "closed without merging", task.id, task.pr?.url ?? null);
    }
    case "outcome": {
      const task = await findTask(deps, it.match);
      if (!task) return r("ignored", `no factory task matches ${JSON.stringify(it.match)}`);
      const sourceName = source?.id ?? deps.translator.kindOf(ev, null) ?? "cloudevents";
      const added = await deps.outcomes.record(task.id, { ...it.outcome, source: sourceName, arrivedAt: deps.now() }, `outcome:${source?.id ?? "cloudevents"}:${task.id}:${it.outcome.kind}:${it.ref}`);
      return r("outcome", `${it.outcome.kind}: ${it.outcome.detail}${added ? "" : " (already recorded)"}`, task.id);
    }
  }
}
