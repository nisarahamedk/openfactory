/**
 * @openfactory/contracts — the shapes every part of the factory agrees on.
 *
 * Three groups:
 *  1. The ledger record: one per task, kept up to date long after the merge.
 *  2. Signals: what wakes a task (issue labelled, review comment, merge, CI).
 *  3. Plugin interfaces: chat, code host, agent harness, workspace, environment,
 *     metrics sink, scorer. Core code depends only on these, never on a vendor.
 *
 * Rule: a plugin parses vendor payloads at its edge and only ever hands the core
 * values that passed these schemas.
 */
import { z } from "zod";

// ───────────────────────────── ids and small values ─────────────────────────────

export const TaskId = z.string().regex(/^task_[a-z0-9]+$/);
export type TaskId = z.infer<typeof TaskId>;

/** Content hash of the factory definition (factory.yaml + agents/ + skills/ ...). */
export const FactoryVersion = z.object({
  id: z.string(), // e.g. "fv_3f2a9c"
  label: z.string().nullable(), // human label, e.g. "v14 old-order skill"
  createdAt: z.string(),
});
export type FactoryVersion = z.infer<typeof FactoryVersion>;

export const RepoRef = z.object({
  host: z.literal("github"),
  owner: z.string(),
  name: z.string(),
});
export type RepoRef = z.infer<typeof RepoRef>;

export const Money = z.object({ usd: z.number().nonnegative() });

// ───────────────────────────── the ledger record ─────────────────────────────

export const TaskStatus = z.enum([
  "received", // signal accepted, nothing started
  "preparing", // env + workspace coming up
  "working", // a harness turn is running
  "awaiting_review", // PR open with evidence, job asleep
  "iterating", // review feedback being addressed
  "merged",
  "closed", // closed without merge
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** A test user the agent left in a given state in its environment, so a reviewer can log in and see the feature. */
export const TestUser = z.object({
  role: z.string(), // e.g. "owner on the Pro plan"
  state: z.string(), // e.g. "trial ends tomorrow, 3 missed calls"
  loginUrl: z.string(), // a sign-in link into the task's (non-production) environment
});
export type TestUser = z.infer<typeof TestUser>;

export const Evidence = z.object({
  kind: z.enum(["screenshot", "video", "test-output", "log", "link", "test-user"]),
  title: z.string(),
  url: z.string(), // where a reviewer can open it (for test-user: the login link)
  commitSha: z.string(), // the commit the evidence was produced against
  environment: z.string(), // e.g. "devspace:task-12"
  createdAt: z.string(),
  testUser: TestUser.optional(), // kind "test-user" only
  repo: z.string().optional(), // "owner/name" when the task spans several repos
});
export type Evidence = z.infer<typeof Evidence>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type Usage = z.infer<typeof Usage>;

export const Score = z.object({
  scorer: z.string(), // e.g. "facts.review_rounds"
  scorerVersion: z.string(),
  value: z.number(), // normalised where it makes sense; raw count otherwise
  label: z.string().nullable(), // e.g. "pass", "2 rounds"
  reason: z.string(),
  at: z.string(),
});
export type Score = z.infer<typeof Score>;

/** Something that happened after the work: revert, incident, rework, follow-up fix. */
export const Outcome = z.object({
  kind: z.enum(["merged", "reverted", "incident_linked", "hotfix", "rework", "deployed", "closed_unmerged"]),
  source: z.string(), // e.g. "github", "dxfake"
  detail: z.string(),
  at: z.string(), // when it happened
  arrivedAt: z.string(), // when we learned it (late outcomes arrive late)
});
export type Outcome = z.infer<typeof Outcome>;

/** One OpenWorld run of a PR head: the change deployed into a simulated world for `simDays` days. */
export const WorldCheckResult = z.object({
  world: z.string(),
  headSha: z.string(),
  simDays: z.number(),
  status: z.enum(["passed", "failed", "error"]),
  startedAt: z.string(),
  finishedAt: z.string(),
  /** Rules the world checks hold the whole time (money conserved, no 5xx spike...). */
  invariants: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string() })),
  metrics: z.array(z.object({ name: z.string(), value: z.number(), unit: z.string() })),
  reportUrl: z.string().nullable(),
});
export type WorldCheckResult = z.infer<typeof WorldCheckResult>;
export const PrRef = z.object({ number: z.number().int(), url: z.string(), headSha: z.string().nullable() });
export type PrRef = z.infer<typeof PrRef>;

