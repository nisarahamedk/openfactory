/**
 * The app's one data model: scopes (org › team › person), filters, and the Insights explorer
 * (measure × group by × split). Every page reads tasks through the same scope and filters, so a
 * number on any page opens exactly the tasks behind it.
 */
import type { Team, TaskRecord } from "@openfactory/contracts";
import { isOpen, median, type TaskFacts } from "./insights.js";

// ───────────────────────────── scope ─────────────────────────────

export type Scope = { kind: "org" } | { kind: "team"; team: string } | { kind: "person"; login: string };

export function parseScope(v: string | undefined): Scope {
  if (v?.startsWith("team:") && v.length > 5) return { kind: "team", team: v.slice(5) };
  if (v?.startsWith("person:") && v.length > 7) return { kind: "person", login: v.slice(7) };
  return { kind: "org" };
}

export const scopeParam = (s: Scope) => (s.kind === "org" ? "org" : s.kind === "team" ? `team:${s.team}` : `person:${s.login}`);

export const repoOf = (t: TaskRecord) => `${t.source.repo.owner}/${t.source.repo.name}`;
export const reposOf = (t: TaskRecord) => [repoOf(t), ...(t.repos ?? []).map((r) => `${r.repo.owner}/${r.repo.name}`)];

/** The teams a task belongs to: the team of whoever asked, else the teams owning its repos. */
export function teamsOf(t: TaskRecord, teams: readonly Team[]): Team[] {
  const who = t.requestedBy?.toLowerCase();
  const byPerson = who ? teams.filter((x) => x.members.some((m) => m.login.toLowerCase() === who)) : [];
  if (byPerson.length > 0) return byPerson;
  const repos = new Set(reposOf(t).map((r) => r.toLowerCase()));
  return teams.filter((x) => x.repos.some((r) => repos.has(r.toLowerCase())));
}

export function inScope(t: TaskRecord, s: Scope, teams: readonly Team[]): boolean {
  if (s.kind === "org") return true;
  if (s.kind === "person") return (t.requestedBy ?? "").toLowerCase() === s.login.toLowerCase();
  return teamsOf(t, teams).some((x) => x.slug === s.team);
}

/** Breadcrumb for a scope: Org › Team › person. A person's team is the first one they belong to. */
export function scopePath(s: Scope, teams: readonly Team[]): Array<{ label: string; scope: Scope }> {
  const org = { label: "Org", scope: { kind: "org" } as Scope };
  if (s.kind === "org") return [org];
  if (s.kind === "team") return [org, { label: teams.find((t) => t.slug === s.team)?.name ?? s.team, scope: s }];
  const team = teams.find((t) => t.members.some((m) => m.login.toLowerCase() === s.login.toLowerCase()));
  return team ? [org, { label: team.name, scope: { kind: "team", team: team.slug } }, { label: s.login, scope: s }] : [org, { label: s.login, scope: s }];
}

// ───────────────────────────── per-task dimensions ─────────────────────────────

const KINDS: Array<[string, RegExp]> = [
  ["Tests", /\b(tests?|e2e|flaky|spec)\b/i],
  ["Data and migrations", /\b(migrat\w*|schema|database|db|sql|drizzle|backfill)\b/i],
  ["Dependencies", /\b(upgrade|bump|dependenc\w*|deps)\b/i],
  ["Docs", /\b(docs?|readme|changelog)\b/i],
  ["UI and copy", /\b(ui|page|button|copy|style|css|layout|dark mode|design|screen|modal|banner)\b/i],
  ["API", /\b(api|endpoint|webhook|route|graphql|rest)\b/i],
  ["Bug fixes", /\b(fix\w*|bug|crash|error|broken|regression)\b/i],
];
export const KIND_NAMES = [...KINDS.map((k) => k[0]), "Features"];

