/**
 * What the application needs from the outside world. The server wires real adapters (Postgres ledger and
 * stores, the task job runner, GitHub, the benchmark service); tests wire fakes. Use cases never import a
 * vendor, a database or HTTP.
 *
 * Plugin abstractions (CodeForge, AgentHarness, Workspace...) stay in @openfactory/contracts, where providers
 * implement them. These ports are the core's own needs, usually narrower.
 */
import type {
  BenchmarkTask,
  CloudEvent,
  ConnectedRepo,
  ConnectedSource,
  EventTranslator,
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
  SentReply,
  Signal,
  SourceKind,
  TaskId,
  TaskRecord,
  TaskStatus,
  Team,
  ViewShare,
} from "@openfactory/contracts";
import type { AuditEntry, BenchRunShape, FactoryInfo, FactoryView, HealthReport, StartBenchRunShape } from "@openfactory/contract";

export type { EventTranslator };

/** Task records and their event logs (the ledger). */
export interface TaskStore {
  getTask(id: TaskId): Promise<TaskRecord | null>;
  listTasks(filter?: { status?: TaskStatus; limit?: number }): Promise<TaskRecord[]>;
  events(id: TaskId): Promise<LedgerEvent[]>;
  findByPr(repo: RepoRef, prNumber: number): Promise<TaskRecord | null>;
  findByHeadSha(repo: RepoRef, sha: string): Promise<TaskRecord | null>;
  /** Record what a task's sandbox reached; false when this window was already recorded. */
  recordEgress(taskId: TaskId, entry: { host: string; allowed: boolean; count: number; from: string; to: string }): Promise<boolean>;
  /** Record a person's message on the task's timeline (deduplicated on `key`). */
  recordMessage(taskId: TaskId, message: { author: string; text: string; url: string | null }, key: string): Promise<void>;
}

/** Runs task jobs. One queue: signals, cancels and retries never race each other for a task. */
export interface TaskRunner {
  signal(s: Signal): Promise<unknown>;
  /** Null when the task is unknown. Fails with TASK_BUSY when another server runs the task's job. */
  cancel(id: TaskId, by: string, reason: string | null): Promise<TaskRecord | null>;
  retry(id: TaskId, by: string): Promise<TaskRecord | null>;
}

/** Late outcomes: record one on a task and rescore it. False when `dedupeKey` was already recorded. */
export interface OutcomeRecorder {
  record(taskId: TaskId, outcome: Outcome, dedupeKey: string): Promise<boolean>;
}

