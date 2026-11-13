import { describe, expect, it } from "vitest";
import type { LedgerEvent, Scorer, TaskRecord } from "@openfactory/contracts";
import { ciFirstPassScorer, heldUpScorer, mergedScorer, reviewRoundsScorer, stageTimeScorer, timeInStages } from "./facts.js";
import { latestScores, mergeScores, runScorers } from "./index.js";

const T0 = "2026-11-13T10:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

function record(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    factoryVersion: "fv_a",
    source: { kind: "github_issue", repo: { host: "github", owner: "o", name: "r" }, issueNumber: 1, url: null },
    title: "t",
    ask: "a",
    status: "merged",
    harness: { name: "claude-code", model: "sonnet" },
    harnessSessionId: null,
    environment: null,
    workspace: null,
    branch: "b",
    pr: { number: 7, url: "u", headSha: "bbb" },
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 1.25 },
    people: { comments: 2, reviewRounds: 9 },
    evidence: [],
    scores: [],
    outcomes: [],
    createdAt: T0,
    updatedAt: at(60),
    ...over,
  };
}
const ev = (min: number, type: string, data: Record<string, unknown>): LedgerEvent => ({ taskId: "task_1", at: at(min), type, data });

const log: LedgerEvent[] = [
  ev(1, "status_changed", { from: "received", to: "preparing" }),
  ev(5, "status_changed", { from: "preparing", to: "working" }),
  ev(20, "turn_finished", { reason: "intake" }),
  ev(20, "pr_opened", { number: 7, url: "u", headSha: "aaa" }),
  ev(20, "status_changed", { from: "working", to: "awaiting_review" }),
  ev(25, "ci_completed", { headSha: "aaa", conclusion: "failure", name: "e2e" }),
  ev(26, "ci_completed", { headSha: "aaa", conclusion: "success", name: "lint" }),
  ev(40, "status_changed", { from: "awaiting_review", to: "iterating" }),
  ev(50, "turn_finished", { reason: "review" }),
  ev(50, "pushed", { sha: "bbb" }),
  ev(50, "status_changed", { from: "iterating", to: "awaiting_review" }),
  ev(55, "ci_completed", { headSha: "bbb", conclusion: "success", name: "e2e" }),
  ev(60, "status_changed", { from: "awaiting_review", to: "merged" }),
];

describe("fact scorers", () => {
  it("CI first pass judges the PR's first commit, not the final one", () => {
    const s = ciFirstPassScorer.score(record(), log, at(61));
    expect(s?.value).toBe(0);
    expect(s?.reason).toContain("e2e=failure");
  });

  it("CI first pass counts a re-run on the same commit as the latest result", () => {
    const rerun = [...log, ev(30, "ci_completed", { headSha: "aaa", conclusion: "success", name: "e2e" })];
    expect(ciFirstPassScorer.score(record(), rerun, at(61))?.value).toBe(1);
  });

  it("review rounds come from review-woken turns, not the record counter, when turns exist", () => {
    expect(reviewRoundsScorer.score(record(), log, at(61))?.value).toBe(1);
    expect(reviewRoundsScorer.score(record(), [], at(61))?.value).toBe(9);
  });

  it("time per stage sums repeated visits and stops at the terminal state", () => {
    const t = timeInStages(record(), log, at(500));
    expect(t.get("awaiting_review")).toBe((20 + 10) * 60);
    expect(t.get("merged")).toBeUndefined();
    expect(stageTimeScorer("working").score(record(), log, at(61))?.value).toBe(15 * 60);
  });

  it("open tasks: merged doesn't apply yet, current stage keeps counting", () => {
    const open = record({ status: "awaiting_review" });
    const openLog = log.slice(0, 5);
    expect(mergedScorer.score(open, openLog, at(30))).toBeNull();
    expect(stageTimeScorer("awaiting_review").score(open, openLog, at(30))?.value).toBe(10 * 60);
  });

  it("malformed event data is ignored instead of crashing", () => {
    const bad = [ev(25, "ci_completed", { conclusion: 3 })];
    expect(ciFirstPassScorer.score(record(), bad, at(61))).toBeNull();
  });
});

describe("held up", () => {
  const merged = { kind: "merged" as const, source: "github", detail: "merge abc1234", at: T0, arrivedAt: T0 };
  const day = (d: number) => new Date(Date.parse(T0) + d * 86_400_000).toISOString();
  it("is open inside the window, 0 when something came back, 1 after 30 quiet days", () => {
    expect(heldUpScorer.score(record({ outcomes: [merged] }), [], day(10))).toBeNull();
    const reverted = { kind: "reverted" as const, source: "github", detail: "reverted by PR #40", at: day(6), arrivedAt: day(6) };
    expect(heldUpScorer.score(record({ outcomes: [merged, reverted] }), [], day(10))).toMatchObject({ value: 0, label: "reverted" });
    expect(heldUpScorer.score(record({ outcomes: [merged] }), [], day(31))).toMatchObject({ value: 1 });
  });
  it("rework and late arrivals after the window don't count against it", () => {
    const rework = { kind: "rework" as const, source: "github", detail: "reworked", at: day(3), arrivedAt: day(3) };
    const late = { kind: "incident_linked" as const, source: "dxfake", detail: "inc", at: day(40), arrivedAt: day(40) };
    expect(heldUpScorer.score(record({ outcomes: [merged, rework, late] }), [], day(41))).toMatchObject({ value: 1 });
  });
});

describe("runScorers", () => {
  it("a throwing scorer is reported and doesn't block the rest", () => {
    const boom: Scorer = { name: "x.boom", version: "1", score: () => { throw new Error("bug"); } };
    const run = runScorers(record(), log, at(61), [boom, mergedScorer]);
    expect(run.errors).toEqual([{ scorer: "x.boom", message: "bug" }]);
    expect(run.scores.map((s) => s.scorer)).toEqual(["facts.merged"]);
  });

  it("default set scores a merged task end to end", () => {
    const names = runScorers(record(), log, at(61)).scores.map((s) => s.scorer);
    expect(names).toContain("facts.merged");
    expect(names).toContain("facts.cost_usd");
    expect(names).toContain("facts.lead_time_s");
  });
});

describe("mergeScores", () => {
  it("replaces same scorer+version and keeps other versions", () => {
    const s = (v: string, value: number) => ({ scorer: "a", scorerVersion: v, value, label: null, reason: "", at: T0 });
    const merged = mergeScores([s("1", 1), s("2", 2)], [s("2", 3)]);
    expect(merged.map((m) => m.value).sort()).toEqual([1, 3]);
    expect(latestScores(merged).get("a")?.value).toBe(3);
  });
});