/** What kind of work a task is: a `kind:<name>` label wins, else words in its title. */
export function kindOf(t: TaskRecord): string {
  const label = (t.labels ?? []).find((l) => l.startsWith("kind:"));
  if (label) {
    const want = label.slice(5).toLowerCase();
    return KIND_NAMES.find((k) => k.toLowerCase().startsWith(want)) ?? label.slice(5);
  }
  return KINDS.find(([, re]) => re.test(t.title))?.[0] ?? "Features";
}

const CAME_BACK = new Set(["reverted", "hotfix", "rework", "incident_linked"]);
export const HELD_UP_DAYS = 30;

/** What came back after the merge (reverts, fixes, rework, incidents), oldest first. */
export const cameBack = (t: TaskRecord) => t.outcomes.filter((o) => CAME_BACK.has(o.kind)).sort((a, b) => a.at.localeCompare(b.at));

export type Life = "asked" | "working" | "review" | "merged" | "after" | "held" | "came_back" | "failed" | "stopped";

/** Where a task is in its life: asked → agent work → PR → review → merged → after merge. */
export function lifeOf(f: TaskFacts, now: string): Life {
  const t = f.task;
  if (t.status === "merged") {
    if (cameBack(t).length > 0) return "came_back";
    const age = f.mergedAt ? (Date.parse(now) - Date.parse(f.mergedAt)) / 86_400_000 : 0;
    return age >= HELD_UP_DAYS ? "held" : "after";
  }
  if (t.status === "failed") return f.cancelled ? "stopped" : "failed";
  if (t.status === "closed") return "stopped";
  if (t.status === "awaiting_review") return "review";
  if (t.status === "received") return "asked";
  return "working";
}

// ───────────────────────────── filters ─────────────────────────────

export interface Filters {
  scope: Scope;
  /** Tasks created in the last `days` days; 0 = all time. */
  days: number;
  repo: string;
  model: string;
  version: string;
  kind: string;
  person: string;
  team: string;
  risk: string;
  /** "open" | "review" | "merged" | "came_back" | "failed" | "" */
  state: string;
  q: string;
}

export const FILTER_KEYS = ["repo", "model", "version", "kind", "person", "team", "risk", "state", "q"] as const;

export function parseFilters(get: (k: string) => string | undefined, fallbackScope: Scope = { kind: "org" }): Filters {
  const v = (k: string) => (get(k) ?? "").trim();
  const d = Number(get("days") ?? 30);
  return {
    scope: get("scope") ? parseScope(get("scope")) : fallbackScope,
    days: [0, 7, 30, 90, 365].includes(d) ? d : 30,
    repo: v("repo"),
    model: v("model"),
    version: v("version"),
    kind: v("kind"),
    person: v("person"),
    team: v("team"),
    risk: v("risk"),
    state: v("state"),
    q: v("q"),
  };
}

/** The query string for filters, with `over` merged in ("" removes a key). Scope and days always kept. */
export function filterQuery(f: Filters, over: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  p.set("scope", scopeParam(f.scope));
  p.set("days", String(f.days));
  for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]);
  for (const [k, v] of Object.entries(over)) v === "" ? p.delete(k) : p.set(k, v);
  return p.toString();
}

export function matches(fa: TaskFacts, f: Filters, teams: readonly Team[], now: string): boolean {
  const t = fa.task;
  if (!inScope(t, f.scope, teams)) return false;
  if (f.days > 0 && Date.parse(now) - Date.parse(t.createdAt) > f.days * 86_400_000) return false;
  if (f.repo && !reposOf(t).includes(f.repo)) return false;
  if (f.model && t.harness.model !== f.model) return false;
  if (f.version && t.factoryVersion !== f.version) return false;
  if (f.kind && kindOf(t) !== f.kind) return false;
  if (f.person && (t.requestedBy ?? "") !== f.person) return false;
  if (f.team && !teamsOf(t, teams).some((x) => x.slug === f.team)) return false;
  if (f.risk && (t.risk?.level ?? "none") !== f.risk) return false;
  if (f.state) {
    const life = lifeOf(fa, now);
    const ok =
      f.state === "open" ? isOpen(t.status) :
      f.state === "review" ? life === "review" :
      f.state === "merged" ? t.status === "merged" :
      f.state === "came_back" ? life === "came_back" :
      f.state === "held" ? life === "held" :
      f.state === "failed" ? life === "failed" || life === "stopped" :
      true;
    if (!ok) return false;
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!t.title.toLowerCase().includes(q) && !t.id.includes(q) && !(t.pr && `#${t.pr.number}` === q)) return false;
  }
  return true;
}

