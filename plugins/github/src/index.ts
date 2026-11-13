/**
 * GitHub plugin: signals (polling, or webhooks), chat (issue/PR comments) and
 * code host (PRs, push tokens). Vendor payloads are parsed here and only
 * contract-shaped Signals leave this file.
 *
 * Auth: a token (fine-grained PAT or a GitHub App installation token) from the
 * factory's secrets. With a PAT the factory acts as that person, so every post
 * carries FACTORY_MARKER and the rules never react to it.
 */
import { verify } from "@octokit/webhooks-methods";
import { GitHubOutcomeSource } from "./outcomes.js";
import {
  defineProvider,
  type ProviderContext,
  FACTORY_MARKER,
  Signal,
  type Chat,
  type CodeForge,
  type RepoRef,
  type SignalSource,
} from "@openfactory/contracts";

export type GitHubOptions = {
  token: () => string | Promise<string>;
  apiUrl?: string; // https://api.github.com
  fetch?: typeof fetch;
};

export class GitHubClient {
  private readonly api: string;
  private readonly f: typeof fetch;
  constructor(private readonly opts: GitHubOptions) {
    this.api = opts.apiUrl ?? "https://api.github.com";
    this.f = opts.fetch ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.opts.token()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "openfactory",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async whoami(): Promise<string> {
    return (await this.request<{ login: string }>("GET", "/user")).login;
  }
}

const r = (repo: RepoRef) => `/repos/${repo.owner}/${repo.name}`;

export class GitHubChat implements Chat {
  readonly name = "github";
  constructor(private readonly gh: GitHubClient) {}
  async post(target: { repo: RepoRef; issueOrPr: number }, markdown: string): Promise<{ url: string }> {
    const c = await this.gh.request<{ html_url: string }>("POST", `${r(target.repo)}/issues/${target.issueOrPr}/comments`, {
      body: `${markdown}\n\n${FACTORY_MARKER}`,
    });
    return { url: c.html_url };
  }
}

type Pull = { number: number; html_url: string; head: { sha: string; ref: string }; state: string };

export class GitHubCodeForge implements CodeForge {
  readonly name = "github";
  constructor(
    private readonly gh: GitHubClient,
    private readonly opts: { token: () => string | Promise<string> },
  ) {}

  async openPullRequest(input: { repo: RepoRef; head: string; base: string; title: string; body: string }) {
    const pr = await this.gh.request<Pull>("POST", `${r(input.repo)}/pulls`, {
      head: input.head,
      base: input.base,
      title: input.title,
      body: `${input.body}\n\n${FACTORY_MARKER}`,
    });
    return { number: pr.number, url: pr.html_url };
  }

  async findPullRequestForBranch(repo: RepoRef, branch: string) {
    const prs = await this.gh.request<Pull[]>("GET", `${r(repo)}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${branch}`)}&per_page=5`);
    const pr = prs.find((p) => p.head.ref === branch);
    return pr ? { number: pr.number, url: pr.html_url, headSha: pr.head.sha } : null;
  }

  async pullRequestStats(repo: RepoRef, number: number) {
    const p = await this.gh.request<{ head: { sha: string }; additions: number; deletions: number; changed_files: number }>("GET", `${r(repo)}/pulls/${number}`);
    return { headSha: p.head.sha, additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files };
  }

  /** With a PAT this is the PAT itself; a GitHub App deployment swaps in installation tokens here. */
  async mintPushToken(_repo: RepoRef) {
    return { token: await this.opts.token(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  }
}

// ───────────────────────────── signals ─────────────────────────────

type GhUser = { login: string; type: string };
const actor = (u: GhUser | null | undefined) => ({ login: u?.login ?? "ghost", isBot: (u?.type ?? "") === "Bot" });

type IssueEvent = {
  id: number;
  event: string;
  created_at: string;
  actor: GhUser | null;
  label?: { name: string };
  commit_id?: string | null;
  issue: { number: number; title: string; body: string | null; pull_request?: unknown; labels?: unknown };
};

/** Label names from an issue's `labels` (objects with `name`, or plain strings). */
function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((l) => (typeof l === "string" ? [l] : l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string" ? [(l as { name: string }).name] : []));
}
type IssueComment = { id: number; body: string; created_at: string; updated_at: string; user: GhUser; issue_url: string };
type ReviewComment = { id: number; body: string; created_at: string; user: GhUser; path: string | null; pull_request_url: string };

const numFromUrl = (u: string) => Number(u.split("/").pop());

/** Pure: turn polled GitHub objects into signals (ids are stable across polls). */
export function signalsFromPoll(
  repo: RepoRef,
  input: { events: IssueEvent[]; comments: IssueComment[]; reviewComments: ReviewComment[] },
): Signal[] {
  const out: Signal[] = [];
  for (const e of input.events) {
    const base = { id: `gh-event:${e.id}`, repo, at: e.created_at, actor: actor(e.actor) };
    if (e.event === "labeled" && e.label && !e.issue.pull_request)
      out.push({ ...base, type: "issue_labeled", issueNumber: e.issue.number, label: e.label.name, title: e.issue.title, body: e.issue.body ?? "", labels: labelNames(e.issue.labels) });
    else if (e.event === "merged" && e.issue.pull_request)
      out.push({ ...base, type: "pr_merged", prNumber: e.issue.number, mergeSha: e.commit_id ?? "" });
    else if (e.event === "closed" && e.issue.pull_request && !e.commit_id) out.push({ ...base, type: "pr_closed", prNumber: e.issue.number });
  }
  for (const c of input.comments)
    out.push({ id: `gh-comment:${c.id}`, repo, at: c.created_at, actor: actor(c.user), type: "issue_comment", issueNumber: numFromUrl(c.issue_url), body: c.body ?? "" });
  for (const c of input.reviewComments)
    out.push({
      id: `gh-review-comment:${c.id}`,
      repo,
      at: c.created_at,
      actor: actor(c.user),
      type: "pr_review_comment",
      prNumber: numFromUrl(c.pull_request_url),
      body: c.path ? `On \`${c.path}\`: ${c.body}` : c.body,
      path: c.path,
    });
  return out.sort((a, b) => a.at.localeCompare(b.at)).filter((s) => Signal.safeParse(s).success);
}

