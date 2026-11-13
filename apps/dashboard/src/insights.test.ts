import { describe, expect, it } from "vitest";
import type { LedgerEvent, TaskRecord } from "@openfactory/contracts";
import { costBySize, filterTasks, inbox, insights, median, parseFilter, taskFacts, turns } from "./insights.js";

const base = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  factoryVersion: "fv_1",
  source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 1, url: null },
  title: id,
  ask: "",
  status: "merged",
  harness: { name: "claude-code", model: "sonnet" },
  harnessSessionId: null,
  environment: null,
  workspace: null,
  branch: null,
  pr: { number: 1, url: "u", headSha: "h2" },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 1 },
  people: { comments: 0, reviewRounds: 0 },
  evidence: [],
  scores: [],
  outcomes: [],
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T05:00:00Z",
  ...over,
});
const ev = (type: string, at: string, data: Record<string, unknown> = {}): LedgerEvent => ({ taskId: "task_x", at, type, data });
const NOW = "2026-11-13T00:00:00Z";

describe("insights", () => {
  it("pairs turns, keeps a running turn open, and reads usage", () => {
    const r = turns([
      ev("turn_started", "2026-11-10T00:00:00Z", { reason: "intake" }),
      ev("turn_finished", "2026-11-10T00:10:00Z", { reason: "intake", usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.5 }, stopReason: "end_turn" }),
      ev("turn_started", "2026-11-10T01:00:00Z", { reason: "review" }),
    ]);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ n: 1, durationS: 600, usage: { costUsd: 0.5 }, stopReason: "end_turn" });
    expect(r[1]).toMatchObject({ n: 2, reason: "review", finishedAt: null });
  });

  it("task facts: first human PR comment, CI on head, PR size, human pushes, cancel", () => {
    const f = taskFacts(base("task_x", { status: "awaiting_review" }), [
      ev("comment_received", "2026-11-10T00:30:00Z", { isBot: false, on: "pr" }), // before the PR: ignored
      ev("pr_opened", "2026-11-10T01:00:00Z", { number: 1 }),
      ev("comment_received", "2026-11-10T01:30:00Z", { isBot: true, on: "pr" }), // bot: ignored
      ev("comment_received", "2026-11-10T02:00:00Z", { isBot: false, on: "pr" }),
      ev("ci_completed", "2026-11-10T02:00:00Z", { headSha: "h1", conclusion: "failure", name: "ci" }),
      ev("ci_completed", "2026-11-10T03:00:00Z", { headSha: "h2", conclusion: "success", name: "ci" }),
      ev("ci_completed", "2026-11-10T03:01:00Z", { headSha: "h2", conclusion: "failure", name: "e2e" }),
      ev("pr_stats", "2026-11-10T01:00:00Z", { headSha: "h1", additions: 1, deletions: 1, changedFiles: 1 }),
      ev("pr_stats", "2026-11-10T03:00:00Z", { headSha: "h2", additions: 40, deletions: 2, changedFiles: 4 }),
      ev("pushed", "2026-11-10T02:30:00Z", { sha: "h2", byFactory: false }),
      ev("pushed", "2026-11-10T02:40:00Z", { sha: "h3", byFactory: true }),
      ev("cancelled", "2026-11-10T04:00:00Z", { by: "dashboard" }),
    ]);
    expect(f.firstReviewAt).toBe("2026-11-10T02:00:00Z");
    expect(f.ciOnHead).toBe("failure");
    expect(f.prSize).toEqual({ additions: 40, deletions: 2, changedFiles: 4 });
    expect(f.humanPushes).toBe(1);
    expect(f.cancelled).toEqual({ by: "dashboard", reason: null });
  });

  it("autonomy, cycle medians and cost per merged change over the window", () => {
    const a = taskFacts(base("task_a"), [ev("pr_opened", "2026-11-10T01:00:00Z"), ev("status_changed", "2026-11-10T05:00:00Z", { to: "merged" })]);
    const b = taskFacts(base("task_b", { people: { comments: 2, reviewRounds: 1 }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 3 } }), [
      ev("pr_opened", "2026-11-10T03:00:00Z"),
      ev("pushed", "2026-11-10T04:00:00Z", { sha: "x", byFactory: false }),
      ev("status_changed", "2026-11-10T09:00:00Z", { to: "merged" }),
    ]);
    const c = taskFacts(base("task_c", { status: "failed", pr: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 2 } }), []);
    const old = taskFacts(base("task_old", { createdAt: "2026-10-01T00:00:00Z" }), []);
    const i = insights([a, b, c, old], NOW, 7);
    expect(i.started).toBe(3);
    expect(i.autonomy).toEqual({ merged: 2, noHumanCommits: 1, rate: 0.5, mergedFirstTry: 1, firstTryRate: 0.5 });
    expect(i.cycle.kickoffToPr).toEqual({ value: 2 * 3600, n: 2 });
    expect(i.cycle.kickoffToMerge.value).toBe(7 * 3600);
    expect(i.cost.perMerged).toBe(3); // $6 total / 2 merged
    expect(i.cost.medianPerPr.value).toBe(2);
    expect(i.cost.mostExpensive[0]?.task.id).toBe("task_b");
    expect(i.daily.at(-4)).toEqual({ day: "2026-11-10", opened: 2, merged: 2 });
  });

  it("buckets PRs by lines changed", () => {
    const sized = (id: string, lines: number, cost: number) =>
      taskFacts(base(id, { usage: { inputTokens: 0, outputTokens: 0, costUsd: cost } }), [ev("pr_stats", NOW, { headSha: "h", additions: lines, deletions: 0, changedFiles: 1 })]);
    const b = costBySize([sized("a", 3, 1), sized("b", 9, 3), sized("c", 10, 5), sized("d", 5000, 9), taskFacts(base("nosize"), [])]);
    expect(b.map((x) => [x.size, x.prs])).toEqual([["XS", 2], ["S", 1], ["M", 0], ["L", 0], ["XL", 1]]);
    expect(b[0]?.medianCostUsd).toBe(2);
  });

  it("inbox puts blocked first and drops cancelled or old failures", () => {
    const review = taskFacts(base("task_r", { status: "awaiting_review" }), []);
    const red = taskFacts(base("task_red", { status: "awaiting_review" }), [ev("ci_completed", NOW, { headSha: "h2", conclusion: "failure" })]);
    const blocked = taskFacts(base("task_b", { status: "working" }), [ev("error", NOW, { message: "workspace failed" })]);
    const failed = taskFacts(base("task_f", { status: "failed", updatedAt: "2026-11-12T00:00:00Z" }), []);
    const stopped = taskFacts(base("task_s", { status: "failed", updatedAt: "2026-11-12T00:00:00Z" }), [ev("cancelled", NOW, { by: "me" })]);
    const ancient = taskFacts(base("task_old", { status: "failed", updatedAt: "2026-10-01T00:00:00Z" }), []);
    expect(inbox([review, red, blocked, failed, stopped, ancient], NOW).map((x) => [x.kind, x.facts.task.id])).toEqual([
      ["blocked", "task_b"],
      ["ci_failing", "task_red"],
      ["pr_review", "task_r"],
      ["failed", "task_f"],
    ]);
  });

  it("filters runs and computes medians", () => {
    const tasks = [base("task_a"), base("task_b", { status: "working", harness: { name: "x", model: "haiku" } })];
    expect(filterTasks(tasks, parseFilter((k) => ({ status: "open" })[k])).map((t) => t.id)).toEqual(["task_b"]);
    expect(filterTasks(tasks, parseFilter((k) => ({ model: "sonnet" })[k])).map((t) => t.id)).toEqual(["task_a"]);
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
