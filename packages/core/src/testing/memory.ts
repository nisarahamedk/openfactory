/**
 * Faithful in-memory implementations of every core port (the-stack coding-standards §9), for tests of the
 * core and of entrypoints. They keep state and enforce the same rules as the real adapters (deduplication,
 * owner-only view deletes), so a test that passes here exercises real behaviour.
 */
import { TaskRecord } from "@openfactory/contracts";
import type {
  BenchmarkTask,
  CloudEvent,
  ConnectedRepo,
  ConnectedSource,
  InboundEvent,
  IntakeResult,
  LedgerEvent,
  OrgFactory,
  OrgInfo,
  OrgTeam,
  Outcome,
  Person,
  ReplyThread,
  RepoRef,
  RolloutState,
  SavedView,
  Signal,
  SourceKind,
  TaskId,
  Team,
} from "@openfactory/contracts";
import type { AuditEntry, FactoryInfo, FactoryView } from "@openfactory/contract";
import type { AuditLog, Bench, BenchRunRecord, CodeHost, CoreDeps, DefinitionRepo, EventTranslator, Proposed, OrgStore, RolloutStore, TaskRunner, TaskStore, ViewStore } from "../ports/index.js";

const same = (a: RepoRef, b: RepoRef) => a.owner === b.owner && a.name === b.name;

/** Tasks held in memory; `put` seeds one. */
export class MemoryTasks implements TaskStore {
  readonly records = new Map<string, TaskRecord>();
  readonly log = new Map<string, LedgerEvent[]>();
  private readonly seen = new Set<string>();
  put(t: TaskRecord): void {
    this.records.set(t.id, t);
  }
  private append(taskId: TaskId, type: string, data: Record<string, unknown>, key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const list = this.log.get(taskId) ?? [];
    list.push({ taskId, type, at: "2026-11-14T00:00:00.000Z", data });
    this.log.set(taskId, list);
    return true;
  }
  getTask = async (id: TaskId) => this.records.get(id) ?? null;
  listTasks = async (f: { status?: TaskRecord["status"]; limit?: number } = {}) => [...this.records.values()].filter((t) => f.status === undefined || t.status === f.status).slice(0, f.limit ?? 100);
  events = async (id: TaskId) => this.log.get(id) ?? [];
  findByPr = async (repo: RepoRef, n: number) => [...this.records.values()].find((t) => same(t.source.repo, repo) && t.pr?.number === n) ?? null;
  findByHeadSha = async (repo: RepoRef, sha: string) => [...this.records.values()].find((t) => same(t.source.repo, repo) && t.pr?.headSha === sha) ?? null;
  recordEgress = async (taskId: TaskId, e: { host: string; allowed: boolean; count: number; from: string; to: string }) => this.append(taskId, "egress", e, `egress:${taskId}:${e.host}:${e.allowed}:${e.from}`);
  recordMessage = async (taskId: TaskId, m: { author: string; text: string; url: string | null }, key: string) => {
    this.append(taskId, "message_received", m, key);
  };
}

/** Records every signal, cancel and retry. */
export class MemoryRunner implements TaskRunner {
  readonly signals: Signal[] = [];
  readonly calls: string[] = [];
  constructor(private readonly tasks: MemoryTasks) {}
  signal = async (s: Signal) => {
    this.signals.push(s);
    return { accepted: true };
  };
  cancel = async (id: TaskId, by: string, reason: string | null) => {
    this.calls.push(`cancel ${id} by ${by}${reason ? `: ${reason}` : ""}`);
    return this.tasks.getTask(id);
  };
  retry = async (id: TaskId, by: string) => {
    this.calls.push(`retry ${id} by ${by}`);
    return this.tasks.getTask(id);
  };
}

/** Issues and comments, numbered from 100. */
export class MemoryCodeHost implements CodeHost {
  readonly issues: { repo: RepoRef; title: string; body: string; labels: string[]; number: number }[] = [];
  readonly comments: { target: { repo: RepoRef; issueOrPr: number }; markdown: string }[] = [];
  openIssue = async (repo: RepoRef, i: { title: string; body: string; labels: string[] }) => {
    const number = 100 + this.issues.length;
    this.issues.push({ repo, ...i, number });
    return { number, url: `https://github.example/${repo.owner}/${repo.name}/issues/${number}` };
  };
  comment = async (target: { repo: RepoRef; issueOrPr: number }, markdown: string) => {
    this.comments.push({ target, markdown });
    return { url: `https://github.example/${target.repo.owner}/${target.repo.name}/issues/${target.issueOrPr}#c${this.comments.length}` };
  };
}

