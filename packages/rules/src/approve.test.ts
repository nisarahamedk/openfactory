import { describe, expect, it } from "vitest";
import { decide } from "./index.js";

const cfg = { label: "factory", botLogins: ["factory-bot"], maxTaskUsd: 2, maxReviewRounds: 4 };
const task = (status: string) => ({ id: "task_x", status, pr: { number: 7, url: "u", headSha: "abc" }, people: { comments: 0, reviewRounds: 0 }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }) as never;
const approved = { id: "gh-review:1", type: "pr_approved", repo: { host: "github", owner: "o", name: "r" }, at: "2026-11-14T00:00:00Z", actor: { login: "lena", isBot: false }, prNumber: 7, headSha: "abc", via: "github" } as const;

describe("approvals", () => {
  it("records an approval and never starts a review round", () => {
    expect(decide(task("awaiting_review"), approved, cfg).kind).toBe("record_approval");
    expect(decide(task("merged"), approved, cfg).kind).toBe("ignore");
    expect(decide(null, approved, cfg).kind).toBe("ignore");
  });
});
