import type { LedgerEvent, TaskRecord } from "@openfactory/contracts";

const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** A task record with sensible defaults; override any field. */
export function fixtureRecord(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_fixture1",
    factoryVersion: "fv_fixture",
    source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 7, url: "https://github.com/acme/app/issues/7" },
    title: "Add CSV export",
    ask: "Users want to export their list as CSV.",
    status: "merged",
    harness: { name: "claude-code", model: "sonnet" },
    harnessSessionId: "sess_1",
    environment: { plugin: "devspace", name: "task-7" },
    workspace: { plugin: "k8s", id: "ws-7" },
    branch: "factory/task_fixture1",
    pr: { number: 12, url: "https://github.com/acme/app/pull/12", headSha: "bbb2222" },
    usage: { inputTokens: 120_000, outputTokens: 9_000, costUsd: 1.37 },
    people: { comments: 2, reviewRounds: 1 },
    evidence: [],
    scores: [],
    outcomes: [],
    createdAt: at(0),
    updatedAt: at(60),
    ...over,
  };
}

const ev = (taskId: string, min: number, type: string, data: Record<string, unknown>): LedgerEvent => ({ taskId, at: at(min), type, data });

/** A full event log for a task that was worked, reviewed once, and merged. */
export function fixtureMergedLog(taskId = "task_fixture1"): LedgerEvent[] {
  return [
    ev(taskId, 0, "task_created", {}),
    ev(taskId, 1, "status_changed", { from: "received", to: "preparing" }),
    ev(taskId, 3, "status_changed", { from: "preparing", to: "working" }),
    ev(taskId, 4, "turn_started", { reason: "intake" }),
    ev(taskId, 20, "turn_finished", { reason: "intake", usage: { inputTokens: 80_000, outputTokens: 6_000, costUsd: 0.9 }, stopReason: "end_turn" }),
    ev(taskId, 20, "pr_opened", { number: 12, url: "https://github.com/acme/app/pull/12", headSha: "aaa1111" }),
    ev(taskId, 20, "status_changed", { from: "working", to: "awaiting_review" }),
    ev(taskId, 25, "ci_completed", { headSha: "aaa1111", conclusion: "failure", name: "test" }),
    ev(taskId, 40, "comment_received", { author: "reviewer", isBot: false, on: "pr" }),
    ev(taskId, 40, "review_round_started", { comments: 1 }),
    ev(taskId, 40, "status_changed", { from: "awaiting_review", to: "iterating" }),
    ev(taskId, 41, "turn_started", { reason: "review" }),
    ev(taskId, 50, "turn_finished", { reason: "review", usage: { inputTokens: 40_000, outputTokens: 3_000, costUsd: 0.47 }, stopReason: "end_turn" }),
    ev(taskId, 50, "pushed", { sha: "bbb2222" }),
    ev(taskId, 50, "status_changed", { from: "iterating", to: "awaiting_review" }),
    ev(taskId, 55, "ci_completed", { headSha: "bbb2222", conclusion: "success", name: "test" }),
    ev(taskId, 60, "status_changed", { from: "awaiting_review", to: "merged" }),
  ];
}

/** Records and logs every conformance suite runs a subject against. */
export function standardCases(): Array<{ label: string; record: TaskRecord; events: LedgerEvent[] }> {
  return [
    { label: "merged with a full log", record: fixtureRecord(), events: fixtureMergedLog() },
    { label: "just received, no events", record: fixtureRecord({ status: "received", pr: null, branch: null, people: { comments: 0, reviewRounds: 0 }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }), events: [] },
    { label: "failed before a PR", record: fixtureRecord({ status: "failed", pr: null }), events: fixtureMergedLog().slice(0, 4) },
    { label: "awaiting review", record: fixtureRecord({ status: "awaiting_review" }), events: fixtureMergedLog().slice(0, 8) },
    {
      label: "malformed event data",
      record: fixtureRecord(),
      events: [
        { taskId: "task_fixture1", at: at(1), type: "ci_completed", data: { conclusion: 3 } },
        { taskId: "task_fixture1", at: at(2), type: "status_changed", data: {} },
        { taskId: "task_fixture1", at: at(3), type: "unknown_kind", data: { x: [1, 2] } },
      ],
    },
  ];
}

/** Recursively freeze a value so a subject that mutates its input throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