/** Saved views; only the owner deletes one. */
export class MemoryViews implements ViewStore {
  readonly views = new Map<string, SavedView>();
  listViews = async (v: { login: string; teams: string[] }) => [...this.views.values()].filter((x) => x.owner === v.login || x.share === "org" || (x.share === "team" && x.team !== null && v.teams.includes(x.team)));
  getView = async (id: string) => this.views.get(id) ?? null;
  saveView = async (i: { id?: string; name: string; path: string; owner: string; share: SavedView["share"]; team: string | null }) => {
    const id = i.id ?? `view_${this.views.size + 1}`;
    const v: SavedView = { id, name: i.name, path: i.path, owner: i.owner, share: i.share, team: i.team, createdAt: "2026-11-14T00:00:00.000Z", updatedAt: "2026-11-14T00:00:00.000Z" };
    this.views.set(id, v);
    return v;
  };
  deleteView = async (id: string, owner: string) => (this.views.get(id)?.owner === owner ? this.views.delete(id) : false);
}

/** Rollouts with history. */
export class MemoryRollouts implements RolloutStore {
  readonly history = new Map<string, RolloutState[]>();
  rollout = async (f: string) => {
    const h = this.history.get(f) ?? [];
    const state = h.at(-1);
    return state ? { state, history: [...h].reverse() } : null;
  };
  listRollouts = async () => [...this.history.values()].flatMap((h) => h.slice(-1));
  setRollout = async (i: Omit<RolloutState, "updatedAt">) => {
    const s: RolloutState = { ...i, updatedAt: "2026-11-14T00:00:00.000Z" };
    this.history.set(i.factory, [...(this.history.get(i.factory) ?? []), s]);
    return s;
  };
}

/** The org; inbound events deduplicated on source + id. */
export class MemoryOrg implements OrgStore {
  info: OrgInfo | null = null;
  readonly repoList: ConnectedRepo[] = [];
  readonly peopleByLogin = new Map<string, Person>();
  readonly teamBySlug = new Map<string, OrgTeam>();
  readonly factoryBySlug = new Map<string, OrgFactory>();
  readonly sourceById = new Map<string, ConnectedSource>();
  readonly threads: ReplyThread[] = [];
  readonly inbound = new Map<string, InboundEvent>();
  org = async () => this.info;
  setOrg = async (v: OrgInfo) => (this.info = v);
  repos = async () => this.repoList;
  addRepo = async (v: ConnectedRepo) => {
    this.repoList.push(v);
    return v;
  };
  people = async () => [...this.peopleByLogin.values()];
  person = async (login: string) => this.peopleByLogin.get(login.toLowerCase()) ?? null;
  putPerson = async (v: Person) => {
    this.peopleByLogin.set(v.login.toLowerCase(), v);
    return v;
  };
  teams = async () => [...this.teamBySlug.values()];
  team = async (slug: string) => this.teamBySlug.get(slug) ?? null;
  putTeam = async (v: OrgTeam) => {
    this.teamBySlug.set(v.slug, v);
    return v;
  };
  factories = async () => [...this.factoryBySlug.values()];
  putFactory = async (v: OrgFactory) => {
    this.factoryBySlug.set(v.slug, v);
    return v;
  };
  sources = async () => [...this.sourceById.values()];
  putSource = async (v: ConnectedSource) => {
    this.sourceById.set(v.id, v);
    return v;
  };
  putThread = async (v: ReplyThread) => {
    this.threads.push(v);
    return v;
  };
  replies = async () => [];
  recordEvent = async (i: { event: CloudEvent; sourceId: string | null; kind: SourceKind | null; result: IntakeResult }) => {
    const key = `${i.event.source}#${i.event.id}`;
    if (this.inbound.has(key)) return false;
    this.inbound.set(key, { key, sourceId: i.sourceId, kind: i.kind, event: i.event, receivedAt: "2026-11-14T00:00:00.000Z", result: i.result });
    return true;
  };
  setEventResult = async (event: CloudEvent, result: IntakeResult) => {
    const e = this.inbound.get(`${event.source}#${event.id}`);
    if (e) this.inbound.set(e.key, { ...e, result });
  };
  events = async () => [...this.inbound.values()].reverse();
}

/** The audit log, newest first. */
export class MemoryAudit implements AuditLog {
  readonly entries: AuditEntry[] = [];
  record = async (e: Omit<AuditEntry, "id">) => {
    this.entries.unshift({ id: `aud_${this.entries.length + 1}`, ...e });
  };
  list = async (o: { limit: number; target: string | null }) => this.entries.filter((e) => o.target === null || e.target === o.target).slice(0, o.limit);
}

