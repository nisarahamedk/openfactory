import { describe, expect, it } from "vitest";
import type { MergedTask, TaskRecord } from "@openfactory/contracts";
import { GitHubClient, GitHubOutcomeSource, isRevertOf, mentions } from "./index.js";

const repo = { host: "github" as const, owner: "acme", name: "app" };
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function task(id: string, pr: number, issue: number | null, mergedAt: string, sha: string | null = SHA): MergedTask {
  const record = {
    id,
    source: { kind: "github_issue", repo, issueNumber: issue, url: null },
    pr: { number: pr, url: `https://github.com/acme/app/pull/${pr}`, headSha: null },
    outcomes: [],
  } as unknown as TaskRecord;
  return { record, mergeSha: sha, mergedAt };
}

const pull = (number: number, title: string, body: string, merged_at: string | null, merge_commit_sha = `m${number}`) => ({
  number, title, body, html_url: `https://github.com/acme/app/pull/${number}`, merged_at, merge_commit_sha, updated_at: merged_at ?? "2026-11-20T00:00:00Z",
});

/** A GitHub API stand-in: routes by path prefix, records the paths it served. */
function fakeGitHub(routes: Record<string, unknown[]>) {
  const seen: string[] = [];
  const f: typeof fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    const page = Number(url.searchParams.get("page") ?? 1);
    const body = page === 1 ? (routes[url.pathname] ?? []) : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { gh: new GitHubClient({ token: () => "t", apiUrl: "https://gh.test", fetch: f }), seen };
}

describe("matching", () => {
  it("mentions finds #n, owner/name#n and URLs, not a longer number", () => {
    expect(mentions("Fixes #12", repo, 12)).toBe(true);
    expect(mentions("see acme/app#12", repo, 12)).toBe(true);
    expect(mentions("https://github.com/acme/app/pull/12", repo, 12)).toBe(true);
    expect(mentions("Fixes #123", repo, 12)).toBe(false);
    expect(mentions("other/app#12", repo, 12)).toBe(false);
  });

  it("isRevertOf knows the button and git revert formats", () => {
    const t = task("task_a", 12, 3, "2026-11-10T00:00:00Z");
    expect(isRevertOf('Revert "Rate-limit the API"\nReverts acme/app#12', t)).toBe(true);
    expect(isRevertOf(`Revert "x"\n\nThis reverts commit ${SHA}.`, t)).toBe(true);
    expect(isRevertOf("Fix rate limit, follow-up to #12", t)).toBe(false);
    expect(isRevertOf('Revert "y"\nReverts acme/app#99', t)).toBe(false);
  });
});

describe("GitHubOutcomeSource", () => {
  const merged = "2026-11-10T00:00:00Z";
  const routes = {
    "/repos/acme/app/pulls": [
      pull(40, 'Revert "Rate-limit the public API"', "Reverts acme/app#12", "2026-11-16T00:00:00Z", "rev40"),
      pull(41, "Fix sorting by date after the new index", "Follow-up to #12", "2026-11-12T00:00:00Z"),
      pull(42, "Use the design system usage bar", "Refines #3", "2026-11-13T00:00:00Z"),
      pull(43, "Unrelated fix", "Fixes #12", "2026-11-14T00:00:00Z"), // links, but no shared file
      pull(44, "Fix again", "Fixes #12", "2026-12-30T00:00:00Z"), // past followUpDays
      pull(45, "Closed without merge", "#12", null),
      pull(12, "Rate-limit the public API", "Fixes #3", "2026-11-10T00:00:00Z"),
    ],
    "/repos/acme/app/commits": [
      { sha: "rev40", html_url: "", commit: { message: 'Revert "Rate-limit the public API" (#40)', committer: { date: "2026-11-16T00:00:00Z" } } },
      { sha: "c99", html_url: "", commit: { message: `Revert "Rate-limit"\n\nThis reverts commit ${SHA}.`, committer: { date: "2026-11-17T00:00:00Z" } } },
      { sha: "c98", html_url: "", commit: { message: "Unrelated", committer: { date: "2026-11-17T00:00:00Z" } } },
    ],
    "/repos/acme/app/pulls/12/files": [{ filename: "src/limits.ts" }, { filename: "src/api.ts" }],
    "/repos/acme/app/pulls/41/files": [{ filename: "src/limits.ts" }],
    "/repos/acme/app/pulls/42/files": [{ filename: "src/old-api.ts", previous_filename: "src/api.ts" }],
    "/repos/acme/app/pulls/43/files": [{ filename: "README.md" }],
    "/repos/acme/app/pulls/44/files": [{ filename: "src/limits.ts" }],
  };

  it("finds revert PRs, revert commits, hotfixes and rework, each once", async () => {
    const { gh } = fakeGitHub(routes);
    const src = new GitHubOutcomeSource(gh, { followUpDays: 14 });
    const found = await src.poll([task("task_a", 12, 3, merged)], "2026-11-20T00:00:00Z");
    expect(found.map((f) => [f.ref, f.outcome.kind, f.outcome.at])).toEqual([
      ["pr:40", "reverted", "2026-11-16T00:00:00Z"],
      ["commit:c99", "reverted", "2026-11-17T00:00:00Z"],
      ["pr:41", "hotfix", "2026-11-12T00:00:00Z"],
      ["pr:42", "rework", "2026-11-13T00:00:00Z"],
    ]);
    expect(found.every((f) => f.taskId === "task_a" && f.outcome.source === "github" && f.outcome.arrivedAt === "2026-11-20T00:00:00Z")).toBe(true);
    expect(found[2]!.outcome.detail).toContain("src/limits.ts");
  });

  it("fetches each repo's PRs and commits once for many tasks", async () => {
    const { gh, seen } = fakeGitHub(routes);
    const src = new GitHubOutcomeSource(gh, { followUpDays: 14 });
    await src.poll([task("task_a", 12, 3, merged), task("task_b", 30, null, "2026-11-11T00:00:00Z", null)], "2026-11-20T00:00:00Z");
    expect(seen.filter((p) => p === "/repos/acme/app/pulls")).toHaveLength(1);
    expect(seen.filter((p) => p === "/repos/acme/app/commits")).toHaveLength(1);
  });

  it("ignores changes merged before the task", async () => {
    const { gh } = fakeGitHub(routes);
    const src = new GitHubOutcomeSource(gh, { followUpDays: 14 });
    expect(await src.poll([task("task_a", 12, 3, "2026-11-18T00:00:00Z")], "2026-11-20T00:00:00Z")).toEqual([]);
  });
});