// ───────────────────────────── measures ─────────────────────────────

export type Unit = "count" | "pct" | "usd" | "hours" | "num";

export interface Measure {
  id: string;
  label: string;
  /** One line on what it counts, shown under the chart. */
  means: string;
  unit: Unit;
  /** Lower is better (cost, wait, came back). */
  lowerIsBetter: boolean;
  /** Which tasks the number is about (the denominator), and which of those count. */
  value(fs: readonly TaskFacts[], now: string): { value: number | null; n: number; of: readonly TaskFacts[] };
  /** The state filter that opens the tasks the number counts. */
  opens?: string;
  /** What `n` counts, e.g. "merged changes". */
  of: string;
}

const merged = (fs: readonly TaskFacts[]) => fs.filter((f) => f.task.status === "merged");
const hours = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
const pct = (a: number, b: number) => (b === 0 ? null : a / b);

export const MEASURES: Measure[] = [
  {
    id: "merged",
    of: "tasks",
    label: "Merged changes",
    means: "Tasks whose PR a person merged.",
    unit: "count",
    lowerIsBetter: false,
    value: (fs) => ({ value: merged(fs).length, n: fs.length, of: merged(fs) }),
    opens: "merged",
  },
  {
    id: "came_back",
    of: "merged changes",
    label: "Came back after merge",
    means: "Share of merged changes later reverted, fixed again, reworked or linked to an incident.",
    unit: "pct",
    lowerIsBetter: true,
    value: (fs) => {
      const m = merged(fs);
      const back = m.filter((f) => cameBack(f.task).length > 0);
      return { value: pct(back.length, m.length), n: m.length, of: back };
    },
    opens: "came_back",
  },
  {
    id: "held_up",
    of: "changes merged 30+ days ago",
    label: `Held up ${HELD_UP_DAYS} days`,
    means: `Share of changes merged at least ${HELD_UP_DAYS} days ago with nothing coming back.`,
    unit: "pct",
    lowerIsBetter: false,
    value: (fs, now) => {
      const old = merged(fs).filter((f) => f.mergedAt && hours(f.mergedAt, now) >= HELD_UP_DAYS * 24);
      const held = old.filter((f) => cameBack(f.task).length === 0);
      return { value: pct(held.length, old.length), n: old.length, of: held };
    },
    opens: "held",
  },
  {
    id: "merge_rate",
    of: "finished tasks",
    label: "Merge rate",
    means: "Of tasks that finished, the share that merged (the rest failed, were stopped or closed).",
    unit: "pct",
    lowerIsBetter: false,
    value: (fs) => {
      const done = fs.filter((f) => !isOpen(f.task.status));
      return { value: pct(merged(done).length, done.length), n: done.length, of: merged(done) };
    },
    opens: "merged",
  },
  {
    id: "cost_per_merged",
    of: "merged changes",
    label: "Cost per merged change",
    means: "All model spend in the group, failed tasks included, divided by merged changes.",
    unit: "usd",
    lowerIsBetter: true,
    value: (fs) => {
      const m = merged(fs).length;
      return { value: m === 0 ? null : fs.reduce((s, f) => s + f.task.usage.costUsd, 0) / m, n: m, of: fs };
    },
  },
  {
    id: "cost",
    of: "tasks",
    label: "Spend",
    means: "Model spend on these tasks.",
    unit: "usd",
    lowerIsBetter: true,
    value: (fs) => ({ value: fs.reduce((s, f) => s + f.task.usage.costUsd, 0), n: fs.length, of: fs }),
  },
  {
    id: "review_wait",
    of: "reviewed PRs",
    label: "Time waiting for review",
    means: "Median hours from the PR opening to the first person reviewing it.",
    unit: "hours",
    lowerIsBetter: true,
    value: (fs) => {
      const w = fs.filter((f) => f.prOpenedAt && f.firstReviewAt);
      return { value: median(w.map((f) => hours(f.prOpenedAt!, f.firstReviewAt!))), n: w.length, of: w };
    },
  },
  {
    id: "time_to_merge",
    of: "merged changes",
    label: "Time to merge",
    means: "Median hours from the ask to the merge.",
    unit: "hours",
    lowerIsBetter: true,
    value: (fs) => {
      const m = merged(fs).filter((f) => f.mergedAt);
      return { value: median(m.map((f) => hours(f.task.createdAt, f.mergedAt!))), n: m.length, of: m };
    },
    opens: "merged",
  },
  {
    id: "review_rounds",
    of: "merged changes",
    label: "Review rounds",
    means: "Average rounds of review comments a merged change needed.",
    unit: "num",
    lowerIsBetter: true,
    value: (fs) => {
      const m = merged(fs);
      return { value: m.length === 0 ? null : m.reduce((s, f) => s + f.task.people.reviewRounds, 0) / m.length, n: m.length, of: m };
    },
    opens: "merged",
  },
  {
    id: "no_human_commits",
    of: "merged changes",
    label: "Merged with no human commits",
    means: "Share of merged changes where no person pushed to the PR.",
    unit: "pct",
    lowerIsBetter: false,
    value: (fs) => {
      const m = merged(fs);
      const clean = m.filter((f) => f.humanPushes === 0);
      return { value: pct(clean.length, m.length), n: m.length, of: clean };
    },
    opens: "merged",
  },
  {
    id: "world_pass",
    of: "checked PRs",
    label: "OpenWorld check passed",
    means: "Share of checked PRs whose latest head held every invariant over the simulated days.",
    unit: "pct",
    lowerIsBetter: false,
    value: (fs) => {
      const checked = fs.filter((f) => (f.task.worldChecks ?? []).length > 0);
      const ok = checked.filter((f) => f.task.worldChecks!.at(-1)!.status === "passed");
      return { value: pct(ok.length, checked.length), n: checked.length, of: ok };
    },
  },
];

