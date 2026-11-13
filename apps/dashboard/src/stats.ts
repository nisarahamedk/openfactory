import type { TaskRecord } from "@openfactory/contracts";
import { latestScores } from "@openfactory/scoring";

/** Headline numbers for a set of tasks. Pure, so the page and tests agree. */
export interface Rollup {
  tasks: number;
  open: number;
  merged: number;
  closedOrFailed: number;
  totalCostUsd: number;
  /** Total spend divided by merged changes only: what a merged change really costs. */
  costPerMergedUsd: number | null;
  meanReviewRounds: number | null;
  ciFirstPassRate: number | null;
  medianLeadTimeS: number | null;
}

const OPEN = new Set(["received", "preparing", "working", "awaiting_review", "iterating"]);

export function rollup(tasks: readonly TaskRecord[]): Rollup {
  const merged = tasks.filter((t) => t.status === "merged");
  const total = tasks.reduce((s, t) => s + t.usage.costUsd, 0);
  const withPr = tasks.filter((t) => t.pr !== null);
  const ci = tasks.map((t) => latestScores(t.scores).get("facts.ci_first_pass")?.value).filter((v): v is number => v !== undefined);
  const lead = tasks
    .map((t) => latestScores(t.scores).get("facts.lead_time_s")?.value)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  return {
    tasks: tasks.length,
    open: tasks.filter((t) => OPEN.has(t.status)).length,
    merged: merged.length,
    closedOrFailed: tasks.filter((t) => t.status === "closed" || t.status === "failed").length,
    totalCostUsd: total,
    costPerMergedUsd: merged.length === 0 ? null : total / merged.length,
    meanReviewRounds: withPr.length === 0 ? null : withPr.reduce((s, t) => s + t.people.reviewRounds, 0) / withPr.length,
    ciFirstPassRate: ci.length === 0 ? null : ci.reduce((s, v) => s + v, 0) / ci.length,
    medianLeadTimeS: lead.length === 0 ? null : (lead[Math.floor((lead.length - 1) / 2)] ?? null),
  };
}

/** Rollups per factory version, newest-first by latest task. */
export function byFactoryVersion(tasks: readonly TaskRecord[]): Array<{ version: string; lastSeen: string; rollup: Rollup }> {
  const groups = new Map<string, TaskRecord[]>();
  for (const t of tasks) groups.set(t.factoryVersion, [...(groups.get(t.factoryVersion) ?? []), t]);
  return [...groups.entries()]
    .map(([version, ts]) => ({ version, lastSeen: ts.map((t) => t.createdAt).sort().at(-1) ?? "", rollup: rollup(ts) }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
