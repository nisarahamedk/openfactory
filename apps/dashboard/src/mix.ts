/**
 * A team's benchmark suite against the work the team really does. A suite picked by hand drifts from
 * the live task mix (say, all UI tweaks while the team mostly fixes bugs), so a headline pass rate from
 * it misleads. Here each benchmark result is re-weighted by how common its kind of task is in the team's
 * live work (post-stratification), and the share of live work the suite doesn't cover at all is shown
 * instead of being silently ignored.
 */
import { teamFor, type BenchmarkTask, type TaskRecord, type Team } from "@openfactory/contracts";

export const CATEGORIES = ["ui", "bug", "feature", "test", "docs", "refactor", "infra", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = { ui: "UI tweak", bug: "Bug fix", feature: "Feature", test: "Tests", docs: "Docs", refactor: "Refactor", infra: "Infra and deps", other: "Other" };

const BY_LABEL: Array<[RegExp, Category]> = [
  [/^(ui|design|css|copy)$/, "ui"],
  [/^(bug|fix|regression|hotfix)$/, "bug"],
  [/^(test|tests|e2e)$/, "test"],
  [/^(docs?|documentation)$/, "docs"],
  [/^(refactor|cleanup|tech-debt)$/, "refactor"],
  [/^(infra|deps|dependencies|ci|build|platform)$/, "infra"],
  [/^(feature|enhancement)$/, "feature"],
];
const BY_TITLE: Array<[RegExp, Category]> = [
  [/\b(fix|bug|broken|crash|error|wrong|regression)\b/i, "bug"],
  [/\b(tests?|e2e|coverage)\b/i, "test"],
  [/\b(docs?|readme|document|agents\.md)\b/i, "docs"],
  [/\b(refactor|clean ?up|rename|extract)\b/i, "refactor"],
  [/\b(bump|upgrade|dependenc|ci|pipeline|build|docker|helm|deploy)\b/i, "infra"],
  [/\b(button|page|style|layout|copy|text|link|colou?r|ui|screen|mobile)\b/i, "ui"],
  [/\b(add|new|support|allow|let)\b/i, "feature"],
];

/** What kind of work a task is: its labels first, then words in its title. */
export function categoryOf(t: { title: string; labels?: string[] | undefined }): Category {
  for (const l of t.labels ?? []) for (const [re, c] of BY_LABEL) if (re.test(l.toLowerCase())) return c;
  for (const [re, c] of BY_TITLE) if (re.test(t.title)) return c;
  return "other";
}

export type Mix = Map<Category, number>;
const count = <T>(xs: T[], cat: (x: T) => Category): Mix => {
  const m: Mix = new Map();
  for (const x of xs) m.set(cat(x), (m.get(cat(x)) ?? 0) + 1);
  return m;
};
export const share = (m: Mix, c: Category) => {
  const n = [...m.values()].reduce((a, b) => a + b, 0);
  return n === 0 ? 0 : (m.get(c) ?? 0) / n;
};

export type ArmScore = { label: string; version: string; model: string; raw: { pass: number | null; cost: number | null; n: number }; weighted: { pass: number | null; cost: number | null } };

export type TeamSuite = {
  team: Team;
  suite: BenchmarkTask[];
  live: TaskRecord[];
  liveMix: Mix;
  suiteMix: Mix;
  /** Share of the team's live work whose kind has at least one benchmark task. */
  coverage: number;
  /** The newest run that used this suite's tasks: each arm raw and re-weighted to the live mix. */
  run: { id: string; arms: ArmScore[] } | null;
};

type RunLike = {
  id: string;
  createdAt: string;
  arms: Array<{ label: string; factoryVersion: string; model: string }>;
  results: Array<{ arm: string; benchmarkTaskId: string; passed: boolean; usage: { costUsd: number } }>;
};

/**
 * Re-weight per-kind results by the live mix. Kinds with no results don't count (that's `coverage`).
 * Returns null when no kind with live work has results.
 */
export function reweight(perKind: Map<Category, { pass: number; cost: number; n: number }>, liveMix: Mix): { pass: number | null; cost: number | null } {
  let w = 0;
  let pass = 0;
  let cost = 0;
  for (const [c, r] of perKind) {
    const s = share(liveMix, c);
    if (r.n === 0 || s === 0) continue;
    w += s;
    pass += s * (r.pass / r.n);
    cost += s * (r.cost / r.n);
  }
  return w === 0 ? { pass: null, cost: null } : { pass: pass / w, cost: cost / w };
}

/** Each team's suite (its benchmark tasks: from its own tasks, or named in its factory) against its last `days` of work. */
export function teamSuites(input: {
  teams: Team[];
  factories: Array<{ slug: string; benchmarks: string[] }>;
  bench: BenchmarkTask[];
  tasks: TaskRecord[];
  runs: RunLike[];
  now: string;
  days?: number;
}): TeamSuite[] {
  const days = input.days ?? 30;
  const since = Date.parse(input.now) - days * 86_400_000;
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const benchCat = (b: BenchmarkTask): Category => {
    const t = byId.get(b.sourceTaskId);
    return t ? categoryOf(t) : categoryOf({ title: b.ask.split("\n")[0] ?? "" });
  };
  return input.teams.map((team) => {
    const named = new Set(input.factories.find((f) => f.slug === team.factory)?.benchmarks ?? []);
    const suite = input.bench.filter((b) => {
      if (named.has(b.id)) return true;
      const t = byId.get(b.sourceTaskId);
      return t ? teamFor(input.teams, { requestedBy: t.requestedBy, repo: t.source.repo })?.slug === team.slug : false;
    });
    const live = input.tasks.filter((t) => t.source.kind !== "benchmark_replay" && Date.parse(t.createdAt) >= since && teamFor(input.teams, { requestedBy: t.requestedBy, repo: t.source.repo })?.slug === team.slug);
    const liveMix = count(live, categoryOf);
    const suiteMix = count(suite, benchCat);
    const coverage = CATEGORIES.reduce((a, c) => a + ((suiteMix.get(c) ?? 0) > 0 ? share(liveMix, c) : 0), 0);
    const ids = new Set(suite.map((b) => b.id));
    const catOf = new Map(suite.map((b) => [b.id, benchCat(b)]));
    const run = [...input.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((r) => r.results.some((x) => ids.has(x.benchmarkTaskId)));
    return {
      team,
      suite,
      live,
      liveMix,
      suiteMix,
      coverage: live.length ? coverage : 0,
      run: run
        ? {
            id: run.id,
            arms: run.arms.map((a) => {
              const mine = run.results.filter((x) => x.arm === a.label && ids.has(x.benchmarkTaskId));
              const perKind = new Map<Category, { pass: number; cost: number; n: number }>();
              for (const x of mine) {
                const c = catOf.get(x.benchmarkTaskId) ?? "other";
                const k = perKind.get(c) ?? { pass: 0, cost: 0, n: 0 };
                perKind.set(c, { pass: k.pass + (x.passed ? 1 : 0), cost: k.cost + x.usage.costUsd, n: k.n + 1 });
              }
              const n = mine.length;
              return {
                label: a.label,
                version: a.factoryVersion,
                model: a.model,
                raw: { pass: n ? mine.filter((x) => x.passed).length / n : null, cost: n ? mine.reduce((s, x) => s + x.usage.costUsd, 0) / n : null, n },
                weighted: reweight(perKind, liveMix),
              };
            }),
          }
        : null,
    };
  });
}
