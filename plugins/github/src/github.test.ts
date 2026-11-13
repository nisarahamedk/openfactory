import { sign } from "@octokit/webhooks-methods";
import { describe, expect, it } from "vitest";
import { GitHubChat, GitHubClient, parseWebhook, signalsFromPoll } from "./index.js";

const repo = { host: "github" as const, owner: "acme", name: "app" };
const u = { login: "nisar", type: "User" };

describe("signalsFromPoll", () => {
  it("maps labels, merges, closes and comments with stable ids", () => {
    const s = signalsFromPoll(repo, {
      events: [
        { id: 1, event: "labeled", created_at: "2026-01-01T00:00:01Z", actor: u, label: { name: "factory" }, issue: { number: 7, title: "T", body: "B" } },
        { id: 2, event: "merged", created_at: "2026-01-01T00:00:05Z", actor: u, commit_id: "abc", issue: { number: 9, title: "", body: null, pull_request: {} } },
        { id: 3, event: "closed", created_at: "2026-01-01T00:00:06Z", actor: u, commit_id: null, issue: { number: 10, title: "", body: null, pull_request: {} } },
      ],
      comments: [{ id: 5, body: "hi", created_at: "2026-01-01T00:00:02Z", updated_at: "", user: u, issue_url: "https://api/x/issues/7" }],
      reviewComments: [{ id: 6, body: "fix", created_at: "2026-01-01T00:00:03Z", user: u, path: "a.ts", pull_request_url: "https://api/x/pulls/9" }],
    });
    expect(s.map((x) => `${x.type}:${x.id}`)).toEqual([
      "issue_labeled:gh-event:1",
      "issue_comment:gh-comment:5",
      "pr_review_comment:gh-review-comment:6",
      "pr_merged:gh-event:2",
      "pr_closed:gh-event:3",
    ]);
  });
});

describe("parseWebhook", () => {
  it("verifies and parses a labeled issue", async () => {
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "factory" },
      issue: { number: 3, title: "T", body: null },
      repository: { name: "app", owner: { login: "acme" } },
      sender: u,
    });
    const sig = await sign("s3cret", body);
    const s = await parseWebhook("s3cret", { event: "issues", delivery: "d1", signature: sig }, body);
    expect(s).toMatchObject({ type: "issue_labeled", issueNumber: 3, label: "factory", repo });
    await expect(parseWebhook("other", { event: "issues", delivery: "d1", signature: sig }, body)).rejects.toThrow();
  });
});

describe("GitHubChat", () => {
  it("appends the factory marker", async () => {
    let sent = "";
    const gh = new GitHubClient({
      token: () => "t",
      fetch: (async (_u: string, init: RequestInit) => {
        sent = String(init.body);
        return new Response(JSON.stringify({ html_url: "https://gh/c/1" }), { status: 201 });
      }) as typeof fetch,
    });
    expect((await new GitHubChat(gh).post({ repo, issueOrPr: 1 }, "hello")).url).toBe("https://gh/c/1");
    expect(JSON.parse(sent).body).toContain("<!-- openfactory -->");
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubBundlePusher } from "./index.js";

describe("GitHubBundlePusher", () => {
  it("pushes a branch from a bundle", async () => {
    const d = mkdtempSync(join(tmpdir(), "bp-"));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x" } }).toString().trim();
    g(d, "init", "-q", "-b", "factory/task_x", "work");
    g(join(d, "work"), "commit", "-q", "--allow-empty", "-m", "hi");
    const sha = g(join(d, "work"), "rev-parse", "HEAD");
    g(join(d, "work"), "bundle", "create", join(d, "b.bundle"), "refs/heads/factory/task_x");
    g(d, "init", "-q", "--bare", "remote.git");
    const pusher = new GitHubBundlePusher({ token: () => "t", remoteUrl: () => join(d, "remote.git") });
    await pusher.push({ host: "github", owner: "o", name: "r" }, "factory/task_x", readFileSync(join(d, "b.bundle")));
    expect(g(join(d, "remote.git"), "rev-parse", "refs/heads/factory/task_x")).toBe(sha);
    await expect(pusher.push({ host: "github", owner: "o", name: "r" }, "../main", new Uint8Array())).rejects.toThrow();
  });
});
