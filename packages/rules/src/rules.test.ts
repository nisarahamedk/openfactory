import type { Signal, TaskRecord } from "@openfactory/contracts";
import { describe, expect, it } from "vitest";
import { canMove, decide, pickModel, readyForReview } from "./index.js";

const repo = { host: "github" as const, owner: "a", name: "b" };
const cfg = { label: "factory", botLogins: ["factory-bot"], maxTaskUsd: 5, maxReviewRounds: 3 };
const base = { id: "d", repo, at: "2026-01-01T00:00:00Z", actor: { login: "nisar", isBot: false } };

function task(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    factoryVersion: "fv",
    source: { kind: "github_issue", repo, issueNumber: 1, url: null },
    title: "t",
    ask: "a",
    status: "awaiting_review",
    harness: { name: "claude-code", model: "m" },
    harnessSessionId: "s",
    environment: null,
    workspace: null,
    branch: "factory/task_1",
    pr: { number: 9, url: "u", headSha: "abc123" },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 1 },
    people: { comments: 0, reviewRounds: 0 },
    evidence: [],
    scores: [],
    outcomes: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const labeled: Signal = { ...base, type: "issue_labeled", issueNumber: 1, label: "factory", title: "t", body: "b" };

describe("decide", () => {
  it("starts once per issue and ignores other labels and our bot", () => {
    expect(decide(null, labeled, cfg).kind).toBe("start_task");
    expect(decide(task(), labeled, cfg).kind).toBe("ignore");
    expect(decide(task({ status: "merged" }), labeled, cfg).kind).toBe("start_task");
    expect(decide(null, { ...labeled, label: "bug" }, cfg).kind).toBe("ignore");
    expect(decide(null, { ...labeled, actor: { login: "Factory-Bot", isBot: true } }, cfg).kind).toBe("ignore");
  });

  it("routes comments: issue → foreman, PR → review round, limits → foreman", () => {
    const issueComment: Signal = { ...base, type: "issue_comment", issueNumber: 1, body: "status?" };
    expect(decide(task(), issueComment, cfg).kind).toBe("foreman_reply");
    expect(decide(task(), { ...issueComment, issueNumber: 9 }, cfg).kind).toBe("review_round");
    // CI and other bots' comments never start a round or a retry.
    const ciBot = { login: "github-actions[bot]", isBot: true };
    expect(decide(task(), { ...issueComment, issueNumber: 9, actor: ciBot }, cfg).kind).toBe("ignore");
    expect(decide(task({ status: "failed" }), { ...issueComment, issueNumber: 9, actor: ciBot }, cfg).kind).toBe("ignore");
    const review: Signal = { ...base, type: "pr_review_comment", prNumber: 9, body: "fix", path: null };
    expect(decide(task(), review, cfg).kind).toBe("review_round");
    expect(decide(task({ people: { comments: 0, reviewRounds: 3 } }), review, cfg).kind).toBe("foreman_reply");
    expect(decide(task({ usage: { inputTokens: 0, outputTokens: 0, costUsd: 9 } }), review, cfg).kind).toBe("foreman_reply");
    expect(decide(task({ status: "merged" }), review, cfg).kind).toBe("ignore");
    expect(decide(task({ status: "failed" }), review, cfg).kind).toBe("retry");
    expect(decide(task({ status: "failed" }), issueComment, cfg).kind).toBe("retry");
    expect(decide(task(), { ...review, body: "Ready for review <!-- openfactory -->" }, cfg).kind).toBe("ignore");
  });

  it("finalizes on merge and close", () => {
    expect(decide(task(), { ...base, type: "pr_merged", prNumber: 9, mergeSha: "m" }, cfg)).toMatchObject({ kind: "finalize", outcome: "merged" });
    expect(decide(task(), { ...base, type: "pr_closed", prNumber: 9 }, cfg)).toMatchObject({ kind: "finalize", outcome: "closed" });
  });
});

describe("readyForReview", () => {
  const ev = (sha: string) => ({ kind: "screenshot" as const, title: "s", url: "u", commitSha: sha, environment: "e", createdAt: "" });
  it("needs evidence naming the head commit", () => {
    expect(readyForReview(task({ pr: null })).ok).toBe(false);
    expect(readyForReview(task()).ok).toBe(false);
    expect(readyForReview(task({ evidence: [ev("zzz")] })).ok).toBe(false);
    expect(readyForReview(task({ evidence: [ev("abc123")] })).ok).toBe(true);
    expect(readyForReview(task({ evidence: [ev("abc")] })).ok).toBe(true);
  });
});

describe("canMove", () => {
  it("allows the life of a task and refuses leaving merged", () => {
    expect(canMove("received", "preparing")).toBe(true);
    expect(canMove("awaiting_review", "iterating")).toBe(true);
    expect(canMove("merged", "working")).toBe(false);
  });
});

describe("pickModel", () => {
  const routing = { default: "claude-sonnet", routes: [{ model: "claude-haiku", labels: ["ui", "test"], keywords: ["typo"] }] };
  it("routes small UI and test work to the cheap model", () => {
    expect(pickModel({ title: "Pricing FAQ links", labels: ["factory", "UI"] }, routing)).toEqual({ model: "claude-haiku", reason: "label ui" });
    expect(pickModel({ title: "Fix typo on pricing", labels: ["factory"] }, routing).model).toBe("claude-haiku");
    expect(pickModel({ title: "Typography refresh", labels: ["factory"] }, routing).model).toBe("claude-sonnet");
  });
  it("keeps the default for everything else, and a model: label always wins", () => {
    expect(pickModel({ title: "Billing proration", labels: ["factory"] }, routing)).toEqual({ model: "claude-sonnet", reason: "default" });
    expect(pickModel({ title: "x", labels: ["ui", "model:claude-sonnet"] }, routing).model).toBe("claude-sonnet");
  });
});