export const measureById = (id: string | undefined) => MEASURES.find((m) => m.id === id) ?? MEASURES[1]!;

// ───────────────────────────── grouping ─────────────────────────────

export interface Dimension {
  id: string;
  label: string;
  /** Filter key that selects one value of this dimension on the Tasks page (null: not filterable). */
  filter: (typeof FILTER_KEYS)[number] | null;
  values(f: TaskFacts, teams: readonly Team[]): string[];
  order?: (a: string, b: string) => number;
}

const isoWeek = (iso: string) => {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
};

export const DIMENSIONS: Dimension[] = [
  { id: "none", label: "None", filter: null, values: () => ["All"] },
  { id: "kind", label: "Kind of task", filter: "kind", values: (f) => [kindOf(f.task)] },
  { id: "team", label: "Team", filter: "team", values: (f, teams) => { const t = teamsOf(f.task, teams); return t.length ? t.map((x) => x.slug) : ["(no team)"]; } },
  { id: "person", label: "Person", filter: "person", values: (f) => [f.task.requestedBy ?? "(unknown)"] },
  { id: "repo", label: "Repo", filter: "repo", values: (f) => reposOf(f.task) },
  { id: "version", label: "Factory version", filter: "version", values: (f) => [f.task.factoryVersion] },
  { id: "model", label: "Agent and model", filter: "model", values: (f) => [f.task.harness.model] },
  { id: "risk", label: "Merge risk", filter: "risk", values: (f) => [f.task.risk?.level ?? "none"], order: (a, b) => ["low", "medium", "high", "none"].indexOf(a) - ["low", "medium", "high", "none"].indexOf(b) },
  { id: "week", label: "Week", filter: null, values: (f) => [isoWeek(f.task.createdAt)], order: (a, b) => a.localeCompare(b) },
  { id: "month", label: "Month", filter: null, values: (f) => [f.task.createdAt.slice(0, 7)], order: (a, b) => a.localeCompare(b) },
];
export const dimensionById = (id: string | undefined, fallback = "kind") => DIMENSIONS.find((d) => d.id === id) ?? DIMENSIONS.find((d) => d.id === fallback)!;