/**
 * Polls a repo for labels, comments, reviews, merges and closes. Needs no inbound network, which suits
 * self-hosted factories behind a firewall. Repeats are harmless: the job de-duplicates by signal id.
 */
export class GitHubPollingSource implements SignalSource {
  readonly name = "github-poll";
  constructor(
    private readonly gh: GitHubClient,
    private readonly opts: { repos: RepoRef[]; intervalMs: number; lookbackMs: number; log?: (m: string, f?: Record<string, unknown>) => void },
  ) {}

  async pollOnce(repo: RepoRef, since: string): Promise<Signal[]> {
    const [events, comments, reviewComments, reviews] = await Promise.all([
      this.gh.request<IssueEvent[]>("GET", `${r(repo)}/issues/events?per_page=100`),
      this.gh.request<IssueComment[]>("GET", `${r(repo)}/issues/comments?since=${since}&per_page=100&sort=created&direction=asc`),
      this.gh.request<ReviewComment[]>("GET", `${r(repo)}/pulls/comments?since=${since}&per_page=100&sort=created&direction=asc`),
      this.reviewBodies(repo, since),
    ]);
    const recent = events.filter((e) => e.created_at >= since);
    return [...signalsFromPoll(repo, { events: recent, comments: comments.filter((c) => c.created_at >= since), reviewComments }), ...reviews];
  }

  /** Top-level review bodies ("Request changes: ...") on recently updated open PRs. */
  private async reviewBodies(repo: RepoRef, since: string): Promise<Signal[]> {
    const pulls = await this.gh.request<Array<Pull & { updated_at: string }>>("GET", `${r(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=20`);
    const out: Signal[] = [];
    for (const p of pulls.filter((x) => x.updated_at >= since)) {
      const reviews = await this.gh.request<Array<{ id: number; body: string; user: GhUser; submitted_at: string; state: string }>>(
        "GET",
        `${r(repo)}/pulls/${p.number}/reviews?per_page=50`,
      );
      for (const rv of reviews)
        if (rv.body?.trim() && rv.submitted_at >= since)
          out.push({ id: `gh-review:${rv.id}`, repo, at: rv.submitted_at, actor: actor(rv.user), type: "pr_review_comment", prNumber: p.number, body: rv.body, path: null });
    }
    return out;
  }

  async start(onSignal: (signal: Signal) => Promise<void>): Promise<{ stop(): Promise<void> }> {
    let stopped = false;
    const cursors = new Map(this.opts.repos.map((x) => [`${x.owner}/${x.name}`, new Date(Date.now() - this.opts.lookbackMs).toISOString()]));
    const loop = async () => {
      while (!stopped) {
        for (const repo of this.opts.repos) {
          const key = `${repo.owner}/${repo.name}`;
          const startedAt = new Date(Date.now() - 60_000).toISOString(); // overlap: GitHub lists can lag
          try {
            for (const s of await this.pollOnce(repo, cursors.get(key)!)) {
              try {
                await onSignal(s);
              } catch (e) {
                this.opts.log?.("signal handler failed", { id: s.id, error: String(e) });
              }
            }
            cursors.set(key, startedAt);
          } catch (e) {
            this.opts.log?.("poll failed", { repo: key, error: String(e) });
          }
        }
        await new Promise((res) => setTimeout(res, this.opts.intervalMs));
      }
    };
    const running = loop();
    return {
      stop: async () => {
        stopped = true;
        await running.catch(() => {});
      },
    };
  }
}

