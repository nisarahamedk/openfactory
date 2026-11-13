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
export interface ChatSurface {
  readonly name: string;
  post(target: { repo: RepoRef; issueOrPr: number }, markdown: string): Promise<{ url: string }>;
}

/** Repository operations the job needs outside the sandbox. */
export interface CodeHost {
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
  create(input: { taskId: TaskId; repo: RepoRef; branch: string; image: string | null }): Promise<WorkspaceHandle>;
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
});
export type ReplayResult = z.infer<typeof ReplayResult>;