export interface Cell {
  value: number | null;
  /** Tasks the number is about (its denominator). */
  n: number;
}
export interface Row {
  key: string;
  label: string;
  cells: Map<string, Cell>;
  total: Cell;
}
export interface Explored {
  measure: Measure;
  by: Dimension;
  split: Dimension;
  splits: string[];
  rows: Row[];
  overall: Cell;
}

/** Measure × group by × split over the tasks in scope. Groups with no tasks are left out. */
export function explore(fs: readonly TaskFacts[], opts: { measure: string; by: string; split: string }, teams: readonly Team[], now: string): Explored {
  const measure = measureById(opts.measure);
  const by = dimensionById(opts.by);
  const split = dimensionById(opts.split, "none");
  const groups = new Map<string, Map<string, TaskFacts[]>>();
  const splitKeys = new Set<string>();
  for (const f of fs) {
    for (const g of by.values(f, teams)) {
      const row = groups.get(g) ?? new Map<string, TaskFacts[]>();
      for (const s of split.values(f, teams)) {
        splitKeys.add(s);
        row.set(s, [...(row.get(s) ?? []), f]);
      }
      groups.set(g, row);
    }
  }
  const cell = (xs: readonly TaskFacts[]): Cell => {
    const r = measure.value(xs, now);
    return { value: r.value, n: r.n };
  };
  const splits = [...splitKeys].sort(split.order ?? ((a, b) => a.localeCompare(b)));
  const rows: Row[] = [...groups.entries()].map(([key, m]) => {
    const all = [...new Set([...m.values()].flat())];
    return { key, label: key, cells: new Map([...m.entries()].map(([s, xs]) => [s, cell(xs)])), total: cell(all) };
  });
  rows.sort(by.order ? (a, b) => by.order!(a.key, b.key) : (a, b) => b.total.n - a.total.n || a.key.localeCompare(b.key));
  return { measure, by, split, splits, rows, overall: cell(fs) };
}

export function formatValue(v: number | null, unit: Unit): string {
  if (v === null) return "–";
  switch (unit) {
    case "pct":
      return `${Math.round(v * 100)}%`;
    case "usd":
      return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
    case "hours":
      return v < 1 ? `${Math.max(1, Math.round(v * 60))}m` : v < 48 ? `${v.toFixed(v < 10 ? 1 : 0)}h` : `${(v / 24).toFixed(1)}d`;
    case "num":
      return v.toFixed(1);
    default:
      return String(Math.round(v));
  }
}

// ───────────────────────────── people ─────────────────────────────

export interface PersonRow {
  login: string;
  teams: string[];
  asked: number;
  merged: number;
  open: number;
}

/** People in scope with what they asked for. Ordered by name: no view ranks people. */
export function people(fs: readonly TaskFacts[], teams: readonly Team[], scope: Scope): PersonRow[] {
  const logins = new Set<string>();
  for (const t of teams) if (scope.kind !== "team" || t.slug === scope.team) for (const m of t.members) logins.add(m.login);
  for (const f of fs) if (f.task.requestedBy) logins.add(f.task.requestedBy);
  return [...logins]
    .sort((a, b) => a.localeCompare(b))
    .map((login) => {
      const mine = fs.filter((f) => f.task.requestedBy === login);
      return {
        login,
        teams: teams.filter((t) => t.members.some((m) => m.login === login)).map((t) => t.slug),
        asked: mine.length,
        merged: mine.filter((f) => f.task.status === "merged").length,
        open: mine.filter((f) => isOpen(f.task.status)).length,
      };
    });
}
