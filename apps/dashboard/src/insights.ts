import type { LedgerEvent, TaskRecord, TaskStatus, Usage } from "@openfactory/contracts";
import { latestScores, scorerDocs } from "@openfactory/scoring";

/**
 * Everything the dashboard shows beyond a single record is computed here, from task
 * records plus their ledger events. Pure functions: the pages and the tests agree.
 */

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["merged", "closed", "failed"]);
export const isOpen = (s: TaskStatus) => !TERMINAL.has(s);

const str = (d: Record<string, unknown>, k: string): string | null => (typeof d[k] === "string" ? (d[k] as string) : null);
const sec = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);

export interface TurnRow {
  n: number;
  reason: string;
  startedAt: string;
  finishedAt: string | null;
  durationS: number | null;
  usage: Usage | null;
  stopReason: string | null;
  summary: string | null;
}

/** Pairs turn_started with the next turn_finished. A turn still running has finishedAt null. */
export function turns(events: readonly LedgerEvent[]): TurnRow[] {
  const out: TurnRow[] = [];
  let open: TurnRow | null = null;
  for (const e of sorted(events)) {
    if (e.type === "turn_started") {
      if (open) out.push(open);
      open = { n: out.length + 1, reason: str(e.data, "reason") ?? "intake", startedAt: e.at, finishedAt: null, durationS: null, usage: null, stopReason: null, summary: null };
    } else if (e.type === "turn_finished") {
      const row: TurnRow = open ?? { n: out.length + 1, reason: str(e.data, "reason") ?? "intake", startedAt: e.at, finishedAt: null, durationS: null, usage: null, stopReason: null, summary: null };
      row.finishedAt = e.at;
      row.durationS = sec(row.startedAt, e.at);
      row.usage = usageOf(e.data.usage);
      row.stopReason = str(e.data, "stopReason");
      row.summary = str(e.data, "summary");
      out.push(row);
      open = null;
    }
  }
  if (open) out.push(open);
  return out.map((r, i) => ({ ...r, n: i + 1 }));
}

function usageOf(v: unknown): Usage | null {
  if (typeof v !== "object" || v === null) return null;
  const u = v as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return { inputTokens: n("inputTokens"), outputTokens: n("outputTokens"), costUsd: n("costUsd") };
}

