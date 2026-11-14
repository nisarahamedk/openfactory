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
  /** Mean cost divided by pass rate: what one passing change costs. Null when nothing passed. */
  costPerPassUsd: number | null;
}

export interface ABReport {
  a: ArmSummary;
  b: ArmSummary;
  /** B minus A pass rate, with a 95% bootstrap range (tasks resampled, then attempts). */
  passRateDiff: { estimate: number; low: number; high: number };
  costDiffUsd: number;
  /** B's mean cost over A's, with a 95% bootstrap range. 0.8 means B costs 20% less. Null when A cost nothing. */
  costRatio: { estimate: number; low: number; high: number } | null;
  /** Tasks where the arms' pass rates differ by at least half. */
  flips: Array<{ benchmarkTaskId: string; a: number; b: number }>;
  /**
   * Pass rate and cost judged together. b_better / a_better: passes more (or as often and clearly cheaper)
   * without clearly costing more. trade_off: one passes more, the other is clearly cheaper. too_close: neither.
   */
  verdict: "b_better" | "a_better" | "trade_off" | "too_close";
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
    costPerPassUsd: passes === 0 ? null : rs.reduce((s, r) => s + r.usage.costUsd, 0) / passes,
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
    a: ra.filter((r) => r.benchmarkTaskId === id),
    b: rb.filter((r) => r.benchmarkTaskId === id),
  }));

  // Two-level bootstrap: resample tasks, then attempts within each arm of each task.
  const rand = rng(opts.seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const diffs: number[] = [];
  const ratios: number[] = [];
  const mean = (xs: ArmResult[]) => (xs.length ? xs.reduce((s, r) => s + r.usage.costUsd, 0) / xs.length : 0);
  for (let i = 0; i < opts.resamples; i++) {
    const as: ArmResult[] = [];
    const bs: ArmResult[] = [];
    for (let t = 0; t < byTask.length; t++) {
      const task = pick(byTask);
      for (let k = 0; k < task.a.length; k++) as.push(pick(task.a));
      for (let k = 0; k < task.b.length; k++) bs.push(pick(task.b));
    }
    diffs.push(rate(bs.map((r) => r.passed)) - rate(as.map((r) => r.passed)));
    const ca = mean(as);
    if (ca > 0) ratios.push(mean(bs) / ca);
  }
  const quantile = (xs: number[], p: number) => {
    const ys = [...xs].sort((x, y) => x - y);
    return ys[Math.min(ys.length - 1, Math.max(0, Math.floor(p * ys.length)))] ?? 0;
  };
  const estimate = sb.passRate - sa.passRate;
  const low = quantile(diffs, 0.025);
  const high = quantile(diffs, 0.975);
  const costRatio = sa.meanCostUsd > 0 && ratios.length ? { estimate: sb.meanCostUsd / sa.meanCostUsd, low: quantile(ratios, 0.025), high: quantile(ratios, 0.975) } : null;
  // Cost counts as clearly different only when its whole range sits outside a 10% band.
  const bCheaper = costRatio !== null && costRatio.high < 0.9;
  const bDearer = costRatio !== null && costRatio.low > 1.1;
  const passB = low > 0;
  const passA = high < 0;
  // Passing more while costing more is still a win when a passing change costs no more (cost per pass).
  const perPass = (x: ArmSummary) => x.costPerPassUsd ?? Number.POSITIVE_INFINITY;
  const verdict: ABReport["verdict"] =
    (passB && bDearer && perPass(sb) > perPass(sa)) || (passA && bCheaper && perPass(sa) > perPass(sb)) ? "trade_off" : passB || (!passA && bCheaper) ? "b_better" : passA || (!passB && bDearer) ? "a_better" : "too_close";

  const flips = byTask
    .map((t) => ({ benchmarkTaskId: t.id, a: rate(t.a.map((r) => r.passed)), b: rate(t.b.map((r) => r.passed)) }))
    .filter((t) => Math.abs(t.a - t.b) >= 0.5);

  const pts = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)} pts`;
  const costDiffUsd = sb.meanCostUsd - sa.meanCostUsd;
  const pct = (x: number) => `${x >= 1 ? "+" : "-"}${Math.round(Math.abs(x - 1) * 100)}%`;
  const cost = costRatio ? `cost ${pct(costRatio.estimate)} (range ${pct(costRatio.low)} to ${pct(costRatio.high)})` : `cost ${costDiffUsd >= 0 ? "+" : "-"}$${Math.abs(costDiffUsd).toFixed(2)} per run`;
  const pass = `pass ${pts(estimate)} (range ${pts(low)} to ${pts(high)})`;
  const winner = verdict === "b_better" ? b : a;
  const why = passB || passA ? "passes more" : "passes as often and costs less";
  const summary =
    verdict === "too_close"
      ? `Too close to call: ${b} vs ${a} is ${pass}, ${cost}, over ${sa.attempts}+${sb.attempts} runs on ${taskIds.length} task(s). Run more repeats.`
      : verdict === "trade_off"
        ? `A trade-off: ${b} vs ${a} is ${pass} but ${cost}. Pick by what a passing change is worth to you.`
        : `${winner} is better (${why}): ${b} vs ${a} is ${pass}, ${cost}.`;

  return { a: sa, b: sb, passRateDiff: { estimate, low, high }, costDiffUsd, costRatio, flips, verdict, summary };
}
