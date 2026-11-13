/**
 * The app's pages around one model: a scope (org › team › person), filters, and tasks.
 * Inbox, Tasks, Insights, teams and people, factories and their versions, scorers, improve.
 */
import type { Child } from "hono/jsx";
import type { RolloutState, SavedView, Team, TaskRecord } from "@openfactory/contracts";
import type { BenchRun } from "@openfactory/bench";
import type { FactoryInfo, FactoryView } from "@openfactory/client";
import { scorerDocs } from "@openfactory/scoring";
import { failureLine, inbox, isOpen, type InboxItem, type TaskFacts } from "./insights.js";
import {
  cameBack,
  DIMENSIONS,
  filterQuery,
  formatValue,
  HELD_UP_DAYS,
  kindOf,
  KIND_NAMES,
  lifeOf,
  MEASURES,
  measureById,
  people,
  repoOf,
  scopeParam,
  scopePath,
  teamsOf,
  type Explored,
  type Filters,
  type Life,
  type PersonRow,
  type Scope,
} from "./model.js";
import { Badge, Empty, Icon, PageHeader } from "./ui.js";
import { ago, STATUS, StatusIcon, usd, when } from "./views.js";

// ───────────────────────────── scope bar ─────────────────────────────

const PERIODS: Array<[number, string]> = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [365, "Last year"], [0, "All time"]];
const FILTER_LABEL: Record<string, string> = { repo: "Repo", model: "Model", version: "Version", kind: "Kind", person: "Asked by", team: "Team", risk: "Merge risk", state: "State", q: "Search" };
const STATE_LABEL: Record<string, string> = { open: "open", review: "waiting for review", merged: "merged", came_back: "came back after merge", held: `held up ${HELD_UP_DAYS} days`, failed: "failed or stopped" };

export interface ScopeOptions {
  repos: string[];
  models: string[];
  versions: string[];
  people: string[];
}