/** Where tasks live: issues and PR comments. */
export interface CodeHost {
  openIssue(repo: RepoRef, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  comment(target: { repo: RepoRef; issueOrPr: number }, markdown: string): Promise<{ url: string }>;
}

/** Saved views (the app's dashboards). */
export interface ViewStore {
  listViews(viewer: { login: string; teams: string[] }): Promise<SavedView[]>;
  getView(id: string): Promise<SavedView | null>;
  saveView(input: { id?: string; name: string; path: string; owner: string; share: ViewShare; team: string | null }): Promise<SavedView>;
  deleteView(id: string, owner: string): Promise<boolean>;
}

/** Which factory version new tasks run on. Operational state, like a deploy: changed and rolled back here. */
export interface RolloutStore {
  rollout(factory: string): Promise<{ state: RolloutState; history: RolloutState[] } | null>;
  listRollouts(): Promise<RolloutState[]>;
  setRollout(input: Omit<RolloutState, "updatedAt">): Promise<RolloutState>;
}

/** The org as set up in the app, and what arrived from connected tools. */
export interface OrgStore {
  org(): Promise<OrgInfo | null>;
  setOrg(v: OrgInfo): Promise<OrgInfo>;
  repos(): Promise<ConnectedRepo[]>;
  addRepo(v: ConnectedRepo): Promise<ConnectedRepo>;
  people(): Promise<Person[]>;
  person(login: string): Promise<Person | null>;
  putPerson(v: Person): Promise<Person>;
  teams(): Promise<OrgTeam[]>;
  team(slug: string): Promise<OrgTeam | null>;
  putTeam(v: OrgTeam): Promise<OrgTeam>;
  factories(): Promise<OrgFactory[]>;
  putFactory(v: OrgFactory): Promise<OrgFactory>;
  sources(): Promise<ConnectedSource[]>;
  putSource(v: ConnectedSource): Promise<ConnectedSource>;
  putThread(v: ReplyThread): Promise<ReplyThread>;
  replies(limit?: number): Promise<SentReply[]>;
  /** False when this event (source + id) was seen before. */
  recordEvent(input: { event: CloudEvent; sourceId: string | null; kind: SourceKind | null; result: IntakeResult }): Promise<boolean>;
  setEventResult(event: CloudEvent, result: IntakeResult): Promise<void>;
  events(opts?: { sourceId?: string; limit?: number }): Promise<InboundEvent[]>;
}

/** Teams from the org's directory (factory.yaml, GitHub teams, SSO groups). Teams made in the app come from OrgStore. */
export interface Directory {
  teams(): Promise<Team[]>;
}

/** What this factory is, read from its configuration (factory.yaml and env). */
export interface FactoryCatalog {
  info(): Promise<FactoryInfo>;
  /** The org default and every team factory, with the teams on each. */
  factories(): Promise<FactoryView[]>;
}

/** A proposed change to the definitions repo: the pull request, or why the code host refused. */
export type Proposed = { ok: true; number: number; url: string } | { ok: false; reason: string };

/**
 * Factory definitions as code: a git repo that holds each team factory as a file. The app proposes changes as
 * pull requests; a definition takes effect when the PR merges and the server syncs it into OrgStore.
 * Rollout state (live, candidate, share) is not here: it stays a database record, like a deploy.
 */
export interface DefinitionRepo {
  /** Where definitions live, as owner/name, for messages. */
  where(): string;
  /** Open a pull request that writes this factory's definition. */
  proposeFactory(def: OrgFactory, by: string): Promise<Proposed>;
}

/** The latest start-up checks. */
export interface HealthCheck {
  report(): Promise<HealthReport>;
}

/** Benchmark suite and A-vs-B runs. Expected failures come back as values. */
export interface Bench {
  capture(taskId: TaskId): Promise<{ ok: true; task: BenchmarkTask; files: string[] } | { ok: false; code: "TASK_NOT_FOUND" | "TASK_NOT_MERGED" | "NO_CHECK"; message: string }>;
  tasks(): Promise<BenchmarkTask[]>;
  start(input: StartBenchRunInput): Promise<{ ok: true; run: BenchRunRecord } | { ok: false; code: "BENCHMARK_TASK_NOT_FOUND" | "SAME_LABELS"; message: string; id: string | null }>;
  runs(): Promise<BenchRunRecord[]>;
  run(id: string): Promise<BenchRunRecord | null>;
}

/** The benchmark run shape, as the contract defines it. */
export type BenchRunRecord = BenchRunShape;
/** The start-run input, as the contract defines it. */
export type StartBenchRunInput = StartBenchRunShape;

/** Every state-changing call, with who made it. */
export interface AuditLog {
  record(entry: Omit<AuditEntry, "id">): Promise<void>;
  list(opts: { limit: number; target: string | null }): Promise<AuditEntry[]>;
}

/** Everything the use cases need, wired by the composition root. */
export interface CoreDeps {
  tasks: TaskStore;
  runner: TaskRunner;
  outcomes: OutcomeRecorder;
  codeHost: CodeHost;
  views: ViewStore;
  rollouts: RolloutStore;
  org: OrgStore;
  directory: Directory;
  catalog: FactoryCatalog;
  /** Null when definitions are saved directly to OrgStore (no definitions repo configured). */
  definitions: DefinitionRepo | null;
  health: HealthCheck;
  /** Null when benchmarks aren't set up (no BENCH_DIR). */
  bench: Bench | null;
  translator: EventTranslator;
  audit: AuditLog;
  config: {
    /** Repos the factory works in (FACTORY_REPOS), as owner/name. */
    repos: () => RepoRef[];
    factoryLabel: string;
    /** Off for simulated orgs, whose made-up logins may belong to real people on the code host. */
    mentions: boolean;
  };
  /** ISO time now. */
  now: () => string;
  log: (msg: string, fields?: object) => void;
}