function sorted(events: readonly LedgerEvent[]): LedgerEvent[] {
  return [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Per-task facts the metrics and inbox need. */
export interface TaskFacts {
  task: TaskRecord;
  prOpenedAt: string | null;
  /** First human comment on the PR, or the first review round, whichever is earlier. */
  firstReviewAt: string | null;
  mergedAt: string | null;
  turns: TurnRow[];
  lastError: string | null;
  /** Conclusion of the latest CI result on the PR's current head, if any check reported. */
  ciOnHead: "success" | "failure" | null;
  deniedHosts: string[];
  /** Latest PR size the server recorded (pr_stats), if any. */
  prSize: { additions: number; deletions: number; changedFiles: number } | null;
  /** PR heads pushed by someone other than the factory (pushed with byFactory false). */
  humanPushes: number;
  transcripts: Array<{ turn: number; key: string; url: string; lines: number }>;
  cancelled: { by: string | null; reason: string | null } | null;
}

export function taskFacts(task: TaskRecord, events: readonly LedgerEvent[]): TaskFacts {
  let prOpenedAt: string | null = null;
  let firstReviewAt: string | null = null;
  let mergedAt: string | null = null;
  let lastError: string | null = null;
  const ci = new Map<string, Map<string, string>>(); // sha → check → conclusion
  const denied = new Set<string>();
  let prSize: TaskFacts["prSize"] = null;
  let humanPushes = 0;
  let cancelled: TaskFacts["cancelled"] = null;
  const transcripts: TaskFacts["transcripts"] = [];
  const int = (k: string, d: Record<string, unknown>) => (typeof d[k] === "number" ? (d[k] as number) : null);
  for (const e of sorted(events)) {
    switch (e.type) {
      case "pr_opened":
        prOpenedAt ??= e.at;
        break;
      case "comment_received":
        if (prOpenedAt !== null && e.data.isBot !== true && e.data.on === "pr") firstReviewAt ??= e.at;
        break;
      case "review_round_started":
        if (prOpenedAt !== null) firstReviewAt ??= e.at;
        break;
      case "status_changed":
        if (e.data.to === "merged") mergedAt ??= e.at;
        if (e.data.to === "working" || e.data.to === "iterating") lastError = null;
        break;
      case "error":
        lastError = str(e.data, "message") ?? "error";
        break;
      case "ci_completed": {
        const sha = str(e.data, "headSha");
        const c = str(e.data, "conclusion");
        if (sha && c && c !== "skipped" && c !== "neutral") ci.set(sha, (ci.get(sha) ?? new Map()).set(str(e.data, "name") ?? "ci", c));
        break;
      }
      case "pr_stats": {
        const a = int("additions", e.data);
        const d = int("deletions", e.data);
        const f = int("changedFiles", e.data);
        if (a !== null && d !== null && f !== null) prSize = { additions: a, deletions: d, changedFiles: f };
        break;
      }
      case "pushed":
        if (e.data.byFactory === false) humanPushes++;
        break;
      case "transcript_saved": {
        const turn = int("turn", e.data);
        const key = str(e.data, "key");
        if (turn !== null && key !== null) transcripts.push({ turn, key, url: str(e.data, "url") ?? "", lines: int("lines", e.data) ?? 0 });
        break;
      }
      case "cancelled":
        cancelled = { by: str(e.data, "by"), reason: str(e.data, "reason") };
        break;
      case "egress":
        if (e.data.allowed === false) {
          const h = str(e.data, "host");
          if (h) denied.add(h);
        }
        break;
    }
  }
  if (task.status === "merged") mergedAt ??= task.outcomes.find((o) => o.kind === "merged")?.at ?? task.updatedAt;
  const head = task.pr?.headSha ?? null;
  const checks = head ? ci.get(head) : undefined;
  const ciOnHead = checks === undefined || checks.size === 0 ? null : [...checks.values()].every((c) => c === "success") ? "success" : "failure";
  return { task, prOpenedAt, firstReviewAt, mergedAt, turns: turns(events), lastError, ciOnHead, deniedHosts: [...denied].sort(), prSize, humanPushes, transcripts, cancelled };
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface Stat {
  value: number | null;
  n: number;
}
const stat = (xs: number[]): Stat => ({ value: median(xs), n: xs.length });

export interface Insights {
  days: number;
  started: number;
  open: number;
  merged: number;
  closed: number;
  failed: number;
  /**
   * Of merged PRs: how many no person pushed a commit to (rate), and how many were merged
   * as first proposed, with no review round (firstTryRate).
   */
  autonomy: { merged: number; noHumanCommits: number; rate: number | null; mergedFirstTry: number; firstTryRate: number | null };
  cycle: { kickoffToPr: Stat; prToFirstReview: Stat; firstReviewToMerge: Stat; prToMerge: Stat; kickoffToMerge: Stat };
  cost: { total: number; medianPerPr: Stat; perMerged: number | null; mostExpensive: TaskFacts[]; bySize: SizeBucket[] };
  daily: Array<{ day: string; opened: number; merged: number }>;
  byStatus: Array<{ status: TaskStatus; n: number }>;
  scorers: ScorerSummary[];
  outcomes: { reverted: number; incidents: number; hotfix: number; rework: number };
}

export interface SizeBucket {
  size: "XS" | "S" | "M" | "L" | "XL";
  /** Lines changed (additions + deletions), upper bound exclusive; null for the last bucket. */
  under: number | null;
  prs: number;
  merged: number;
  medianCostUsd: number | null;
  medianReviewRounds: number | null;
}

const SIZES: Array<{ size: SizeBucket["size"]; under: number | null }> = [
  { size: "XS", under: 10 },
  { size: "S", under: 50 },
  { size: "M", under: 250 },
  { size: "L", under: 1000 },
  { size: "XL", under: null },
];

/** PRs grouped by lines changed, with the median cost of each group. PRs with no recorded size are left out. */
export function costBySize(facts: readonly TaskFacts[]): SizeBucket[] {
  return SIZES.map((b, i) => {
    const lo = i === 0 ? 0 : SIZES[i - 1]!.under!;
    const inB = facts.filter((f) => {
      if (f.prSize === null) return false;
      const n = f.prSize.additions + f.prSize.deletions;
      return n >= lo && (b.under === null || n < b.under);
    });
    return {
      ...b,
      prs: inB.length,
      merged: inB.filter((f) => f.task.status === "merged").length,
      medianCostUsd: median(inB.map((f) => f.task.usage.costUsd)),
      medianReviewRounds: median(inB.map((f) => f.task.people.reviewRounds)),
    };
  });
}

export interface ScorerSummary {
  name: string;
  title: string;
  kind: "pass_fail" | "count" | "usd" | "seconds" | "other";
  measures: string;
  n: number;
  /** pass_fail: share passing. Others: median. */
  value: number | null;
}

/** Metrics over tasks started in the last `days` days. */
export function insights(all: readonly TaskFacts[], now: string, days: number): Insights {
  const since = Date.parse(now) - days * 86_400_000;
  const facts = all.filter((f) => Date.parse(f.task.createdAt) >= since);
  const merged = facts.filter((f) => f.task.status === "merged");
  const withPr = facts.filter((f) => f.task.pr !== null);
  const between = (pick: (f: TaskFacts) => [string | null, string | null]) =>
    stat(
      facts.flatMap((f) => {
        const [a, b] = pick(f);
        return a !== null && b !== null && Date.parse(b) >= Date.parse(a) ? [sec(a, b)] : [];
      }),
    );
  const total = facts.reduce((s, f) => s + f.task.usage.costUsd, 0);
  const firstTry = merged.filter((f) => f.task.people.reviewRounds === 0).length;
  const noHuman = merged.filter((f) => f.humanPushes === 0).length;
  const outcomeCount = (k: string) => facts.filter((f) => f.task.outcomes.some((o) => o.kind === k)).length;

  const statusCounts = new Map<TaskStatus, number>();
  for (const f of facts) statusCounts.set(f.task.status, (statusCounts.get(f.task.status) ?? 0) + 1);

  return {
    days,
    started: facts.length,
    open: facts.filter((f) => isOpen(f.task.status)).length,
    merged: merged.length,
    closed: facts.filter((f) => f.task.status === "closed").length,
    failed: facts.filter((f) => f.task.status === "failed").length,
    autonomy: {
      merged: merged.length,
      noHumanCommits: noHuman,
      rate: merged.length === 0 ? null : noHuman / merged.length,
      mergedFirstTry: firstTry,
      firstTryRate: merged.length === 0 ? null : firstTry / merged.length,
    },
    cycle: {
      kickoffToPr: between((f) => [f.task.createdAt, f.prOpenedAt]),
      prToFirstReview: between((f) => [f.prOpenedAt, f.firstReviewAt]),
      firstReviewToMerge: between((f) => [f.firstReviewAt, f.mergedAt]),
      prToMerge: between((f) => [f.prOpenedAt, f.mergedAt]),
      kickoffToMerge: between((f) => [f.task.createdAt, f.mergedAt]),
    },
    cost: {
      total,
      medianPerPr: stat(withPr.map((f) => f.task.usage.costUsd)),
      perMerged: merged.length === 0 ? null : total / merged.length,
      mostExpensive: [...withPr].sort((a, b) => b.task.usage.costUsd - a.task.usage.costUsd).slice(0, 5),
      bySize: costBySize(withPr),
    },
    daily: daily(facts, now, Math.min(days, 30)),
    byStatus: [...statusCounts.entries()].map(([status, n]) => ({ status, n })).sort((a, b) => b.n - a.n),
    scorers: summarizeScorers(facts.map((f) => f.task)),
    outcomes: { reverted: outcomeCount("reverted"), incidents: outcomeCount("incident_linked"), hotfix: outcomeCount("hotfix"), rework: outcomeCount("rework") },
  };
}

/** One row per day of the window, for the dashboard's charts. */
export interface DayRow {
  day: string;
  started: number;
  opened: number;
  merged: number;
  /** Model spend of tasks started that day. */
  costUsd: number;
  /** Mean model cost of PRs opened that day; null on days with none. */
  costPerPr: number | null;
}

export function dailySeries(all: readonly TaskFacts[], now: string, days: number): DayRow[] {
  const end = Date.parse(now);
  const rows = new Map<string, DayRow & { prCost: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    rows.set(day, { day, started: 0, opened: 0, merged: 0, costUsd: 0, costPerPr: null, prCost: 0 });
  }
  for (const f of all) {
    const s = rows.get(f.task.createdAt.slice(0, 10));
    if (s) {
      s.started++;
      s.costUsd += f.task.usage.costUsd;
    }
    const o = f.prOpenedAt ? rows.get(f.prOpenedAt.slice(0, 10)) : undefined;
    if (o) {
      o.opened++;
      o.prCost += f.task.usage.costUsd;
    }
    const m = f.mergedAt ? rows.get(f.mergedAt.slice(0, 10)) : undefined;
    if (m) m.merged++;
  }
  return [...rows.values()].map(({ prCost, ...r }) => ({ ...r, costPerPr: r.opened === 0 ? null : prCost / r.opened }));
}

function daily(facts: readonly TaskFacts[], now: string, days: number): Array<{ day: string; opened: number; merged: number }> {
  const out = new Map<string, { opened: number; merged: number }>();
  const end = new Date(now);
  for (let i = days - 1; i >= 0; i--) out.set(new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10), { opened: 0, merged: 0 });
  for (const f of facts) {
    const o = f.prOpenedAt && out.get(f.prOpenedAt.slice(0, 10));
    if (o) o.opened++;
    const m = f.mergedAt && out.get(f.mergedAt.slice(0, 10));
    if (m) m.merged++;
  }
  return [...out.entries()].map(([day, v]) => ({ day, ...v }));
}

export function summarizeScorers(tasks: readonly TaskRecord[]): ScorerSummary[] {
  const values = new Map<string, number[]>();
  for (const t of tasks) for (const s of latestScores(t.scores).values()) values.set(s.scorer, [...(values.get(s.scorer) ?? []), s.value]);
  const names = [...new Set([...Object.keys(scorerDocs), ...values.keys()])];
  return names.map((name) => {
    const doc = scorerDocs[name];
    const xs = values.get(name) ?? [];
    const kind = doc?.kind ?? "other";
    return {
      name,
      title: doc?.title ?? name,
      kind,
      measures: doc?.measures ?? "Custom scorer.",
      n: xs.length,
      value: xs.length === 0 ? null : kind === "pass_fail" ? xs.reduce((s, v) => s + v, 0) / xs.length : median(xs),
    };
  });
}

export type InboxKind = "pr_review" | "ci_failing" | "blocked" | "failed";
export interface InboxItem {
  kind: InboxKind;
  facts: TaskFacts;
  since: string;
  detail: string;
}

/**
 * What needs a person now, oldest first within each kind. Items leave the inbox when the
 * task moves on (review given, CI fixed, task retried or closed).
 */
export function inbox(all: readonly TaskFacts[], now: string, failedWithinDays = 7): InboxItem[] {
  const out: InboxItem[] = [];
  for (const f of all) {
    const t = f.task;
    if (t.status === "awaiting_review" && f.ciOnHead === "failure")
      out.push({ kind: "ci_failing", facts: f, since: t.updatedAt, detail: `CI is red on the PR's latest commit. Comment on #${t.pr?.number} to send the agent back.` });
    else if (t.status === "awaiting_review")
      out.push({ kind: "pr_review", facts: f, since: f.prOpenedAt ?? t.updatedAt, detail: t.pr ? `PR #${t.pr.number} is waiting for review.` : "Waiting for review." });
    else if (isOpen(t.status) && f.lastError !== null) out.push({ kind: "blocked", facts: f, since: t.updatedAt, detail: f.lastError });
    else if (t.status === "failed" && f.cancelled === null && sec(t.updatedAt, now) <= failedWithinDays * 86_400)
      out.push({ kind: "failed", facts: f, since: t.updatedAt, detail: f.lastError ?? "The task failed." });
  }
  const order: InboxKind[] = ["blocked", "ci_failing", "pr_review", "failed"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.since.localeCompare(b.since));
}

/** Runs-list filters, read from the query string. */
export interface RunFilter {
  status: "all" | "open" | "done" | TaskStatus;
  q: string;
  repo: string;
  version: string;
  model: string;
  source: string;
}

export function parseFilter(get: (k: string) => string | undefined): RunFilter {
  const v = (k: string) => (get(k) ?? "").trim();
  return { status: (v("status") || "all") as RunFilter["status"], q: v("q"), repo: v("repo"), version: v("version"), model: v("model"), source: v("source") };
}

export function filterTasks(tasks: readonly TaskRecord[], f: RunFilter): TaskRecord[] {
  const q = f.q.toLowerCase();
  return tasks.filter(
    (t) =>
      (f.status === "all" || (f.status === "open" ? isOpen(t.status) : f.status === "done" ? !isOpen(t.status) : t.status === f.status)) &&
      (q === "" || t.title.toLowerCase().includes(q) || t.id.includes(q)) &&
      (f.repo === "" || `${t.source.repo.owner}/${t.source.repo.name}` === f.repo) &&
      (f.version === "" || t.factoryVersion === f.version) &&
      (f.model === "" || t.harness.model === f.model) &&
      (f.source === "" || t.source.kind === f.source),
  );
}
