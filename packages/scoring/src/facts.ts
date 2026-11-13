import type { LedgerEvent, Score, Scorer, TaskRecord, TaskStatus } from "@openfactory/contracts";
import { parseEvents } from "./events.js";

/**
 * Built-in fact scorers. Facts are things that happened, not opinions: they are free,
 * hard to argue with, and computed from the task record plus its event log.
 * Each scorer is versioned; bump the version when its meaning changes so old and new
 * scores are never mixed.
 */

const TERMINAL: ReadonlySet<TaskStatus> = new Set(["merged", "closed", "failed"]);

function score(name: string, version: string, now: string, value: number, label: string | null, reason: string): Score {
  return { scorer: name, scorerVersion: version, value, label, reason, at: now };
}

/** 1 if the PR was merged, 0 if the task ended any other way, null while still open. */
export const mergedScorer: Scorer = {
  name: "facts.merged",
  version: "1",
  score(record, _events, now) {
    if (record.status === "merged") return score(this.name, this.version, now, 1, "merged", "PR merged by a human");
    if (record.status === "closed" || record.status === "failed")
      return score(this.name, this.version, now, 0, record.status, `task ended as ${record.status} without a merge`);
    return null;
  },
};

/**
 * Number of review rounds: agent turns woken by review feedback. Falls back to
 * record.people.reviewRounds when the event log has no turn events.
 * Applies once a PR exists.
 */
export const reviewRoundsScorer: Scorer = {
  name: "facts.review_rounds",
  version: "1",
  score(record, events, now) {
    if (record.pr === null) return null;
    const turns = parseEvents(events).turns;
    const rounds = turns.length > 0 ? turns.filter((t) => t.reason === "review").length : record.people.reviewRounds;
    return score(this.name, this.version, now, rounds, `${rounds} round${rounds === 1 ? "" : "s"}`, "agent turns started by PR review feedback");
  },
};

/**
 * 1 if the first CI result on the PR's first commit was green, 0 if it was red.
 * Uses the PR-opened head SHA, else the first push; null until a result for it arrives.
 * When several checks report on that SHA, all must pass.
 */
export const ciFirstPassScorer: Scorer = {
  name: "facts.ci_first_pass",
  version: "1",
  score(record, events, now) {
    const parsed = parseEvents(events);
    const firstSha = parsed.prOpened?.headSha ?? parsed.pushes[0]?.sha ?? null;
    if (firstSha === null) return null;
    const runs = parsed.ciRuns.filter((r) => r.headSha === firstSha && r.conclusion !== "skipped" && r.conclusion !== "neutral");
    if (runs.length === 0) return null;
    // Latest result per check name on that SHA (re-runs replace earlier results).
    const byName = new Map<string, string>();
    for (const r of runs) byName.set(r.name, r.conclusion);
    const failed = [...byName.entries()].filter(([, c]) => c !== "success");
    if (failed.length === 0)
      return score(this.name, this.version, now, 1, "pass", `all ${byName.size} check(s) green on first commit ${firstSha.slice(0, 7)}`);
    return score(this.name, this.version, now, 0, "fail", `failed on first commit ${firstSha.slice(0, 7)}: ${failed.map(([n, c]) => `${n}=${c}`).join(", ")}`);
  },
};

/** Total model cost in USD so far (record.usage.costUsd). Always applies. */
export const costScorer: Scorer = {
  name: "facts.cost_usd",
  version: "1",
  score(record, _events, now) {
    const usd = record.usage.costUsd;
    return score(
      this.name,
      this.version,
      now,
      usd,
      `$${usd.toFixed(2)}`,
      `${record.usage.inputTokens} input + ${record.usage.outputTokens} output tokens`,
    );
  },
};

/** Seconds from the task being received to its terminal state; null while still open. */
export const leadTimeScorer: Scorer = {
  name: "facts.lead_time_s",
  version: "1",
  score(record, events, now) {
    if (!TERMINAL.has(record.status)) return null;
    const changes = parseEvents(events).statusChanges;
    const end = [...changes].reverse().find((c) => TERMINAL.has(c.to))?.at ?? record.updatedAt;
    const seconds = Math.max(0, (Date.parse(end) - Date.parse(record.createdAt)) / 1000);
    return score(this.name, this.version, now, seconds, formatDuration(seconds), `received → ${record.status}`);
  },
};

/** Seconds spent in each status, computed from status_changed events. */
export function timeInStages(record: TaskRecord, events: LedgerEvent[], now: string): Map<TaskStatus, number> {
  const changes = parseEvents(events).statusChanges;
  const totals = new Map<TaskStatus, number>();
  let current: TaskStatus = "received";
  let since = record.createdAt;
  for (const c of changes) {
    add(totals, current, since, c.at);
    current = c.to;
    since = c.at;
  }
  if (!TERMINAL.has(current)) add(totals, current, since, now);
  return totals;
}

function add(totals: Map<TaskStatus, number>, status: TaskStatus, from: string, to: string): void {
  const s = Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
  totals.set(status, (totals.get(status) ?? 0) + s);
}

/**
 * One scorer per stage, value = seconds spent there. Null when the log has no status
 * changes (we can't tell stages apart without them).
 */
export function stageTimeScorer(stage: TaskStatus): Scorer {
  return {
    name: `facts.stage_s.${stage}`,
    version: "1",
    score(record, events, now) {
      if (parseEvents(events).statusChanges.length === 0) return null;
      const seconds = timeInStages(record, events, now).get(stage) ?? 0;
      return score(this.name, this.version, now, seconds, formatDuration(seconds), `time in "${stage}"`);
    },
  };
}

const STAGES: TaskStatus[] = ["received", "preparing", "working", "awaiting_review", "iterating"];

/** Every built-in fact scorer, in display order. */
export const factScorers: Scorer[] = [
  mergedScorer,
  reviewRoundsScorer,
  ciFirstPassScorer,
  costScorer,
  leadTimeScorer,
  ...STAGES.map(stageTimeScorer),
];

/** "1h 4m", "3m 20s", "12s". */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