/** One repo in a task's scope. The first entry is the task's own repo (source.repo, `branch`, `pr`). */
export const TaskRepo = z.object({ repo: RepoRef, branch: z.string().nullable(), pr: PrRef.nullable() });
export type TaskRepo = z.infer<typeof TaskRepo>;

/** How risky merging the PR at `headSha` looks, from rules over size, paths, CI and evidence. */
export const MergeRisk = z.object({
  level: z.enum(["low", "medium", "high"]),
  reasons: z.array(z.string()),
  headSha: z.string(),
});
export type MergeRisk = z.infer<typeof MergeRisk>;

export const TaskRecord = z.object({
  id: TaskId,
  factoryVersion: z.string(),
  source: z.object({
    kind: z.enum(["github_issue", "api", "benchmark_replay"]),
    repo: RepoRef,
    issueNumber: z.number().int().nullable(),
    url: z.string().nullable(),
  }),
  title: z.string(),
  ask: z.string(),
  status: TaskStatus,
  harness: z.object({ name: z.string(), model: z.string() }),
  harnessSessionId: z.string().nullable(), // reused across review rounds
  environment: z.object({ plugin: z.string(), name: z.string() }).nullable(),
  workspace: z.object({ plugin: z.string(), id: z.string() }).nullable(),
  branch: z.string().nullable(),
  pr: PrRef.nullable(),
  /** Every repo the task works in, primary first (one PR per repo). Older records: empty. */
  repos: z.array(TaskRepo).optional(),
  /** Which factory version arm served this task when a candidate version is rolling out. */
  versionArm: z.enum(["stable", "candidate"]).nullable().optional(),
  /** The latest merge-risk assessment of the primary PR. */
  risk: MergeRisk.nullable().optional(),
  usage: Usage,
  people: z.object({
    comments: z.number().int().nonnegative(),
    reviewRounds: z.number().int().nonnegative(),
  }),
  evidence: z.array(Evidence),
  scores: z.array(Score),
  outcomes: z.array(Outcome),
  /** Who asked for the task (code-host login), when known. Optional: older records predate it. */
  requestedBy: z.string().nullable().optional(),
  /** The factory (org default or a team factory) this task runs on. */
  factory: z.string().optional(),
  /** Labels on the issue when the task started. */
  labels: z.array(z.string()).optional(),
  /** OpenWorld runs of the PR's heads, oldest first. */
  worldChecks: z.array(WorldCheckResult).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskRecord = z.infer<typeof TaskRecord>;

/** Append-only event log; the record above is a projection of these. */
export const LedgerEvent = z.object({
  taskId: TaskId,
  at: z.string(),
  type: z.string(), // e.g. "status_changed", "turn_finished", "evidence_added"
  data: z.record(z.string(), z.unknown()),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;

// ───────────────────────────── signals ─────────────────────────────

const SignalBase = z.object({
  id: z.string(), // provider delivery id, used for de-duplication
  repo: RepoRef,
  at: z.string(),
  actor: z.object({ login: z.string(), isBot: z.boolean() }),
});

export const Signal = z.discriminatedUnion("type", [
  SignalBase.extend({
    type: z.literal("issue_labeled"),
    issueNumber: z.number().int(),
    label: z.string(),
    title: z.string(),
    body: z.string(),
    /** Every label on the issue when it was labelled (used for model routing). */
    labels: z.array(z.string()).optional(),
  }),
  SignalBase.extend({ type: z.literal("issue_comment"), issueNumber: z.number().int(), body: z.string() }),
  SignalBase.extend({
    type: z.literal("pr_review_comment"),
    prNumber: z.number().int(),
    body: z.string(),
    path: z.string().nullable(),
  }),
  SignalBase.extend({ type: z.literal("pr_merged"), prNumber: z.number().int(), mergeSha: z.string() }),
  SignalBase.extend({ type: z.literal("pr_closed"), prNumber: z.number().int() }),
  SignalBase.extend({
    type: z.literal("ci_completed"),
    headSha: z.string(),
    conclusion: z.enum(["success", "failure", "cancelled", "neutral", "skipped", "timed_out", "action_required"]),
    name: z.string(),
  }),
]);
export type Signal = z.infer<typeof Signal>;

// ───────────────────────────── plugin interfaces ─────────────────────────────

/** Where signals come from. `start` calls `onSignal` with parsed signals only. */
/** Where a signal source got to, kept by the factory (Postgres) so a restart catches up instead of guessing. */
export interface CursorStore {
  cursor(key: string): Promise<string | null>;
  setCursor(key: string, at: string): Promise<void>;
}

export interface SignalSource {
  readonly name: string;
  start(onSignal: (signal: Signal) => Promise<void>, opts?: { cursors?: CursorStore }): Promise<{ stop(): Promise<void> }>;
}

/**
 * Every message the factory posts carries this marker, so a factory that posts with a person's token
 * (a PAT instead of a bot account) still never wakes itself.
 */
export const FACTORY_MARKER = "<!-- openfactory -->";

/** Talking to people where the task started (issue, PR, chat thread). Implementations append FACTORY_MARKER. */
export interface Chat {
  readonly name: string;
  post(target: { repo: RepoRef; issueOrPr: number }, markdown: string): Promise<{ url: string }>;
}

/** @deprecated Use CodeForge. Kept one release for open branches. */
export type CodeHost = CodeForge;
/** @deprecated Use Chat. */
export type ChatSurface = Chat;

/** Repository operations the job needs outside the sandbox (branches, PRs, push credentials). */
export interface CodeForge {
  readonly name: string;
  openPullRequest(input: {
    repo: RepoRef;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
  findPullRequestForBranch(repo: RepoRef, branch: string): Promise<{ number: number; url: string; headSha: string } | null>;
  /** Short-lived token the sandbox may use to push to one repo. */
  mintPushToken(repo: RepoRef): Promise<{ token: string; expiresAt: string }>;
  /** Size of a PR at its current head (optional; used for cost-per-PR-by-size). */
  pullRequestStats?(
    repo: RepoRef,
    number: number,
  ): Promise<{ headSha: string; additions: number; deletions: number; changedFiles: number; files?: string[] }>;
  /** Replace the PR's labels that start with `prefix` by `labels` (optional; used for the merge-risk label). */
  setPrefixedLabels?(repo: RepoRef, number: number, prefix: string, labels: string[]): Promise<void>;
}

export const TurnResult = z.object({
  stopReason: z.enum(["end_turn", "max_tokens", "cancelled", "refusal", "error"]),
  summary: z.string(), // the agent's final message for this turn
  usage: Usage,
});
export type TurnResult = z.infer<typeof TurnResult>;

export type AgentUpdate =
  | { kind: "message"; text: string }
  | { kind: "tool_call"; title: string; status: "pending" | "in_progress" | "completed" | "failed" }
  | { kind: "plan"; entries: string[] };

/** A stdio MCP server started inside the workspace (ACP `McpServerStdio`). */
export const McpServer = z.object({ name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}) });
export type McpServer = z.infer<typeof McpServer>;

export const Effort = z.enum(["low", "medium", "high", "max"]);
export type Effort = z.infer<typeof Effort>;

/**
 * What a factory version gives the agent beyond the base prompts: the parts a factory engineer varies and
 * A/B tests. Model routing is versioned beside it (factory.yaml `versions.<id>.models`).
 */
export const VersionBundle = z.object({
  /** Extra system-prompt text. */
  prompt: z.string().optional(),
  /** Extra AGENTS.md guidance, written to CLAUDE.local.md in the checkout (never committed). */
  agentsMd: z.string().optional(),
  /** Skills written to .claude/skills/<name>/SKILL.md in the checkout. */
  skills: z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), description: z.string().min(1).max(1024), body: z.string() })).default([]),
  /** MCP servers for the session. */
  mcp: z.array(McpServer).default([]),
  /** Reasoning effort for the agent. */
  effort: Effort.optional(),
  /** Index the repo with CodeGraph and give the agent its MCP tool (fewer tokens spent reading files). */
  codegraph: z.boolean().default(false),
});
export type VersionBundle = z.infer<typeof VersionBundle>;

