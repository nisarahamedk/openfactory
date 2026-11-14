import { sign } from "@octokit/webhooks-methods";
import { describe, expect, it } from "vitest";
import { GitHubChat, GitHubClient, GitHubPollingSource, parseWebhook, signalsFromPoll } from "./index.js";

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


describe("GitHubPollingSource", () => {
  it("starts from the stored cursor, catches up across pages, and saves where it got to", async () => {
    const seen: string[] = [];
    const comments = Array.from({ length: 150 }, (_, i) => ({
      id: 100 + i,
      body: `c${i}`,
      created_at: new Date(Date.parse("2026-11-13T01:00:00Z") + i * 1000).toISOString(),
      updated_at: "",
      user: u,
      issue_url: "https://api/x/issues/7",
    }));
    const f = (async (url: string) => {
      const p = new URL(url);
      seen.push(`${p.pathname}?${p.searchParams.toString()}`);
      const page = Number(p.searchParams.get("page") ?? 1);
      const since = p.searchParams.get("since") ?? "";
      if (p.pathname.endsWith("/issues/comments")) return Response.json(comments.filter((c) => c.created_at >= since).slice((page - 1) * 100, page * 100));
      return Response.json([]);
    }) as unknown as typeof fetch;
    const gh = new GitHubClient({ token: () => "t", fetch: f });
    const src = new GitHubPollingSource(gh, { repos: [repo], intervalMs: 20, lookbackMs: 15 * 60_000 });
    const store = new Map<string, string>([["github-poll:acme/app", "2026-11-13T00:30:00Z"]]);
    const got: string[] = [];
    const running = await src.start(async (s) => void got.push(s.id), {
      cursors: { cursor: async (k) => store.get(k) ?? null, setCursor: async (k, at) => void store.set(k, at) },
    });
    for (let i = 0; i < 50 && got.length < 150; i++) await new Promise((r) => setTimeout(r, 10));
    await running.stop().catch(() => {});
    const first = seen.filter((x) => x.includes("/issues/comments") && x.includes("since=2026-11-13T00%3A30%3A00Z"));
    expect(first.map((x) => new URLSearchParams(x.split("?")[1]).get("page"))).toEqual(["1", "2"]);
    expect(got).toHaveLength(150);
    expect(store.get("github-poll:acme/app")! > "2026-11-13T00:30:00Z").toBe(true);
  });
});

describe("quietMentions", () => {
  it("turns @-mentions into inline code and leaves emails, scopes and code alone", async () => {
    const { quietMentions } = await import("./index.js");
    expect(quietMentions("Hi @acme-priya, thanks @acme-omar.")).toBe("Hi `acme-priya`, thanks `acme-omar`.");
    expect(quietMentions("@maya see this")).toBe("`maya` see this");
    expect(quietMentions("mail maya@acme-sim.example")).toBe("mail maya@acme-sim.example");
    expect(quietMentions("install @types/node and `@acme-x`")).toBe("install @types/node and `@acme-x`");
  });
});