/** Webhook receiver: verify the signature, then parse. Returns null for events the factory ignores. */
export async function parseWebhook(
  secret: string,
  headers: { event: string | null; delivery: string | null; signature: string | null },
  rawBody: string,
): Promise<Signal | null> {
  if (!headers.signature || !(await verify(secret, rawBody, headers.signature))) throw new Error("bad webhook signature");
  const p = JSON.parse(rawBody);
  const repo: RepoRef = { host: "github", owner: p.repository?.owner?.login, name: p.repository?.name };
  const base = { id: `gh-delivery:${headers.delivery}`, repo, at: new Date().toISOString(), actor: actor(p.sender) };
  let s: unknown = null;
  if (headers.event === "issues" && p.action === "labeled" && !p.issue.pull_request)
    s = { ...base, type: "issue_labeled", issueNumber: p.issue.number, label: p.label.name, title: p.issue.title, body: p.issue.body ?? "", labels: labelNames(p.issue.labels) };
  else if (headers.event === "issue_comment" && p.action === "created")
    s = { ...base, id: `gh-comment:${p.comment.id}`, type: "issue_comment", issueNumber: p.issue.number, body: p.comment.body ?? "" };
  else if (headers.event === "pull_request_review_comment" && p.action === "created")
    s = { ...base, id: `gh-review-comment:${p.comment.id}`, type: "pr_review_comment", prNumber: p.pull_request.number, body: p.comment.body, path: p.comment.path ?? null };
  else if (headers.event === "pull_request_review" && p.action === "submitted" && p.review.body)
    s = { ...base, id: `gh-review:${p.review.id}`, type: "pr_review_comment", prNumber: p.pull_request.number, body: p.review.body, path: null };
  else if (headers.event === "pull_request" && p.action === "closed")
    s = p.pull_request.merged
      ? { ...base, type: "pr_merged", prNumber: p.pull_request.number, mergeSha: p.pull_request.merge_commit_sha ?? "" }
      : { ...base, type: "pr_closed", prNumber: p.pull_request.number };
  else if (headers.event === "check_run" && p.action === "completed")
    s = { ...base, type: "ci_completed", headSha: p.check_run.head_sha, conclusion: p.check_run.conclusion ?? "neutral", name: p.check_run.name };
  if (!s) return null;
  const parsed = Signal.safeParse(s);
  return parsed.success ? parsed.data : null;
}

// ───────────────────────────── provider ─────────────────────────────


function clientFrom(ctx: ProviderContext): { gh: GitHubClient; token: () => string } {
  const tokenEnv = typeof ctx.options.tokenEnv === "string" ? ctx.options.tokenEnv : "GITHUB_TOKEN";
  const token = () => {
    const t = ctx.env[tokenEnv];
    if (!t) throw new Error(`github provider: ${tokenEnv} is not set`);
    return t;
  };
  return { gh: new GitHubClient({ token, ...(typeof ctx.options.apiUrl === "string" ? { apiUrl: ctx.options.apiUrl } : {}) }), token };
}

function reposFrom(ctx: ProviderContext): RepoRef[] {
  const raw = Array.isArray(ctx.options.repos) ? (ctx.options.repos as string[]) : (ctx.env.FACTORY_REPOS ?? "").split(",");
  return raw
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [owner, name] = s.split("/");
      if (!owner || !name) throw new Error(`github provider: bad repo "${s}" (want owner/name)`);
      return { host: "github" as const, owner, name };
    });
}

/**
 * The github provider: codeForge (PRs, pushes), chat (issue and PR comments) and signals (polling).
 * factory.yaml options: tokenEnv (default GITHUB_TOKEN), apiUrl, repos, pollIntervalMs, lookbackMs.
 */
export const provider = defineProvider({
  name: "github",
  provides: {
    codeForge: (ctx) => {
      const { gh, token } = clientFrom(ctx);
      return new GitHubCodeForge(gh, { token });
    },
    chat: (ctx) => new GitHubChat(clientFrom(ctx).gh),
    signals: (ctx) =>
      new GitHubPollingSource(clientFrom(ctx).gh, {
        repos: reposFrom(ctx),
        intervalMs: Number(ctx.options.pollIntervalMs ?? ctx.env.POLL_INTERVAL_MS ?? 20_000),
        lookbackMs: Number(ctx.options.lookbackMs ?? ctx.env.POLL_LOOKBACK_MS ?? 15 * 60_000),
        log: ctx.log,
      }),
    outcomes: (ctx) => new GitHubOutcomeSource(clientFrom(ctx).gh, { followUpDays: Number(ctx.options.followUpDays ?? 14) }),
  },
});

export { GitHubOutcomeSource, isRevertOf, mentions, type GitHubOutcomeOptions } from "./outcomes.js";
