import type { ReplayResult } from "@openfactory/contracts";

/** Replay results tagged with the arm they ran under. */
export type ArmResult = ReplayResult & { arm: string };

export interface ArmSummary {
  arm: string;
  factoryVersion: string;
  attempts: number;
  passes: number;
  passRate: number;
  meanCostUsd: number;
  meanDurationS: number;
}

export interface ABReport {
  a: ArmSummary;
  b: ArmSummary;
  /** B minus A pass rate, with a 95% bootstrap range (tasks resampled, then attempts). */
  passRateDiff: { estimate: number; low: number; high: number };
  costDiffUsd: number;
  /** Tasks where the arms' pass rates differ by at least half. */
  flips: Array<{ benchmarkTaskId: string; a: number; b: number }>;
  verdict: "b_better" | "a_better" | "too_close";
  /** One plain sentence for the page. */
  summary: string;
}

function summarize(arm: string, rs: ArmResult[]): ArmSummary {
  const n = rs.length;
  const passes = rs.filter((r) => r.passed).length;
  return {
    arm,
    factoryVersion: rs[0]?.factoryVersion ?? "",
    attempts: n,
    passes,
    passRate: n === 0 ? 0 : passes / n,
    meanCostUsd: n === 0 ? 0 : rs.reduce((s, r) => s + r.usage.costUsd, 0) / n,
    meanDurationS: n === 0 ? 0 : rs.reduce((s, r) => s + r.durationMs, 0) / n / 1000,
  };
}

/** Small seeded PRNG (mulberry32) so a report is reproducible from its results. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rate(xs: boolean[]): number {
  return xs.length === 0 ? 0 : xs.filter(Boolean).length / xs.length;
}

/** Compare arm `a` and arm `b`. Needs at least one result per arm. */
export function compareArms(results: ArmResult[], a: string, b: string, opts = { resamples: 2000, seed: 7 }): ABReport {
  const ra = results.filter((r) => r.arm === a);
  const rb = results.filter((r) => r.arm === b);
  const sa = summarize(a, ra);
  const sb = summarize(b, rb);

  const taskIds = [...new Set(results.map((r) => r.benchmarkTaskId))].sort();
  const byTask = taskIds.map((id) => ({
    id,
    a: ra.filter((r) => r.benchmarkTaskId === id).map((r) => r.passed),
    b: rb.filter((r) => r.benchmarkTaskId === id).map((r) => r.passed),
  }));

  // Two-level bootstrap: resample tasks, then attempts within each arm of each task.
  const rand = rng(opts.seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const diffs: number[] = [];
  for (let i = 0; i < opts.resamples; i++) {
    const as: boolean[] = [];
    const bs: boolean[] = [];
    for (let t = 0; t < byTask.length; t++) {
      const task = pick(byTask);
      for (let k = 0; k < task.a.length; k++) as.push(pick(task.a));
      for (let k = 0; k < task.b.length; k++) bs.push(pick(task.b));
    }
    diffs.push(rate(bs) - rate(as));
  }
  diffs.sort((x, y) => x - y);
  const q = (p: number) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor(p * diffs.length)))] ?? 0;
  const estimate = sb.passRate - sa.passRate;
  const low = q(0.025);
  const high = q(0.975);
  const verdict = low > 0 ? "b_better" : high < 0 ? "a_better" : "too_close";

  const flips = byTask
    .map((t) => ({ benchmarkTaskId: t.id, a: rate(t.a), b: rate(t.b) }))
    .filter((t) => Math.abs(t.a - t.b) >= 0.5);

  const pts = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)} pts`;
  const costDiffUsd = sb.meanCostUsd - sa.meanCostUsd;
  const summary =
    verdict === "too_close"
      ? `Too close to call: ${b} vs ${a} is ${pts(estimate)} (range ${pts(low)} to ${pts(high)}) over ${sa.attempts}+${sb.attempts} runs on ${taskIds.length} task(s). Run more repeats.`
      : `${verdict === "b_better" ? b : a} is better: ${b} vs ${a} is ${pts(estimate)} (range ${pts(low)} to ${pts(high)}), cost ${costDiffUsd >= 0 ? "+" : "-"}$${Math.abs(costDiffUsd).toFixed(2)} per run.`;

  return { a: sa, b: sb, passRateDiff: { estimate, low, high }, costDiffUsd, flips, verdict, summary };
}