/** Scope, filters and period: the same bar on every page, so every number can be narrowed or widened. */
export function ScopeBar({ f, teams, viewer, base, opts, extra }: { f: Filters; teams: readonly Team[]; viewer: string | null; base: string; opts: ScopeOptions; extra?: Child }) {
  const path = scopePath(f.scope, teams);
  const to = (over: Record<string, string>) => `${base}?${filterQuery(f, over)}`;
  const chips = (["repo", "model", "version", "kind", "person", "team", "risk", "state", "q"] as const).filter((k) => f[k]);
  const sel = (name: string, label: string, values: string[], cur: string, show: (v: string) => string = (v) => v) => (
    <label>{label}<select class="in" name={name}><option value="">Any</option>{values.map((v) => <option value={v} selected={v === cur}>{show(v)}</option>)}</select></label>
  );
  return (
    <div class="scope">
      <span class="lbl">Scope</span>
      <span class="path">
        {path.map((p, i) => (
          <>
            {i > 0 ? <span class="sep">›</span> : null}
            {i === path.length - 1 ? <b style="font-weight:600">{p.label}</b> : <a href={to({ scope: scopeParam(p.scope) })}>{p.label}</a>}
          </>
        ))}
      </span>
      <details class="pop">
        <summary aria-label="Change scope">▾</summary>
        <div class="menu">
          <a href={to({ scope: "org" })} class={f.scope.kind === "org" ? "on" : ""}>Org <span class="muted">everyone</span></a>
          {viewer ? <a href={to({ scope: `person:${viewer}` })} class={f.scope.kind === "person" && f.scope.login === viewer ? "on" : ""}>Just me <span class="muted">{viewer}</span></a> : null}
          {teams.length ? <div class="h">Teams</div> : null}
          {teams.map((t) => <a href={to({ scope: `team:${t.slug}` })} class={f.scope.kind === "team" && f.scope.team === t.slug ? "on" : ""}>{t.name} <span class="muted">{t.members.length} people</span></a>)}
          <div class="h">Pages</div>
          <a href="/teams">All teams and people</a>
          {f.scope.kind === "team" ? <a href={`/teams/${f.scope.team}`}>This team's page</a> : null}
          {f.scope.kind === "person" ? <a href={`/people/${f.scope.login}`}>This person's page</a> : null}
        </div>
      </details>
      <span class="vr" />
      {chips.map((k) => (
        <span class="chip">{FILTER_LABEL[k]}: {k === "state" ? (STATE_LABEL[f[k]] ?? f[k]) : f[k]} <a href={to({ [k]: "" })} aria-label={`Remove ${FILTER_LABEL[k]} filter`}>×</a></span>
      ))}
      <details class="pop">
        <summary>+ filter</summary>
        <div class="menu">
          <form method="get" action={base}>
            <input type="hidden" name="scope" value={scopeParam(f.scope)} />
            <input type="hidden" name="days" value={String(f.days)} />
            {sel("kind", "Kind of task", KIND_NAMES, f.kind)}
            {sel("state", "State", Object.keys(STATE_LABEL), f.state, (v) => STATE_LABEL[v] ?? v)}
            {sel("repo", "Repo", opts.repos, f.repo)}
            {sel("person", "Asked by", opts.people, f.person)}
            {sel("model", "Model", opts.models, f.model)}
            {sel("version", "Factory version", opts.versions, f.version)}
            {sel("risk", "Merge risk", ["low", "medium", "high", "none"], f.risk)}
            <label>Search<input class="in" name="q" value={f.q} placeholder="title, task id or #PR" /></label>
            <button class="btn primary" type="submit">Apply</button>
          </form>
        </div>
      </details>
      <span class="grow" />
      {extra ?? null}
      <details class="pop right">
        <summary>{PERIODS.find((p) => p[0] === f.days)?.[1] ?? "Last 30 days"} ▾</summary>
        <div class="menu">{PERIODS.map(([d, l]) => <a href={to({ days: String(d) })} class={f.days === d ? "on" : ""}>{l}</a>)}</div>
      </details>
    </div>
  );
}

export function scopeOptions(fs: readonly TaskFacts[]): ScopeOptions {
  const u = (xs: string[]) => [...new Set(xs)].sort();
  return {
    repos: u(fs.map((f) => repoOf(f.task))),
    models: u(fs.map((f) => f.task.harness.model)),
    versions: u(fs.map((f) => f.task.factoryVersion)),
    people: u(fs.map((f) => f.task.requestedBy ?? "").filter(Boolean)),
  };
}

// ───────────────────────────── task rows ─────────────────────────────

/** asked, agent work, PR, review, merged, after merge: done in ink, now in yellow, after merge green or red. */
export function LifeBar({ life }: { life: Life }) {
  const steps: Record<Life, string[]> = {
    asked: ["n", "", "", "", "", ""],
    working: ["d", "n", "", "", "", ""],
    review: ["d", "d", "d", "n", "", ""],
    merged: ["d", "d", "d", "d", "d", ""],
    after: ["d", "d", "d", "d", "d", "n"],
    held: ["d", "d", "d", "d", "d", "ok"],
    came_back: ["d", "d", "d", "d", "d", "x"],
    failed: ["d", "x", "", "", "", ""],
    stopped: ["d", "d", "", "", "", ""],
  };
  const label: Record<Life, string> = { asked: "asked", working: "agent working", review: "in review", merged: "merged", after: "merged, watching what comes back", held: `held up ${HELD_UP_DAYS} days`, came_back: "came back after merge", failed: "failed", stopped: "stopped" };
  return <span class="life" title={label[life]} role="img" aria-label={label[life]}>{steps[life].map((c) => <i class={c} />)}</span>;
}

/** One sentence on where the task is, in words a reviewer uses. */
export function lifeSentence(f: TaskFacts, now: string): string {
  const t = f.task;
  const back = cameBack(t);
  switch (lifeOf(f, now)) {
    case "came_back": {
      const b = back[0]!;
      return `Merged, then ${b.kind === "incident_linked" ? "linked to an incident" : b.kind === "reverted" ? "reverted" : b.kind === "hotfix" ? "fixed again" : "reworked"}: ${b.detail}`;
    }
    case "held":
      return `Merged ${f.mergedAt ? ago(f.mergedAt, now) : ""}. Nothing came back in ${HELD_UP_DAYS} days.`;
    case "after":
      return `Merged${t.people.reviewRounds ? ` after ${t.people.reviewRounds} review round${t.people.reviewRounds === 1 ? "" : "s"}` : " with no review round"}. Nothing came back so far.`;
    case "review":
      return f.ciOnHead === "failure" ? `CI is red on PR #${t.pr?.number}. Comment to send the agent back.` : `PR #${t.pr?.number ?? "?"} is waiting for review.${t.evidence.length ? ` Evidence: ${evidenceSummary(t)}.` : ""}`;
    case "working":
      return f.lastError ? `Blocked: ${f.lastError}` : `Agent working. Turn ${Math.max(1, f.turns.length)}, ${usd(t.usage.costUsd)} so far.`;
    case "asked":
      return "Queued.";
    case "failed":
      return failureLine(f);
    case "stopped":
      return f.cancelled ? failureLine(f) : "Closed without merging.";
    default:
      return STATUS[t.status].label;
  }
}

export function evidenceSummary(t: TaskRecord): string {
  const n = (k: string) => t.evidence.filter((e) => e.kind === k).length;
  const parts: string[] = [];
  if (n("test-user")) parts.push(`${n("test-user")} test user${n("test-user") === 1 ? "" : "s"}`);
  if (n("screenshot")) parts.push(`${n("screenshot")} screenshot${n("screenshot") === 1 ? "" : "s"}`);
  if (n("video")) parts.push(`${n("video")} video${n("video") === 1 ? "" : "s"}`);
  if (n("test-output")) parts.push("test output");
  return parts.join(", ") || `${t.evidence.length} items`;
}

export function TaskRow({ f, now, note, needs, action }: { f: TaskFacts; now: string; note?: string; needs?: boolean; action?: Child }) {
  const t = f.task;
  return (
    <div class={`trow${needs ? " needs" : ""}`}>
      <StatusIcon s={t.status} />
      <div class="ttl">
        <a href={`/tasks/${t.id}`}>{t.title}</a>
        <div class="s2"><span class="w">{note ?? lifeSentence(f, now)}</span></div>
        <div class="s2">{t.requestedBy ? `asked by ${t.requestedBy} · ` : ""}{repoOf(t)}{t.pr ? ` #${t.pr.number}` : ""} · {kindOf(t)} · {t.harness.model}</div>
      </div>
      <span class="r"><LifeBar life={lifeOf(f, now)} /></span>
      <span class="r num">{action ?? usd(t.usage.costUsd)}</span>
      <span class="r muted" title={t.updatedAt}>{ago(t.updatedAt, now)}</span>
    </div>
  );
}

const Rows = ({ children }: { children: Child }) => <div class="rows">{children}</div>;
const Sec = ({ title, n, children }: { title: string; n?: Child; children?: Child }) => (
  <div class="section-title" style="justify-content:space-between"><span>{title} {n !== undefined ? <span class="n">{n}</span> : null}</span>{children ?? null}</div>
);

// ───────────────────────────── inbox ─────────────────────────────

export function InboxPage({ facts, now, viewer, scope, teamReviews = [] }: { facts: TaskFacts[]; now: string; viewer: string | null; scope: Scope; teamReviews?: TaskFacts[] }) {
  const needs = inbox(facts, now);
  const needIds = new Set(needs.map((n) => n.facts.task.id));
  // Merged work that came back in the last 14 days is worth a look before the next similar task.
  const back = facts.filter((f) => !needIds.has(f.task.id) && cameBack(f.task).some((o) => Date.parse(now) - Date.parse(o.arrivedAt) < 14 * 86_400_000));
  const working = facts.filter((f) => isOpen(f.task.status) && !needIds.has(f.task.id));
  const finished = facts.filter((f) => !isOpen(f.task.status) && !needIds.has(f.task.id) && !back.includes(f) && Date.parse(now) - Date.parse(f.task.updatedAt) < 7 * 86_400_000);
  const verb: Record<InboxItem["kind"], string> = { pr_review: "Review", ci_failing: "Open", blocked: "Answer", failed: "See why" };
  const who = scope.kind === "person" ? (scope.login === viewer ? "you" : scope.login) : scope.kind === "team" ? "this team" : "the org";
  const needN = needs.length + back.length;
  const sub = `${needN === 0 ? "Nothing needs you" : `${needN} task${needN === 1 ? " needs" : "s need"} a person`}. ${working.length === 0 ? `No agents are working for ${who} right now.` : `${working.length} agent${working.length === 1 ? " is" : "s are"} working for ${who} and ${working.length === 1 ? "doesn't" : "don't"} need you.`}${teamReviews.length ? ` ${teamReviews.length} of your team's PR${teamReviews.length === 1 ? " waits" : "s wait"} for a reviewer.` : ""}`;
  return (
    <>
      <PageHeader title="Inbox" sub={sub}>
        <a class="btn primary" href="/tasks/new"><Icon name="plus" />New task</a>
      </PageHeader>
      <Sec title="Needs you" n={needs.length + back.length} />
      {needs.length + back.length === 0 ? <Rows><Empty title="All clear.">Reviews, questions from agents and failures land here.</Empty></Rows> : (
        <Rows>
          {needs.map((n) => <TaskRow f={n.facts} now={now} needs note={n.kind === "blocked" ? `Blocked. ${n.detail}` : n.kind === "pr_review" ? `Review the PR. ${n.facts.task.evidence.length ? `Evidence: ${evidenceSummary(n.facts.task)}.` : "No evidence attached."}${n.facts.task.risk ? ` Merge risk ${n.facts.task.risk.level}.` : ""}` : n.detail} action={
                n.kind === "failed" && n.facts.lastErrorKind !== "setup" ? (
                  <form method="post" action={`/tasks/${n.facts.task.id}/retry`} style="margin:0"><input type="hidden" name="back" value="inbox" /><button class="btn" style="height:28px" type="submit">Retry</button></form>
                ) : <a class="btn" style="height:28px" href={`/tasks/${n.facts.task.id}`}>{verb[n.kind]}</a>
              } />)}
          {back.map((f) => <TaskRow f={f} now={now} needs action={<a class="btn" style="height:28px" href={`/tasks/${f.task.id}`}>See why</a>} />)}
        </Rows>
      )}
      {teamReviews.length > 0 ? (
        <>
          <Sec title="Your team's PRs waiting for review" n={teamReviews.length} />
          <Rows>{teamReviews.map((f) => <TaskRow f={f} now={now} action={<a class="btn" style="height:28px" href={`/tasks/${f.task.id}`}>Review</a>} />)}</Rows>
        </>
      ) : null}
      <Sec title="Agents working" n={working.length} />
      {working.length === 0 ? <Rows><Empty title="No agents running." /></Rows> : <Rows>{working.map((f) => <TaskRow f={f} now={now} />)}</Rows>}
      <Sec title="Recently finished" n="last 7 days" />
      {finished.length === 0 ? <Rows><Empty title="Nothing finished this week." /></Rows> : <Rows>{finished.slice(0, 20).map((f) => <TaskRow f={f} now={now} />)}</Rows>}
      <p class="note">The six bars on each row are the task's life: asked, agent work, PR, review, merged, after merge. Yellow is where it is now; after the merge it turns green when it held up {HELD_UP_DAYS} days and red when something came back.</p>
    </>
  );
}

// ───────────────────────────── new task ─────────────────────────────

export function NewTaskPage({ repos, label }: { repos: string[]; label: string }) {
  return (
    <>
      <PageHeader crumb={<><a href="/">Inbox</a> / New task</>} title="New task" sub="Say what you want, the way you'd write it to a colleague. Name a repo if you know it; otherwise the agent finds where the change belongs." />
      <div class="card" style="max-width:760px">
        <form method="post" action="/tasks/new" style="display:grid;gap:12px">
          <textarea class="in" name="ask" required rows={6} style="height:auto;padding:12px;font-size:15px;line-height:1.5" placeholder="Show each plan's usage limits on the billing page, with a bar that turns amber near the limit. Done when a free user at 85% sees the amber bar." />
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <select class="in" name="repo" aria-label="Repo (optional)"><option value="">Repo: let the agent decide</option>{repos.map((r) => <option value={r}>{r}</option>)}</select>
            <span class="grow" style="flex:1" />
            <button class="btn primary" type="submit">Start task</button>
          </div>
        </form>
        <p class="note">The task becomes an issue labelled <span class="mono">{label}</span> in the repo (or the first repo when the agent decides), so the conversation lives where your team already works. You answer the agent here or on the issue.</p>
      </div>
    </>
  );
}

// ───────────────────────────── tasks ─────────────────────────────

export function TasksPage({ facts, f, now, saveForm, total }: { facts: TaskFacts[]; f: Filters; now: string; saveForm: Child; total: number }) {
  const cost = facts.reduce((s, x) => s + x.task.usage.costUsd, 0);
  return (
    <>
      <PageHeader title="Tasks" sub={`${facts.length} of ${total} tasks in scope, ${usd(cost)} spent. Add or remove a filter to widen it.`}>
        <a class="btn" href={`/insights?${filterQuery(f)}`}><Icon name="chart" />Open in Insights</a>
        {saveForm}
      </PageHeader>
      {facts.length === 0 ? <Rows><Empty title="No tasks match.">Try a longer period or remove a filter.</Empty></Rows> : <Rows>{facts.slice(0, 300).map((x) => <TaskRow f={x} now={now} needs={x.task.status === "awaiting_review"} />)}</Rows>}
      {facts.length > 300 ? <p class="note">Showing the newest 300. Narrow the scope to see the rest.</p> : null}
    </>
  );
}

/** "Save view" as a small form in a popover: name and who sees it. */
export function SaveViewForm({ path, viewer, teams, current }: { path: string; viewer: string | null; teams: readonly Team[]; current?: SavedView | null }) {
  if (!viewer) return <a class="btn" href="/signin">Sign in to save views</a>;
  const mine = teams.filter((t) => t.members.some((m) => m.login === viewer));
  return (
    <details class="pop right">
      <summary class="btn" style="height:32px">{current ? "Update view" : "Save view"}</summary>
      <div class="menu" style="min-width:280px">
        <form method="post" action="/views">
          {current ? <input type="hidden" name="id" value={current.id} /> : null}
          <input type="hidden" name="path" value={path} />
          <label>Name<input class="in" name="name" required maxlength={120} value={current?.name ?? ""} placeholder="Where we wait on review" /></label>
          <label>Who sees it
            <select class="in" name="share">
              <option value="me">Just me</option>
              {mine.map((t) => <option value={`team:${t.slug}`}>{t.name}</option>)}
              <option value="org">Everyone in the org</option>
              <option value="link">Anyone with the link</option>
            </select>
          </label>
          <button class="btn primary" type="submit">Save</button>
        </form>
      </div>
    </details>
  );
}

// ───────────────────────────── insights ─────────────────────────────

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--ink-2)"];

export function InsightsPage({ ex, f, views, viewer, teams, saveForm, now }: { ex: Explored; f: Filters; views: SavedView[]; viewer: string | null; teams: readonly Team[]; saveForm: Child; now: string }) {
  const m = ex.measure;
  const q = (over: Record<string, string>) => `/insights?${filterQuery(f, { measure: m.id, by: ex.by.id, split: ex.split.id, ...over })}`;
  const splitColor = new Map(ex.splits.map((s, i) => [s, SERIES[i % SERIES.length]!]));
  const vals = ex.rows.flatMap((r) => [...r.cells.values()].map((c) => c.value ?? 0));
  const max = Math.max(m.unit === "pct" ? 0.0001 : 0, ...vals);
  // Every number opens the tasks behind it: the group and split become filters, the measure picks a state.
  const tasksFor = (group: string | null, split: string | null) => {
    const over: Record<string, string> = {};
    if (group !== null && ex.by.filter) over[ex.by.filter] = group;
    if (split !== null && ex.split.filter) over[ex.split.filter] = split;
    if (m.opens) over.state = m.opens;
    return `/tasks?${filterQuery(f, over)}`;
  };
  const tooFew = ex.splits.length > 4;
  const scopeName = scopePath(f.scope, teams).at(-1)!.label;
  return (
    <>
      <PageHeader title="Insights" sub="Pick what to measure and how to slice it. The scope bar above narrows it to a team, a person, a repo or a factory version; every number opens its tasks.">
        {saveForm}
      </PageHeader>
      <div class="xp">
        <div class="ctl">
          <div class="card" style="padding:14px 12px">
            <h4>Saved views</h4>
            <div class="views">
              {views.length === 0 ? <div class="muted" style="font-size:13px;padding:4px 10px">None yet. Set a view up and save it.</div> : views.map((v) => (
                <a href={`/views/${v.id}`}>{v.name}<div class="who">{v.owner === viewer ? "yours" : v.owner}, {v.share === "me" ? "only you" : v.share === "team" ? `shared with ${v.team}` : v.share === "org" ? "shared with the org" : "by link"}</div></a>
              ))}
            </div>
          </div>
          <div>
            <h4>Measure</h4>
            <div class="opts">{MEASURES.map((x) => <a href={q({ measure: x.id })} class={x.id === m.id ? "on" : ""}>{x.label}</a>)}</div>
          </div>
          <div>
            <h4>Group by</h4>
            <div class="opts">{DIMENSIONS.map((x) => <a href={q({ by: x.id })} class={x.id === ex.by.id ? "on" : ""}>{x.label}</a>)}</div>
          </div>
          <div>
            <h4>Split</h4>
            <div class="opts">{DIMENSIONS.filter((x) => ["none", "model", "version", "kind", "risk", "team"].includes(x.id)).map((x) => <a href={q({ split: x.id })} class={x.id === ex.split.id ? "on" : ""}>{x.label}</a>)}</div>
          </div>
        </div>
        <div class="stack" style="min-width:0">
          <div class="card">
            <div class="head">
              <div>
                <h3>{m.label}{ex.by.id !== "none" ? `, by ${ex.by.label.toLowerCase()}` : ""}{ex.split.id !== "none" ? `, split by ${ex.split.label.toLowerCase()}` : ""}</h3>
                <div class="muted" style="font-size:13px;margin-top:2px">{scopeName}, {f.days ? `last ${f.days} days` : "all time"}. {m.means}</div>
              </div>
              <div style="text-align:right"><div style="font-size:28px;font-weight:600;font-stretch:118%;line-height:34px"><a href={tasksFor(null, null)}>{formatValue(ex.overall.value, m.unit)}</a></div><div class="muted" style="font-size:12.5px">over {ex.overall.n} {m.of}</div></div>
            </div>
            {ex.split.id !== "none" ? <div class="legend" style="margin-top:14px">{ex.splits.slice(0, 4).map((s) => <span><i class="sq" style={`background:${splitColor.get(s)}`} />{s}</span>)}{tooFew ? <span class="muted">and {ex.splits.length - 4} more in the table</span> : null}</div> : null}
            {ex.rows.length === 0 ? <Empty title="No tasks in this scope and period." /> : (
              <div class="bars" style="margin-top:18px">
                {ex.rows.slice(0, 24).map((r) => (
                  <>
                    <span class="lab" title={r.label}><a href={tasksFor(r.key, null)}>{r.label}</a></span>
                    <span class="track">
                      {(ex.split.id === "none" ? [["All", r.total] as const] : ex.splits.slice(0, 4).map((s) => [s, r.cells.get(s)] as const)).map(([s, c]) =>
                        c && c.value !== null ? <a href={tasksFor(r.key, ex.split.id === "none" ? null : s)} title={`${r.label}${ex.split.id === "none" ? "" : `, ${s}`}: ${formatValue(c.value, m.unit)} of ${c.n}`}><span class="bar" style={`width:${max > 0 ? Math.max(0.5, (c.value / max) * 100) : 0}%;background:${ex.split.id === "none" ? "var(--series-1)" : splitColor.get(s)}`} /></a> : <span class="bar" style="width:0" />,
                      )}
                    </span>
                    <span class="val"><a href={tasksFor(r.key, null)}>{formatValue(r.total.value, m.unit)}</a><span class="c">of {r.total.n}</span></span>
                  </>
                ))}
              </div>
            )}
            {m.id === "held_up" ? <p class="note">Only changes merged at least {HELD_UP_DAYS} days ago count, so recent weeks fill in over time.</p> : null}
          </div>
          {ex.rows.length > 0 ? (
            <div class="card flush">
              <div class="scroll"><table class="tbl">
                <thead><tr><th>{ex.by.label}</th>{ex.split.id === "none" ? null : ex.splits.map((s) => <th class="r">{s}</th>)}<th class="r">All</th><th class="r">Tasks</th></tr></thead>
                <tbody>
                  {ex.rows.map((r) => (
                    <tr>
                      <td><a class="title" href={tasksFor(r.key, null)}>{r.label}</a></td>
                      {ex.split.id === "none" ? null : ex.splits.map((s) => { const c = r.cells.get(s); return <td class="r num">{c ? <a class="link" href={tasksFor(r.key, s)}>{formatValue(c.value, m.unit)}</a> : <span class="muted">–</span>}{c ? <span class="muted" style="font-size:12px"> /{c.n}</span> : null}</td>; })}
                      <td class="r num"><b>{formatValue(r.total.value, m.unit)}</b></td>
                      <td class="r num muted">{r.total.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </div>
          ) : null}
          <p class="note" style="margin-top:0">Every measure works at any scope: org, a team, a person, a repo or a factory version. A person's scope shows their own tasks; grouping by person lists people by name and nothing here ranks them.{` Computed ${when(now)}.`}</p>
        </div>
      </div>
    </>
  );
}

// ───────────────────────────── teams and people ─────────────────────────────

/** A readout cell whose number opens its tasks. */
const Num = ({ k, v, c, href }: { k: string; v: string; c?: Child; href: string }) => (
  <div><div class="k">{k}</div><div class="v"><a href={href}>{v}</a></div>{c ? <div class="c">{c}</div> : null}</div>
);

function headline(fs: readonly TaskFacts[], now: string) {
  const val = (id: string) => measureById(id).value(fs, now);
  return { merged: val("merged"), back: val("came_back"), cpm: val("cost_per_merged"), wait: val("review_wait"), spend: val("cost") };
}

export function TeamsPage({ teams, facts, now, f }: { teams: Team[]; facts: TaskFacts[]; now: string; f: Filters }) {
  const all = headline(facts, now);
  return (
    <>
      <PageHeader title="Teams" sub={`Teams come from the org's directory (${teams[0]?.source.startsWith("github") ? "GitHub teams" : teams[0]?.source === "config" ? "factory.yaml" : "inferred from who asked"}). Each one sees its own tasks, people and factory; numbers open their tasks.`} />
      <div class="readout" style="--cols:4">
        <Num k="Merged by the factory" v={formatValue(all.merged.value, "count")} c={`${facts.length} tasks asked`} href={`/tasks?${filterQuery({ ...f, scope: { kind: "org" } }, { state: "merged" })}`} />
        <Num k="Came back after merge" v={formatValue(all.back.value, "pct")} c={`of ${all.back.n} merged`} href={`/tasks?${filterQuery({ ...f, scope: { kind: "org" } }, { state: "came_back" })}`} />
        <Num k="Cost per merged change" v={formatValue(all.cpm.value, "usd")} c={`${usd(all.spend.value)} spent`} href={`/insights?${filterQuery({ ...f, scope: { kind: "org" } }, { measure: "cost_per_merged", by: "team" })}`} />
        <Num k="Waiting on review" v={formatValue(all.wait.value, "hours")} c="median, PR open to first review" href={`/insights?${filterQuery({ ...f, scope: { kind: "org" } }, { measure: "review_wait", by: "team" })}`} />
      </div>
      <div class="card flush">
        <div class="scroll"><table class="tbl">
          <thead><tr><th>Team</th><th>Factory</th><th class="r">People</th><th class="r">Tasks</th><th class="r">Merged</th><th class="r">Came back</th><th class="r">Cost / merged</th><th class="r">Review wait</th></tr></thead>
          <tbody>
            {teams.map((t) => {
              const mine = facts.filter((x) => teamsOf(x.task, teams).some((y) => y.slug === t.slug));
              const h = headline(mine, now);
              return (
                <tr>
                  <td><a class="title" href={`/teams/${t.slug}?${filterQuery({ ...f, scope: { kind: "team", team: t.slug } })}`}>{t.name}</a><div class="muted" style="font-size:12.5px">{t.repos.slice(0, 3).join(", ")}{t.repos.length > 3 ? ` +${t.repos.length - 3}` : ""}</div></td>
                  <td><a class="link" href={`/factories/${t.factory}`}>{t.factory}</a></td>
                  <td class="r num">{t.members.length}</td>
                  <td class="r num">{mine.length}</td>
                  <td class="r num">{h.merged.value}</td>
                  <td class="r num">{formatValue(h.back.value, "pct")}</td>
                  <td class="r num">{formatValue(h.cpm.value, "usd")}</td>
                  <td class="r num">{formatValue(h.wait.value, "hours")}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
      <p class="note">Teams are listed by name. People are on each team's page, by name too: nothing here ranks people.</p>
    </>
  );
}

export function TeamPage({ team, facts, now, f, factory, views, viewer }: { team: Team; facts: TaskFacts[]; now: string; f: Filters; factory: FactoryView | null; views: SavedView[]; viewer: string | null }) {
  const h = headline(facts, now);
  const ppl = people(facts, [team], { kind: "team", team: team.slug });
  const t = (over: Record<string, string>) => `/tasks?${filterQuery(f, over)}`;
  const i = (over: Record<string, string>) => `/insights?${filterQuery(f, over)}`;
  return (
    <>
      <PageHeader crumb={<><a href="/teams">Teams</a> / {team.name}</>} title={team.name} sub={<>{team.source.startsWith("github:") ? <>GitHub team <span class="mono">@{team.source.slice(7)}</span></> : team.source === "config" ? "From factory.yaml" : "Everyone who has asked for a task"}, {team.members.length} people, {team.repos.length} repo{team.repos.length === 1 ? "" : "s"}. Runs on the <a class="link" href={`/factories/${team.factory}`}>{team.factory}</a> factory.</>}>
        <a class="btn" href={t({})}>Tasks</a>
        <a class="btn" href={i({ measure: "came_back", by: "kind" })}>Open in Insights</a>
        <a class="btn" href={`/improve?${filterQuery(f)}`}>Improve our factory</a>
      </PageHeader>
      <div class="readout" style="--cols:4">
        <Num k="Merged by the factory" v={formatValue(h.merged.value, "count")} c={`${facts.length} asked`} href={t({ state: "merged" })} />
        <Num k="Cost per merged change" v={formatValue(h.cpm.value, "usd")} c={`${usd(h.spend.value)} spent`} href={i({ measure: "cost_per_merged", by: "kind" })} />
        <Num k="Came back after merge" v={formatValue(h.back.value, "pct")} c={`of ${h.back.n} merged`} href={t({ state: "came_back" })} />
        <Num k="Waiting on review" v={formatValue(h.wait.value, "hours")} c="median" href={i({ measure: "review_wait", by: "repo" })} />
      </div>
      <div class="grid g2" style="align-items:start">
        <div class="card flush">
          <div style="padding:16px 20px 6px"><h3>People</h3><div class="muted" style="font-size:13px;margin-top:2px">From the team, by name. A person's page shows their own tasks.</div></div>
          <table class="tbl">
            <tbody>{ppl.map((p) => <tr><td><a class="title" href={`/people/${p.login}`}>{p.login}</a>{team.members.find((m) => m.login === p.login)?.role === "maintainer" ? <span class="muted"> · maintainer</span> : null}</td><td class="r muted">asked {p.asked}, {p.merged} merged{p.open ? `, ${p.open} open` : ""}</td></tr>)}</tbody>
          </table>
        </div>
        <div class="card flush">
          <div style="padding:16px 20px 6px"><h3>What the team owns</h3></div>
          <table class="tbl">
            <tbody>
              <tr><td class="muted">Factory</td><td><a class="link" href={`/factories/${team.factory}`}>{team.factory}</a>{factory?.extends ? <span class="muted"> built on {factory.extends}</span> : null}</td></tr>
              <tr><td class="muted">Repos</td><td class="wrapcell">{team.repos.length ? team.repos.map((r) => <a class="chip" href={t({ repo: r })} style="margin:2px">{r}</a>) : <span class="muted">none listed</span>}</td></tr>
              <tr><td class="muted">Scorers</td><td>org's, {factory?.scorers.length ? `plus ${factory.scorers.join(", ")}` : "no team scorers"} · <a class="link" href={`/scorers?${filterQuery(f)}`}>see</a></td></tr>
              <tr><td class="muted">Benchmarks</td><td>{factory?.benchmarks.length ? factory.benchmarks.join(", ") : "the org suite"} · <a class="link" href="/bench">see</a></td></tr>
              <tr><td class="muted">OpenWorld</td><td>{factory?.world ? <><span class="mono">{factory.world}</span>, every PR runs 30 simulated days</> : <span class="muted">no world yet</span>}</td></tr>
              <tr><td class="muted">Merge risk</td><td>{factory?.mergeRisk ? "team rules" : "org default rules"}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <Sec title="Saved views for this team" n={views.length} />
      <div class="card flush">
        {views.length === 0 ? <Empty title="No team views yet.">Set up a view in Insights or Tasks and save it for {team.name}.</Empty> : (
          <table class="tbl"><tbody>{views.map((v) => <tr><td><a class="title" href={`/views/${v.id}`}>{v.name}</a></td><td class="muted">{v.owner === viewer ? "yours" : v.owner}</td><td class="r muted">updated {when(v.updatedAt)}</td></tr>)}</tbody></table>
        )}
      </div>
    </>
  );
}

export function PersonPage({ login, teams, facts, now, f, viewer }: { login: string; teams: Team[]; facts: TaskFacts[]; now: string; f: Filters; viewer: string | null }) {
  const h = headline(facts, now);
  const mine = teams.filter((t) => t.members.some((m) => m.login === login));
  const t = (over: Record<string, string>) => `/tasks?${filterQuery(f, over)}`;
  return (
    <>
      <PageHeader crumb={<><a href="/teams">Teams</a>{mine[0] ? <> / <a href={`/teams/${mine[0].slug}`}>{mine[0].name}</a></> : null} / {login}</>} title={login === viewer ? `${login} (you)` : login} sub={`${mine.length ? `In ${mine.map((x) => x.name).join(", ")}. ` : ""}Tasks this person asked for. They and their team see this page; it is never compared with anyone else's.`}>
        <a class="btn" href={`/insights?${filterQuery(f, { measure: "merged", by: "week" })}`}>Open in Insights</a>
      </PageHeader>
      <div class="readout" style="--cols:4">
        <Num k="Asked" v={String(facts.length)} c={`${facts.filter((x) => isOpen(x.task.status)).length} open`} href={t({})} />
        <Num k="Merged" v={formatValue(h.merged.value, "count")} href={t({ state: "merged" })} />
        <Num k="Came back after merge" v={formatValue(h.back.value, "pct")} c={`of ${h.back.n} merged`} href={t({ state: "came_back" })} />
        <Num k="Spend" v={formatValue(h.spend.value, "usd")} c={`${formatValue(h.cpm.value, "usd")} per merged`} href={t({})} />
      </div>
      <Sec title="Their tasks" n={facts.length} />
      {facts.length === 0 ? <Rows><Empty title="No tasks in this period." /></Rows> : <Rows>{facts.slice(0, 100).map((x) => <TaskRow f={x} now={now} />)}</Rows>}
    </>
  );
}

/** Sign-in when the org's identity provider is configured. */
export function ProviderSigninPage({ provider, back }: { provider: "github" | "oidc"; back: string }) {
  return (
    <>
      <PageHeader title="Sign in" sub="The factory works as you: tasks you ask for, messages you send and changes you make carry your name." />
      <div class="card" style="max-width:420px">
        <a class="btn primary" style="width:100%;justify-content:center;height:40px" href={`/auth/start?back=${encodeURIComponent(back)}`}>
          {provider === "github" ? "Sign in with GitHub" : "Sign in with your company account"}
        </a>
      </div>
    </>
  );
}

export function SigninPage({ people: ppl, viewer, back }: { people: PersonRow[]; viewer: string | null; back: string }) {
  return (
    <>
      <PageHeader title="Who are you?" sub="The app shows your inbox and tasks, and saves your views under your name. Pick yourself, or type your code-host login." />
      <div class="card" style="max-width:560px">
        <div class="who-list">
          {ppl.map((p) => (
            <form method="post" action="/signin" style="margin:0">
              <input type="hidden" name="login" value={p.login} /><input type="hidden" name="back" value={back} />
              <button type="submit" class="btn" style="width:100%;justify-content:space-between;height:40px;margin-bottom:6px;font-weight:550">{p.login}{p.login === viewer ? " (now)" : ""}<span class="muted" style="font-weight:400">{p.teams.join(", ") || "no team"}</span></button>
            </form>
          ))}
        </div>
        <form method="post" action="/signin" style="display:flex;gap:8px;margin-top:12px">
          <input type="hidden" name="back" value={back} />
          <input class="in" name="login" placeholder="your-login" required pattern="[A-Za-z0-9-]{1,39}" style="flex:1" />
          <button class="btn primary" type="submit">Continue</button>
        </form>
        <p class="note">This picks who you are inside the app; it isn't a password. Single sign-on with the org's identity provider replaces it when configured.</p>
      </div>
    </>
  );
}

// ───────────────────────────── factories ─────────────────────────────

export interface VersionRow {
  version: string;
  firstSeen: string;
  lastSeen: string;
  tasks: number;
  merged: number;
  cameBack: number | null;
  cameBackN: number;
  costPerMerged: number | null;
  bench: { passRate: number; attempts: number; run: string } | null;
}

export function versionRows(fs: readonly TaskFacts[], runs: readonly BenchRun[], now: string): VersionRow[] {
  const by = new Map<string, TaskFacts[]>();
  for (const f of fs) by.set(f.task.factoryVersion, [...(by.get(f.task.factoryVersion) ?? []), f]);
  const bench = new Map<string, VersionRow["bench"]>();
  for (const r of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!r.report) continue;
    for (const s of [r.report.a, r.report.b]) if (s.factoryVersion) bench.set(s.factoryVersion, { passRate: s.passRate, attempts: s.attempts, run: r.id });
  }
  for (const v of bench.keys()) if (!by.has(v)) by.set(v, []);
  return [...by.entries()]
    .map(([version, xs]) => {
      const back = measureById("came_back").value(xs, now);
      const dates = xs.map((x) => x.task.createdAt).sort();
      return {
        version,
        firstSeen: dates[0] ?? "",
        lastSeen: dates.at(-1) ?? "",
        tasks: xs.length,
        merged: xs.filter((x) => x.task.status === "merged").length,
        cameBack: back.value,
        cameBackN: back.n,
        costPerMerged: measureById("cost_per_merged").value(xs, now).value,
        bench: bench.get(version) ?? null,
      };
    })
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function FactoriesPage({ factories, rollouts, info, rows }: { factories: FactoryView[]; rollouts: RolloutState[]; info: FactoryInfo | null; rows: Map<string, VersionRow[]> }) {
  return (
    <>
      <PageHeader title="Factories" sub="The org default and every team factory built on it. A team factory lists only what it changes; org scorers and rules always apply." />
      <div class="card flush">
        <div class="scroll"><table class="tbl">
          <thead><tr><th>Factory</th><th>Built on</th><th>What it changes</th><th>Teams</th><th>Live version</th><th>Candidate</th></tr></thead>
          <tbody>
            {factories.map((fa) => {
              const r = rollouts.find((x) => x.factory === fa.slug);
              const live = r?.live ?? (fa.slug === "default" ? (info?.version ?? "–") : (rows.get(fa.slug)?.[0]?.version ?? info?.version ?? "–"));
              const changes = [fa.scorers.length ? `${fa.scorers.length} scorer${fa.scorers.length === 1 ? "" : "s"}` : "", fa.benchmarks.length ? `benchmarks ${fa.benchmarks.join(", ")}` : "", fa.world ? `world ${fa.world}` : "", fa.mergeRisk ? "merge-risk rules" : ""].filter(Boolean);
              return (
                <tr>
                  <td><a class="title" href={`/factories/${fa.slug}`}>{fa.slug}</a>{fa.description ? <div class="muted" style="font-size:12.5px;white-space:normal;max-width:36ch">{fa.description}</div> : null}</td>
                  <td>{fa.extends ?? <span class="muted">n/a</span>}</td>
                  <td class="wrapcell">{fa.extends === null ? "everything" : changes.join(", ") || <span class="muted">nothing yet</span>}</td>
                  <td>{fa.teams.length ? fa.teams.map((t) => <a class="chip" href={`/teams/${t}`} style="margin:2px">{t}</a>) : <span class="muted">none</span>}</td>
                  <td class="mono">{live.slice(0, 18)}</td>
                  <td>{r?.candidate ? <><span class="mono">{r.candidate.slice(0, 18)}</span> <span class="muted">at {Math.round(r.share * 100)}%</span></> : <span class="muted">none</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>How a team factory works</h3>
        <pre class="block" style="margin-top:12px">{`# factory.yaml
teams:
  - { slug: payments, members: [dana, li, omar], repos: [acme/payments-api], factory: payments }
factories:
  payments:
    extends: default            # picks up default changes automatically
    scorers: [ledger-balances]  # adds to the org's scorers, never removes one
    benchmarks: [payments-core]
    world: payments-30d         # OpenWorld runs 30 simulated days on every PR
    mergeRisk: { riskyPaths: ["src/money/"], mediumLines: 150, highLines: 600 }`}</pre>
        <p class="note">A default update reaches every team factory as a candidate and goes through that team's own benchmark before it goes live there.</p>
      </div>
    </>
  );
}

export function FactoryPage({ fa, info, rollout, history, rows, viewer, runs, tabs }: { fa: FactoryView; info: FactoryInfo | null; rollout: RolloutState | null; history: RolloutState[]; rows: VersionRow[]; viewer: string | null; runs: BenchRun[]; tabs: Child }) {
  const live = rollout?.live ?? info?.version ?? rows[0]?.version ?? "–";
  const candidate = rollout?.candidate ?? null;
  const share = rollout?.share ?? 0;
  const previous = history.find((h) => h.live && h.live !== live)?.live ?? rows.find((r) => r.version !== live && r.tasks > 0)?.version ?? null;
  const cand = rows.find((r) => r.version === candidate);
  const liveRow = rows.find((r) => r.version === live);
  const known = [...new Set([...rows.map((r) => r.version), ...Object.keys(info?.prompts ? {} : {})])].filter((v) => v !== live);
  const lastRun = runs.find((r) => r.report && [r.arms[0].factoryVersion, r.arms[1].factoryVersion].includes(candidate ?? "") && [r.arms[0].factoryVersion, r.arms[1].factoryVersion].includes(live));
  const set = (label: string, body: { live: string | null; candidate: string | null; share: number; note: string }, kind: "primary" | "" | "danger" = "") => (
    <form method="post" action={`/factories/${fa.slug}/rollout`} style="display:inline">
      <input type="hidden" name="live" value={body.live ?? ""} /><input type="hidden" name="candidate" value={body.candidate ?? ""} /><input type="hidden" name="share" value={String(body.share)} /><input type="hidden" name="note" value={body.note} />
      <button class={`btn ${kind}`} type="submit" disabled={!viewer}>{label}</button>
    </form>
  );
  return (
    <>
      <PageHeader crumb={<><a href="/factories">Factories</a> / {fa.slug}</>} title={fa.slug === "default" ? "Org default factory" : `${fa.slug} factory`} sub={fa.extends ? `Built on ${fa.extends}. ${fa.description ?? ""}` : (fa.description ?? "")}>
        <a class="btn" href={`/insights?scope=org&days=90&measure=came_back&by=version`}>Versions in Insights</a>
        <a class="btn" href="/bench">Compare on a benchmark</a>
      </PageHeader>
      {tabs}
      <div class="readout" style="--cols:3">
        <div><div class="k">Live version</div><div class="v mono" style="font-size:22px">{live.slice(0, 20)}</div><div class="c">{liveRow ? `${liveRow.tasks} tasks, ${liveRow.merged} merged` : "no tasks yet"}{rollout ? `, set by ${rollout.updatedBy} ${when(rollout.updatedAt)}` : ", the version the server runs"}</div></div>
        <div><div class="k">Candidate</div><div class="v mono" style="font-size:22px">{candidate ? candidate.slice(0, 20) : "none"}</div><div class="c">{candidate ? `${Math.round(share * 100)}% of new tasks, ${cand?.tasks ?? 0} so far` : "New tasks all run on the live version."}</div></div>
        <div><div class="k">Agent</div><div class="v" style="font-size:22px">{info?.agent.name ?? "–"}</div><div class="c">{info ? `${info.agent.model}, foreman ${info.foreman.model}` : ""}</div></div>
      </div>

      <Sec title="Rollout" />
      <div class="card">
        <p class="t2" style="margin:0 0 14px;max-width:80ch">Versions work like production deploys: new tasks run on the live version unless you send a share of them to a candidate. Tasks already running keep their version. {viewer ? "" : "Sign in to change the rollout."}</p>
        {candidate ? (
          <>
            <div class="scroll"><table class="tbl" style="margin-bottom:14px">
              <thead><tr><th>Evidence</th><th>Live <span class="mono">{live.slice(0, 12)}</span></th><th>Candidate <span class="mono">{candidate.slice(0, 12)}</span></th><th>Reads as</th></tr></thead>
              <tbody>
                <tr><td>Benchmark</td><td>{liveRow?.bench ? `${Math.round(liveRow.bench.passRate * 100)}% of ${liveRow.bench.attempts}` : "not run"}</td><td>{cand?.bench ? `${Math.round(cand.bench.passRate * 100)}% of ${cand.bench.attempts}` : "not run"}</td><td>{lastRun?.report ? lastRun.report.summary : <a class="link" href="/bench">run a comparison</a>}</td></tr>
                <tr><td>Real tasks merged</td><td>{liveRow ? `${liveRow.merged} of ${liveRow.tasks}` : "–"}</td><td>{cand ? `${cand.merged} of ${cand.tasks}` : "0"}</td><td>{(cand?.tasks ?? 0) < 20 ? "too early, needs about 20 tasks" : "enough to read"}</td></tr>
                <tr><td>Came back after merge</td><td>{liveRow ? formatValue(liveRow.cameBack, "pct") : "–"}</td><td>{cand ? formatValue(cand.cameBack, "pct") : "–"}</td><td>needs weeks</td></tr>
                <tr><td>Cost per merged change</td><td>{formatValue(liveRow?.costPerMerged ?? null, "usd")}</td><td>{formatValue(cand?.costPerMerged ?? null, "usd")}</td><td /></tr>
              </tbody>
            </table></div>
            <div class="actions">
              <span class="muted" style="font-size:13px">Share of new tasks:</span>
              {[0.1, 0.25, 0.5].map((s) => set(`${Math.round(s * 100)}%`, { live, candidate, share: s, note: `share ${Math.round(s * 100)}%` }, s === share ? "primary" : ""))}
              {set("Stop the trial", { live, candidate: null, share: 0, note: "trial stopped" })}
              <span style="flex:1" />
              {set(`Promote ${candidate.slice(0, 12)}`, { live: candidate, candidate: null, share: 0, note: "promoted" }, "primary")}
            </div>
          </>
        ) : (
          <form method="post" action={`/factories/${fa.slug}/rollout`} class="actions">
            <input type="hidden" name="live" value={live} />
            <label class="muted" style="font-size:13px">Try a version on new tasks</label>
            <input class="in" name="candidate" list="versions" required placeholder="version, e.g. 2026-11-14.1" style="width:220px" />
            <datalist id="versions">{known.map((v) => <option value={v} />)}</datalist>
            <select class="in" name="share"><option value="0.1">10%</option><option value="0.25">25%</option><option value="0.5">50%</option></select>
            <input type="hidden" name="note" value="trial started" />
            <button class="btn primary" type="submit" disabled={!viewer}>Start trial</button>
          </form>
        )}
        {previous ? <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--rule)" class="actions"><span class="muted" style="font-size:13px">Something wrong with {live.slice(0, 12)}?</span>{set(`Roll back to ${previous.slice(0, 14)}`, { live: previous, candidate: null, share: 0, note: `rolled back from ${live}` }, "danger")}</div> : null}
      </div>

      <Sec title="This factory over its versions" n="real tasks while each version ran, plus the same benchmark for all" />
      <div class="card flush">
        <div class="scroll"><table class="tbl">
          <thead><tr><th>Version</th><th>Ran</th><th class="r">Tasks</th><th class="r">Merged</th><th class="r">Came back</th><th class="r">Cost / merged</th><th class="r">Benchmark</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={7}><Empty title="No tasks yet." /></td></tr> : rows.map((r) => (
              <tr>
                <td><a class="mono title" href={`/tasks?scope=org&days=0&version=${encodeURIComponent(r.version)}`}>{r.version.slice(0, 22)}</a> {r.version === live ? <Badge tone="good">live</Badge> : r.version === candidate ? <Badge tone="warn">candidate {Math.round(share * 100)}%</Badge> : null}</td>
                <td class="muted">{r.firstSeen ? `${when(r.firstSeen).split(",")[0]} to ${when(r.lastSeen).split(",")[0]}` : "benchmark only"}</td>
                <td class="r num">{r.tasks}</td>
                <td class="r num">{r.merged}</td>
                <td class="r num">{r.cameBackN < 5 && r.tasks > 0 ? <span class="muted">too early</span> : formatValue(r.cameBack, "pct")}</td>
                <td class="r num">{formatValue(r.costPerMerged, "usd")}</td>
                <td class="r num">{r.bench ? <a class="link" href={`/bench/runs/${r.bench.run}`}>{Math.round(r.bench.passRate * 100)}% of {r.bench.attempts}</a> : <span class="muted">–</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
      <p class="note">Real-task numbers differ in what work came in, so the benchmark column is the fair comparison.</p>

      {history.length > 0 ? (
        <>
          <Sec title="Rollout history" n={history.length} />
          <div class="card flush"><table class="tbl"><tbody>
            {rollout ? <tr><td class="mono">{(rollout.live ?? "server version").slice(0, 18)}</td><td>{rollout.candidate ? `${rollout.candidate.slice(0, 18)} at ${Math.round(rollout.share * 100)}%` : <span class="muted">no candidate</span>}</td><td class="muted">{rollout.note ?? ""}</td><td class="r muted">{rollout.updatedBy}, {when(rollout.updatedAt)} · now</td></tr> : null}
            {history.map((h) => <tr><td class="mono">{(h.live ?? "server version").slice(0, 18)}</td><td>{h.candidate ? `${h.candidate.slice(0, 18)} at ${Math.round(h.share * 100)}%` : <span class="muted">no candidate</span>}</td><td class="muted">{h.note ?? ""}</td><td class="r muted">{h.updatedBy}, {when(h.updatedAt)}</td></tr>)}
          </tbody></table></div>
        </>
      ) : null}

      <Sec title="How a task flows" n="fixed by the core, the same in every factory" />
      <div class="card">
        <ol class="t2" style="margin:0;padding-left:20px;line-height:1.8">
          <li><b>Asked</b>: an issue with the factory label, the app, or a chat message.</li>
          <li><b>Agent work</b>: in a sandbox, with its own environment, on the routed version.</li>
          <li><b>PR opened</b> only with evidence that "done when" holds: screenshots, test users set up in the right state, e2e output.</li>
          <li><b>Review</b>: people review; merge risk says how many approvals it needs. The agent answers comments.</li>
          <li><b>Merged</b> by a person on the code host.</li>
          <li><b>After merge</b>: {HELD_UP_DAYS} days of reverts, incidents, follow-up fixes and deploys come back to the task.</li>
        </ol>
      </div>
    </>
  );
}

export function FactoryTabs({ slug, on }: { slug: string; on: string }) {
  const tabs: Array<[string, string]> = [[`/factories/${slug}`, "Overview and versions"], ["/agents", "Agents"], ["/automations", "Automations"], ["/environments", "Environments"], ["/apps", "MCPs and apps"], ["/secrets", "Secrets"]];
  return <div class="tabs">{tabs.map(([h, l]) => <a href={h} class={on === h ? "on" : ""}>{l}</a>)}</div>;
}

// ───────────────────────────── scorers ─────────────────────────────

const KIND_OF_SCORER = (name: string) => (name.startsWith("checks.") ? "check" : name.startsWith("judge.") ? "judge" : "fact");

export function ScorersInScope({ facts, factories, team, f }: { facts: TaskFacts[]; factories: FactoryView[]; team: Team | null; f: Filters }) {
  const names = new Map<string, { n: number; pass: number; sum: number; pf: boolean }>();
  for (const x of facts) {
    for (const s of x.task.scores) {
      const doc = scorerDocs[s.scorer];
      const pf = doc ? doc.kind === "pass_fail" : s.value === 0 || s.value === 1;
      const e = names.get(s.scorer) ?? { n: 0, pass: 0, sum: 0, pf };
      e.n++;
      e.sum += s.value;
      if (s.value === 1) e.pass++;
      names.set(s.scorer, e);
    }
  }
  const org = Object.keys(scorerDocs).filter((k) => !k.startsWith("facts.stage_s."));
  const fa = team ? factories.find((x) => x.slug === team.factory) : null;
  const all = [...new Set([...org, ...names.keys(), "checks.world"])];
  return (
    <>
      <PageHeader title="Scorers" sub="A scorer turns a task into a number the factory can be judged by. Org scorers apply to every factory; a team factory adds its own and can raise a sample rate, never switch an org scorer off." />
      <div class="grid g3" style="margin-bottom:16px">
        <div class="card"><h3>Fact</h3><p class="t2" style="font-size:13.5px;margin:6px 0 0">Read from the record. No model, no cost: did CI pass, did it merge, did it come back.</p></div>
        <div class="card"><h3>Check</h3><p class="t2" style="font-size:13.5px;margin:6px 0 0">Runs something against the change: tests, an e2e spec, the OpenWorld 30-day run. Pass or fail; benchmarks decide on these.</p></div>
        <div class="card"><h3>Judge</h3><p class="t2" style="font-size:13.5px;margin:6px 0 0">A model grades the change against a rubric. Cheap to write, can be wrong, so it is sampled and never the only gate.</p></div>
      </div>
      <div class="card flush">
        <div class="scroll"><table class="tbl">
          <thead><tr><th>Scorer</th><th>From</th><th>Kind</th><th>Measures</th><th class="r">In scope</th></tr></thead>
          <tbody>
            {all.map((name) => {
              const d = scorerDocs[name];
              const e = names.get(name);
              const val = !e ? "–" : e.pf ? `${Math.round((e.pass / e.n) * 100)}%` : d?.kind === "usd" ? usd(e.sum / e.n) : d?.kind === "seconds" ? formatValue(e.sum / e.n / 3600, "hours") : (e.sum / e.n).toFixed(1);
              return (
                <tr>
                  <td><b style="font-weight:550">{d?.title ?? (name === "checks.world" ? "OpenWorld 30 days" : name)}</b><div class="mono muted" style="font-size:12px">{name}</div></td>
                  <td>{name === "checks.world" ? "team world" : "org"}</td>
                  <td>{KIND_OF_SCORER(name)}</td>
                  <td class="wrapcell t2" style="font-size:13.5px">{d?.measures ?? (name === "checks.world" ? "1 if the PR's head held every invariant over 30 simulated days in the team's OpenWorld world." : "")}</td>
                  <td class="r num">{e ? <a class="link" href={`/tasks?${filterQuery(f)}`}>{val}</a> : <span class="muted">no results</span>}{e ? <div class="muted" style="font-size:12px">{e.n} tasks</div> : null}</td>
                </tr>
              );
            })}
            {(fa?.scorers ?? []).map((s) => <tr><td><b style="font-weight:550">{s}</b></td><td>{team?.name}</td><td>check</td><td class="t2">Team scorer from factories/{fa!.slug}</td><td class="r muted">no results yet</td></tr>)}
          </tbody>
        </table></div>
      </div>
      <p class="note">Results go to the ledger with the task, and out to DX and OpenTelemetry. A new scorer can be back-filled on past tasks before it goes live.</p>
    </>
  );
}

// ───────────────────────────── improve ─────────────────────────────

export function ImprovePage({ facts, now, f, runs, team, rollout }: { facts: TaskFacts[]; now: string; f: Filters; runs: BenchRun[]; team: Team | null; rollout: RolloutState | null }) {
  const back = facts.filter((x) => cameBack(x.task).length > 0);
  const byKind = new Map<string, TaskFacts[]>();
  for (const x of back) byKind.set(kindOf(x.task), [...(byKind.get(kindOf(x.task)) ?? []), x]);
  return (
    <>
      <PageHeader crumb={team ? <><a href="/teams">Teams</a> / <a href={`/teams/${team.slug}`}>{team.name}</a> / Improve</> : "Improve"} title={team ? "Improve our factory" : "Improve the factory"} sub="Every change to a factory goes through the same four gates. Tasks that came back are where to start; a person promotes." />
      <div class="grid g4" style="margin-bottom:8px">
        {[["1. Benchmark", "Past tasks, frozen at their start. Must not get worse. Minutes, a few dollars."], ["2. OpenWorld", "Deploy the result into the team's world: 30 simulated days. Its rules must hold."], ["3. Live share", "10% of new real tasks, picked at random, for about 20 tasks."], ["4. Promote", "A person promotes. Rolled back by one click."]].map(([h, d]) => <div class="card"><h3>{h}</h3><p class="t2" style="font-size:13.5px;margin:6px 0 0">{d}</p></div>)}
      </div>
      <Sec title="Changes in flight" />
      <div class="card flush">
        <div class="scroll"><table class="tbl">
          <thead><tr><th>Change</th><th>Benchmark</th><th>Live share</th><th>Promote</th></tr></thead>
          <tbody>
            {rollout?.candidate ? <tr><td className="mono">{rollout.candidate}</td><td>{runs.find((r) => r.arms.some((a) => a.factoryVersion === rollout.candidate))?.report?.summary ?? "not run yet"}</td><td>{Math.round(rollout.share * 100)}% of new tasks, {facts.filter((x) => x.task.factoryVersion === rollout.candidate).length} so far</td><td><a class="link" href={`/factories/${team?.factory ?? "default"}`}>decide on the factory page</a></td></tr> : null}
            {runs.filter((r) => r.status === "running").map((r) => <tr><td class="mono">{r.arms[1].factoryVersion}</td><td>running, {r.results.length} results so far</td><td class="muted">not started</td><td class="muted">after the benchmark</td></tr>)}
            {!rollout?.candidate && !runs.some((r) => r.status === "running") ? <tr><td colSpan={4}><Empty title="Nothing in flight.">Start with a task that came back: save it as a benchmark task, change the factory, compare.</Empty></td></tr> : null}
          </tbody>
        </table></div>
      </div>
      <Sec title="What came back after merge" n={`${back.length} task${back.length === 1 ? "" : "s"}`}><a class="btn" href={`/insights?${filterQuery(f, { measure: "came_back", by: "kind" })}`}>By kind of task</a></Sec>
      {back.length === 0 ? <Rows><Empty title={`Nothing came back in this period.`}>Reverts, follow-up fixes and incidents linked to merged factory work show up here.</Empty></Rows> : (
        [...byKind.entries()].sort((a, b) => b[1].length - a[1].length).map(([kind, xs]) => (
          <>
            <div class="muted" style="font-size:13px;margin:14px 0 6px">{kind}, {xs.length}</div>
            <Rows>{xs.map((x) => <TaskRow f={x} now={now} needs action={x.task.status === "merged" ? <form method="post" action={`/tasks/${x.task.id}/benchmark`} style="margin:0"><button class="btn" style="height:28px" type="submit">Save as benchmark</button></form> : undefined} />)}</Rows>
          </>
        ))
      )}
    </>
  );
}