/** A coding agent (Claude Code, Codex, Copilot CLI, Pi...) reached over ACP or natively. */
export interface AgentHarness {
  readonly name: string; // e.g. "claude-code"
  readonly model: string;
  /** Start a new session, or resume `resumeSessionId` (same conversation across review rounds). */
  openSession(input: {
    workspace: WorkspaceHandle;
    cwd: string;
    systemPrompt: string;
    resumeSessionId: string | null;
    /** Extra environment for the agent process (environment handle vars, model proxy URL...). */
    env?: Record<string, string>;
    /** The task's model, when it differs from the harness default (model routing). */
    model?: string;
    /** MCP servers the agent gets for this session (the factory version's tools). */
    mcpServers?: McpServer[];
    /** Reasoning effort, when the factory version sets one. */
    effort?: Effort;
  }): Promise<AgentSession>;
}

export interface AgentSession {
  readonly sessionId: string;
  prompt(text: string, onUpdate: (u: AgentUpdate) => void): Promise<TurnResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/** Where the agent's tools run (a sandbox pod, a container, a VM). */
export interface Workspace {
  readonly name: string;
  /**
   * Clone `repo` and check out `branch` (made from `startRef` when given, e.g. a
   * benchmark's start commit; else from the remote branch or the default branch).
   */
  create(input: { taskId: TaskId; repo: RepoRef; branch: string; image: string | null; startRef?: string | null }): Promise<WorkspaceHandle>;
  get(id: string): Promise<WorkspaceHandle | null>;
}

export interface WorkspaceHandle {
  readonly id: string;
  readonly repoPath: string; // absolute path of the checkout inside the workspace
  exec(cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  /** Spawn a long-lived process with stdio pipes (used to run an ACP agent). */
  spawn(cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<{
    stdin: WritableStream<Uint8Array>;
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(): Promise<void>;
  }>;
  writeFile(path: string, content: string): Promise<void>;
  sleep(): Promise<void>;
  wake(): Promise<void>;
  destroy(): Promise<void>;
}

/** The running product the agent deploys to and tests against. */
export interface Environment {
  readonly name: string; // e.g. "devspace"
  create(input: { taskId: TaskId; repo: RepoRef }): Promise<EnvironmentHandle>;
  get(name: string): Promise<EnvironmentHandle | null>;
}

export interface EnvironmentHandle {
  readonly name: string; // e.g. "task-12"
  /** Files to place in the workspace so the agent can use the env (kubeconfig, skill file). */
  credentialsForWorkspace(): Promise<Array<{ path: string; content: string }>>;
  /** Environment variables to give the agent (service URLs, KUBECONFIG path...). */
  envVars(): Promise<Record<string, string>>;
  /** Markdown telling the agent how to deploy, test and read logs here. */
  skill(): Promise<string>;
  sleep(): Promise<void>;
  wake(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Model access for agents (LiteLLM, Bedrock, Portkey...). Each task gets its
 * own credentials with its own budget, so one runaway task can't spend the
 * factory's budget, and the org's real key never enters a sandbox.
 */
export interface ModelGateway {
  readonly name: string;
  /**
   * Env vars the agent process needs for this task (base URL and per-task key).
   * Safe to call again: the same task gets the same credentials.
   */
  forTask(taskId: TaskId, budget: { usd: number }): Promise<Record<string, string>>;
  /** What the task has spent, as the gateway counts it; null when it doesn't know. */
  spend(taskId: TaskId): Promise<{ usd: number } | null>;
  /** Stops the task's credentials working. Safe to call twice. */
  revoke(taskId: TaskId): Promise<void>;
}

/** What a caller asks Secrets to issue. Short-lived where the provider can; static otherwise. */
export type SecretRequest = { kind: "git"; repo: RepoRef; access: "read" | "write" };

export interface IssuedSecret {
  value: string;
  /** null when the provider can only hand out a long-lived value (its README says so). */
  expiresAt: string | null;
}

/** Where the factory's own credentials come from (Infisical, Vault, cloud secret managers, k8s Secrets). */
export interface Secrets {
  readonly name: string;
  /** A named secret. Throws SecretNotFound when it doesn't exist. */
  get(name: string): Promise<string>;
  /** A credential for one purpose and scope, e.g. a push token for one repo. */
  issue(request: SecretRequest): Promise<IssuedSecret>;
}

/** The secret does not exist in the provider. */
export class SecretNotFound extends Error {
  readonly code = "secret_not_found" as const;
  constructor(
    readonly secretName: string,
    readonly provider: string,
  ) {
    super(`Secret ${secretName} not found in ${provider}`);
  }
}

/**
 * A scorer reads one task record (plus its event log, for timing and CI facts)
 * and returns a score, or null if it doesn't apply yet.
 */
export interface Scorer {
  readonly name: string;
  readonly version: string;
  score(record: TaskRecord, events: LedgerEvent[], now: string): Score | null;
}

/** Where rows go for org dashboards (fake DX, DevLake, OTel...). */
export interface MetricsSink {
  readonly name: string;
  writeTasks(records: TaskRecord[]): Promise<void>;
}

/** One late outcome for one task, as an OutcomeSource reports it. */
export interface FoundOutcome {
  taskId: TaskId;
  outcome: Outcome;
  /** Stable id of the thing found (revert PR, incident id, deploy id). The ledger dedupes on source + task + kind + ref. */
  ref: string;
}

/**
 * What happened after the merge: reverts, follow-up fixes, incidents, deploys (GitHub, an incident tool,
 * a metrics platform). Polled on a schedule with every task merged inside the watch window, so a source
 * can fetch once per repo. Returning something already recorded is fine: the ledger dedupes by `ref`.
 */
export interface OutcomeSource {
  readonly name: string;
  poll(merged: MergedTask[], now: string): Promise<FoundOutcome[]>;
}

/** A merged task with the facts outcome sources match on. */
export interface MergedTask {
  record: TaskRecord;
  mergeSha: string | null;
  mergedAt: string;
}

/** The merge facts of a task, from its `merged` outcome (detail "merge <sha>"). Null when it isn't merged. */
export function mergeOf(record: TaskRecord): MergedTask | null {
  const m = record.outcomes.find((o) => o.kind === "merged");
  if (!m) return null;
  const sha = /\bmerge ([0-9a-f]{7,40})\b/.exec(m.detail)?.[1] ?? null;
  return { record, mergeSha: sha, mergedAt: m.at };
}

/**
 * OpenWorld check: deploy a PR head into the team's simulated world, run `simDays` of traffic, report the
 * invariants. The task job calls it once per settled PR head and records a `world_check` event.
 */
export interface WorldCheck {
  readonly name: string;
  run(input: { task: TaskRecord; repo: RepoRef; headSha: string; world: string; simDays: number }, signal?: AbortSignal): Promise<WorldCheckResult>;
}

// ───────────────────────────── people and teams ─────────────────────────────

export const TeamMember = z.object({ login: z.string(), name: z.string().nullable(), role: z.enum(["member", "maintainer"]) });
export type TeamMember = z.infer<typeof TeamMember>;

/** A team as the org already defines it (GitHub team, SSO group). The factory never invents teams. */
export const Team = z.object({
  slug: z.string(),
  name: z.string(),
  /** Where the team comes from, e.g. "github:acme/payments" or "config". */
  source: z.string(),
  members: z.array(TeamMember),
  /** Repos the team owns ("owner/name"), from the directory, CODEOWNERS or config. */
  repos: z.array(z.string()),
  /** The factory the team's tasks run on ("default" unless the team has its own). */
  factory: z.string(),
});
export type Team = z.infer<typeof Team>;

/**
 * The team a task belongs to: the asker's team first (people move between repos), else the team that
 * owns the task's repo. Null when neither is known.
 */
export function teamFor(teams: readonly Team[], task: { requestedBy?: string | null | undefined; repo: RepoRef }): Team | null {
  const who = task.requestedBy?.toLowerCase();
  const byPerson = who ? teams.find((t) => t.members.some((m) => m.login.toLowerCase() === who)) : undefined;
  const repo = `${task.repo.owner}/${task.repo.name}`.toLowerCase();
  return byPerson ?? teams.find((t) => t.repos.some((r) => r.toLowerCase() === repo)) ?? null;
}

/** The factory a task runs on: its team's factory, else the org default. */
export const factoryFor = (teams: readonly Team[], task: { requestedBy?: string | null | undefined; repo: RepoRef }): string => teamFor(teams, task)?.factory ?? "default";

/** Teams and their people, from the org's directory (GitHub teams, SCIM groups, or factory.yaml). */
export interface Directory {
  readonly name: string;
  teams(): Promise<Team[]>;
}

// ───────────────────────────── app state ─────────────────────────────

export const ViewShare = z.enum(["me", "team", "org", "link"]);
export type ViewShare = z.infer<typeof ViewShare>;

/** A saved view: a name plus the app URL that holds its scope, filters, measure and grouping. */
export const SavedView = z.object({
  id: z.string(),
  name: z.string().min(1).max(120),
  /** App path with its query string, e.g. "/insights?scope=team:payments&measure=came_back&by=kind". */
  path: z.string().startsWith("/").max(2000),
  owner: z.string(),
  share: ViewShare,
  /** The team it is shared with when share is "team". */
  team: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedView = z.infer<typeof SavedView>;

export const RolloutState = z.object({
  factory: z.string(),
  /** Version new tasks run on. Null: whatever the server is running. */
  live: z.string().nullable(),
  /** A version under trial, and the share of new tasks it gets (0 to 1). */
  candidate: z.string().nullable(),
  share: z.number().min(0).max(1),
  updatedBy: z.string(),
  updatedAt: z.string(),
  note: z.string().nullable(),
});
export type RolloutState = z.infer<typeof RolloutState>;

/** Read access to the ledger, for scorers, the dashboard and benchmarks. */
export interface LedgerReader {
  getTask(id: TaskId): Promise<TaskRecord | null>;
  listTasks(filter?: { status?: TaskStatus; limit?: number }): Promise<TaskRecord[]>;
  events(id: TaskId): Promise<LedgerEvent[]>;
}

// ───────────────────────────── providers ─────────────────────────────

/** The environment the agent deploys to and tests against (the plugins doc's name for `Environment`). */
export type DevEnvironment = Environment;

/** Every pluggable abstraction, by the key used in factory.yaml `providers:`. Rules, ledger and task job are core. */
export type Abstractions = {
  codeForge: CodeForge;
  signals: SignalSource;
  chat: Chat;
  agent: AgentHarness;
  workspace: Workspace;
  devEnvironment: Environment;
  metrics: MetricsSink;
  modelGateway: ModelGateway;
  secrets: Secrets;
  evidence: EvidenceStore;
  /** Not in ABSTRACTION_KEYS: a factory has several, listed under factory.yaml `outcomes.sources`. */
  outcomes: OutcomeSource;
  /** Not in ABSTRACTION_KEYS: configured under factory.yaml `teams:`. */
  directory: Directory;
  /** Not in ABSTRACTION_KEYS: configured under factory.yaml `world:`. */
  worldCheck: WorldCheck;
};
export type AbstractionKey = keyof Abstractions;
export const ABSTRACTION_KEYS = [
  "codeForge",
  "signals",
  "chat",
  "agent",
  "workspace",
  "devEnvironment",
  "metrics",
  "modelGateway",
  "secrets",
  "evidence",
] as const satisfies readonly AbstractionKey[];

export interface ProviderContext {
  /** Options for this provider from factory.yaml (`codeForge: { github: { ... } }`), or {} . */
  options: Record<string, unknown>;
  /** Process env, for secrets and env-var fallbacks. Providers read their own variables. */
  env: Record<string, string | undefined>;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * A provider package exports `provider: Provider`. One provider may implement several abstractions
 * (the github provider gives codeForge, signals and chat). It is named after the vendor or protocol.
 */
export interface Provider {
  readonly name: string;
  readonly provides: { [K in AbstractionKey]?: (ctx: ProviderContext) => Abstractions[K] | Promise<Abstractions[K]> };
}

export function defineProvider(p: Provider): Provider {
  return p;
}

// ───────────────────────────── benchmarks ─────────────────────────────

/** A task captured from real work, replayable under any factory version. */
export const BenchmarkTask = z.object({
  id: z.string(),
  sourceTaskId: TaskId,
  repo: RepoRef,
  startCommit: z.string(),
  ask: z.string(),
  /** Hidden from the agent: how a replay is judged. */
  check: z.object({
    kind: z.enum(["tests_from_merged_pr", "command"]),
    command: z.array(z.string()), // run in the workspace after the agent finishes
    files: z.record(z.string(), z.string()), // test files copied in before the check runs
    /**
     * World check: deploy the attempt into a fresh DevEnvironment and run these tests
     * against the running product. Null when the task has none (or was captured before).
     */
    world: z
      .object({ command: z.array(z.string()), files: z.record(z.string(), z.string()) })
      .nullable()
      .default(null),
  }),
  createdAt: z.string(),
});
export type BenchmarkTask = z.infer<typeof BenchmarkTask>;

export const ReplayResult = z.object({
  benchmarkTaskId: z.string(),
  factoryVersion: z.string(),
  attempt: z.number().int(),
  passed: z.boolean(),
  usage: Usage,
  durationMs: z.number().int(),
  notes: z.string(),
  /** Each check on its own; `passed` is all of them. world is null when not run. */
  checks: z.object({ repo: z.boolean(), world: z.boolean().nullable() }).nullable().default(null),
});
export type ReplayResult = z.infer<typeof ReplayResult>;

// ───────────────────────────── evidence ─────────────────────────────

/** A stored evidence file as read back from an EvidenceStore. */
export type StoredEvidence = { bytes: Uint8Array; contentType: string };

/**
 * Where evidence files (screenshots, videos, logs, transcripts) are kept and served from.
 * Keys are `<taskId>/<name>`; names are `[A-Za-z0-9._-]{1,200}`. Providers: disk, any S3-API store.
 */
export interface EvidenceStore {
  readonly name: string;
  /** Store bytes under `<taskId>/<name>`, replacing any earlier file of that name. */
  put(taskId: string, name: string, bytes: Uint8Array, contentType: string): Promise<{ key: string; url: string }>;
  /** Read a stored file back, or null if there is none. Invalid keys read as null. */
  get(key: string): Promise<StoredEvidence | null>;
  /** The URL a reviewer opens for this key (does not check that it exists). */
  url(key: string): string;
}

const EVIDENCE_NAME = /^[A-Za-z0-9._-]{1,200}$/;

/** Build and validate an evidence key; throws on names that could escape the task's folder. */
export function evidenceKey(taskId: string, name: string): string {
  if (!EVIDENCE_NAME.test(taskId) || !EVIDENCE_NAME.test(name) || name === "." || name === ".." || taskId === "." || taskId === "..")
    throw new Error(`invalid evidence name: ${taskId}/${name}`);
  return `${taskId}/${name}`;
}

/** Split and validate a key; null when it isn't a valid `<taskId>/<name>`. */
export function parseEvidenceKey(key: string): { taskId: string; name: string } | null {
  const parts = key.split("/");
  if (parts.length !== 2) return null;
  const [taskId = "", name = ""] = parts;
  try {
    evidenceKey(taskId, name);
    return { taskId, name };
  } catch {
    return null;
  }
}

// ───────────────────────────── org setup and inbound events ─────────────────────────────
export * from "./org.js";