/** A benchmark service with a fixed suite. */
export class MemoryBench implements Bench {
  readonly suite: BenchmarkTask[] = [];
  readonly runList: BenchRunRecord[] = [];
  capture: Bench["capture"] = async () => ({ ok: false, code: "TASK_NOT_MERGED", message: "the task isn't merged" });
  tasks = async () => this.suite;
  start: Bench["start"] = async (i) => {
    if (i.arms[0].label === i.arms[1].label) return { ok: false, code: "SAME_LABELS", message: "labels must differ", id: null };
    const missing = i.taskIds.find((id) => !this.suite.some((t) => t.id === id));
    if (missing !== undefined) return { ok: false, code: "BENCHMARK_TASK_NOT_FOUND", message: "not found", id: missing };
    return { ok: false, code: "BENCHMARK_TASK_NOT_FOUND", message: "runs aren't simulated in memory", id: null };
  };
  runs = async () => this.runList;
  run = async (id: string) => this.runList.find((r) => r.id === id) ?? null;
}

/** A translator that ignores everything unless `next` is set. */
export const ignoreAll: EventTranslator = { kindOf: () => null, translate: () => ({ kind: "ignore", reason: "test translator" }) };

/** A minimal FactoryInfo for tests. */
export const testFactoryInfo: FactoryInfo = {
  version: "fv_test",
  providersFrom: "env",
  providers: {},
  agent: { name: "agent", model: "model" },
  foreman: { model: "foreman" },
  rules: { label: "factory", maxTaskUsd: 5, maxReviewRounds: 3, maxNudges: 2 },
  prompts: { system: "", intake: "", review: "", foreman: "" },
};

/** Core deps backed by memory, with every store exposed for assertions. */
/** A definitions repo that keeps proposed pull requests in memory; `down` makes the code host refuse. */
export class MemoryDefinitions implements DefinitionRepo {
  readonly proposed: { def: OrgFactory; by: string; number: number }[] = [];
  down = false;
  where(): string {
    return "acme/factory";
  }
  async proposeFactory(def: OrgFactory, by: string): Promise<Proposed> {
    if (this.down) return { ok: false, reason: "GitHub answered 503" };
    const number = this.proposed.length + 1;
    this.proposed.push({ def, by, number });
    return { ok: true, number, url: `https://github.com/acme/factory/pull/${number}` };
  }
}

export function memoryDeps(over: { definitions?: DefinitionRepo; repos?: string[]; teams?: Team[]; factories?: FactoryView[]; outcomes?: (taskId: TaskId, o: Outcome, key: string) => Promise<boolean> } = {}) {
  const tasks = new MemoryTasks();
  const runner = new MemoryRunner(tasks);
  const codeHost = new MemoryCodeHost();
  const views = new MemoryViews();
  const rollouts = new MemoryRollouts();
  const org = new MemoryOrg();
  const audit = new MemoryAudit();
  const bench = new MemoryBench();
  const outcomes: { taskId: TaskId; outcome: Outcome; key: string }[] = [];
  const seenOutcomes = new Set<string>();
  const repos = (over.repos ?? ["acme/app"]).map((r): RepoRef => {
    const [owner = "", name = ""] = r.split("/");
    return { host: "github", owner, name };
  });
  const deps: CoreDeps = {
    tasks,
    runner,
    outcomes: {
      record:
        over.outcomes ??
        (async (taskId, outcome, key) => {
          if (seenOutcomes.has(key)) return false;
          seenOutcomes.add(key);
          outcomes.push({ taskId, outcome, key });
          return true;
        }),
    },
    codeHost,
    views,
    rollouts,
    org,
    directory: { teams: async () => over.teams ?? [] },
    catalog: { info: async () => testFactoryInfo, factories: async () => over.factories ?? [{ slug: "default", extends: null, description: null, scorers: [], benchmarks: [], world: null, mergeRisk: null, teams: [] }] },
    definitions: over.definitions ?? null,
    health: { report: async () => ({ at: "2026-11-14T00:00:00.000Z", ok: true, checks: [] }) },
    bench,
    translator: ignoreAll,
    audit,
    config: { repos: () => repos, factoryLabel: "factory", mentions: true },
    now: () => "2026-11-14T00:00:00.000Z",
    log: () => {},
  };
  return { deps, tasks, runner, codeHost, views, rollouts, org, audit, bench, outcomes };
}

/** A task record in a given state, for seeding (parsed, so it's a valid record). */
export function taskRecord(over: Partial<TaskRecord> & { id: TaskId }): TaskRecord {
  return TaskRecord.parse({
    factoryVersion: "fv_test",
    source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 1, url: null },
    title: "Add CSV export",
    ask: "Add CSV export",
    status: "received",
    harness: { name: "agent", model: "model" },
    harnessSessionId: null,
    workspace: null,
    environment: null,
    branch: null,
    pr: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    people: { reviewRounds: 0, comments: 0 },
    scores: [],
    evidence: [],
    outcomes: [],
    createdAt: "2026-11-14T00:00:00.000Z",
    updatedAt: "2026-11-14T00:00:00.000Z",
    ...over,
  });
}
