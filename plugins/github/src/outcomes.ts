/**
 * Late outcomes from GitHub, for tasks the factory merged:
 *
 * - **reverted**: a merged PR or a commit on the base branch that reverts the task's change. A revert PR
 *   made with GitHub's button says "Reverts owner/name#123"; `git revert` writes "This reverts commit <sha>".
 * - **hotfix / rework**: a later merged PR, within `followUpDays`, that edits a file the task's PR edited and
 *   links the task's PR or issue. "fix", "bug", "hotfix" or "regression" in its title makes it a hotfix;
 *   anything else is rework.
 *
 * One poll fetches each repo's recently closed PRs and base-branch commits once, for all its tasks.
 */
import type { FoundOutcome, MergedTask, OutcomeSource, RepoRef } from "@openfactory/contracts";
import type { GitHubClient } from "./index.js";

type Pull = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  updated_at: string;
};
type Commit = { sha: string; html_url: string; commit: { message: string; committer: { date: string } | null } };
type PrFile = { filename: string; previous_filename?: string };

export type GitHubOutcomeOptions = {
  /** How long after the merge a linked PR touching the same files counts as a follow-up fix. */
  followUpDays: number;
  /** Pages of 100 closed PRs / commits read per repo per poll. */
  maxPages?: number;
};

const DAY = 86_400_000;
const HOTFIX = /\b(hot ?fix|fix(es|ed)?|bug|regression)\b/i;
const repoKey = (r: RepoRef) => `${r.owner}/${r.name}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does `text` reference PR or issue `n` of `repo`: "#12", "owner/name#12" or its URL (not "#123"). */
export function mentions(text: string, repo: RepoRef, n: number): boolean {
  const full = esc(repoKey(repo));
  const re = new RegExp(`(^|[^\\w/])#${n}\\b|\\b${full}#${n}\\b|github\\.com/${full}/(pull|issues)/${n}\\b`, "i");
  return re.test(text);
}

/** Is this PR or commit message a revert of the task (its PR number or merge sha)? */
export function isRevertOf(text: string, task: MergedTask): boolean {
  const pr = task.record.pr;
  const sha = task.mergeSha;
  if (sha && new RegExp(`reverts? commit ${sha.slice(0, 7)}`, "i").test(text)) return true;
  if (!/^revert\b|\breverts\b/im.test(text)) return false;
  if (pr && mentions(text, task.record.source.repo, pr.number)) return true;
  return sha !== null && text.includes(sha.slice(0, 7));
}

export class GitHubOutcomeSource implements OutcomeSource {
  readonly name = "github";

  constructor(
    private readonly gh: GitHubClient,
    private readonly opts: GitHubOutcomeOptions,
  ) {}

  async poll(merged: MergedTask[], now: string): Promise<FoundOutcome[]> {
    const byRepo = new Map<string, MergedTask[]>();
    for (const t of merged) {
      if (t.record.pr === null) continue;
      const k = repoKey(t.record.source.repo);
      byRepo.set(k, [...(byRepo.get(k) ?? []), t]);
    }
    const out: FoundOutcome[] = [];
    for (const tasks of byRepo.values()) out.push(...(await this.pollRepo(tasks, now)));
    return out;
  }

  private async pollRepo(tasks: MergedTask[], now: string): Promise<FoundOutcome[]> {
    const repo = tasks[0]!.record.source.repo;
    const since = tasks.map((t) => t.mergedAt).sort()[0]!;
    const path = `/repos/${repo.owner}/${repo.name}`;
    const pulls = (await this.pages<Pull>(`${path}/pulls?state=closed&sort=updated&direction=desc`, (p) => p.updated_at < since)).filter(
      (p) => p.merged_at !== null && p.merged_at > since,
    );
    const commits = await this.pages<Commit>(`${path}/commits?since=${encodeURIComponent(since)}`, () => false);
    const files = new Map<number, Set<string>>();
    const filesOf = async (n: number) => {
      let f = files.get(n);
      if (!f) {
        const list = await this.pages<PrFile>(`${path}/pulls/${n}/files`, () => false);
        f = new Set(list.flatMap((x) => (x.previous_filename ? [x.filename, x.previous_filename] : [x.filename])));
        files.set(n, f);
      }
      return f;
    };

    const out: FoundOutcome[] = [];
    for (const task of tasks) {
      const pr = task.record.pr!;
      const later = pulls.filter((p) => p.number !== pr.number && p.merged_at! > task.mergedAt);
      const revertPrs = later.filter((p) => isRevertOf(`${p.title}\n${p.body ?? ""}`, task));
      for (const p of revertPrs) {
        out.push({
          taskId: task.record.id,
          ref: `pr:${p.number}`,
          outcome: { kind: "reverted", source: this.name, detail: `reverted by PR #${p.number}: ${p.title}`, at: p.merged_at!, arrivedAt: now },
        });
      }
      const revertShas = new Set(revertPrs.map((p) => p.merge_commit_sha));
      for (const c of commits) {
        const at = c.commit.committer?.date ?? now;
        if (at <= task.mergedAt || revertShas.has(c.sha) || !isRevertOf(c.commit.message, task)) continue;
        // A revert PR's own commits are already covered by the PR.
        if (revertPrs.some((p) => c.commit.message.includes(`#${p.number}`))) continue;
        out.push({
          taskId: task.record.id,
          ref: `commit:${c.sha}`,
          outcome: { kind: "reverted", source: this.name, detail: `reverted by commit ${c.sha.slice(0, 7)}: ${c.commit.message.split("\n")[0]}`, at, arrivedAt: now },
        });
      }

      const links = (p: Pull) => {
        const text = `${p.title}\n${p.body ?? ""}`;
        const issue = task.record.source.issueNumber;
        return mentions(text, task.record.source.repo, pr.number) || (issue !== null && mentions(text, task.record.source.repo, issue));
      };
      const deadline = new Date(Date.parse(task.mergedAt) + this.opts.followUpDays * DAY).toISOString();
      for (const p of later) {
        if (revertPrs.includes(p) || p.merged_at! > deadline || !links(p)) continue;
        const mine = await filesOf(pr.number);
        const theirs = await filesOf(p.number);
        const shared = [...theirs].filter((f) => mine.has(f));
        if (shared.length === 0) continue;
        const kind = HOTFIX.test(p.title) ? "hotfix" : "rework";
        out.push({
          taskId: task.record.id,
          ref: `pr:${p.number}`,
          outcome: {
            kind,
            source: this.name,
            detail: `${kind === "hotfix" ? "fixed" : "reworked"} by PR #${p.number}: ${p.title} (${shared.length} shared file${shared.length === 1 ? "" : "s"}: ${shared.slice(0, 3).join(", ")})`,
            at: p.merged_at!,
            arrivedAt: now,
          },
        });
      }
    }
    return out;
  }

  /** Read pages of 100 until a short page, `stop` says the rest is older, or maxPages. */
  private async pages<T>(path: string, stop: (item: T) => boolean): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= (this.opts.maxPages ?? 5); page++) {
      const items = await this.gh.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100 || items.some(stop)) break;
    }
    return out;
  }
}
