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

export const Evidence = z.object({
  kind: z.enum(["screenshot", "video", "test-output", "log", "link"]),
  title: z.string(),
  url: z.string(), // where a reviewer can open it
  commitSha: z.string(), // the commit the evidence was produced against
  environment: z.string(), // e.g. "devspace:task-12"
  createdAt: z.string(),
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
  kind: z.enum(["merged", "reverted", "incident_linked", "hotfix", "rework", "closed_unmerged"]),
  source: z.string(), // e.g. "github", "dxfake"
  detail: z.string(),
  at: z.string(), // when it happened
  arrivedAt: z.string(), // when we learned it (late outcomes arrive late)
});
export type Outcome = z.infer<typeof Outcome>;

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
  pr: z.object({ number: z.number().int(), url: z.string(), headSha: z.string().nullable() }).nullable(),
  usage: Usage,
  people: z.object({
    comments: z.number().int().nonnegative(),
    reviewRounds: z.number().int().nonnegative(),
  }),
  evidence: z.array(Evidence),
  scores: z.array(Score),
  outcomes: z.array(Outcome),
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
export interface SignalSource {
  readonly name: string;
  start(onSignal: (signal: Signal) => Promise<void>): Promise<{ stop(): Promise<void> }>;
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
  pullRequestStats?(repo: RepoRef, number: number): Promise<{ headSha: string; additions: number; deletions: number; changedFiles: number }>;
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
