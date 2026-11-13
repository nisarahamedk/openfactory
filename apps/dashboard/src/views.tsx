import type { Child } from "hono/jsx";
import type { BenchmarkTask, Evidence, LedgerEvent, Team, TaskRecord, TaskStatus } from "@openfactory/contracts";
import type { BenchRun } from "@openfactory/bench";
import type { FactoryInfo, FactoryView } from "@openfactory/client";
import { formatDuration, latestScores } from "@openfactory/scoring";
import { BarChart, PassCostChart, shortDay, TimeChart } from "./charts.js";
import { isOpen, type DayRow, type InboxItem, type Insights, type RunFilter, type ScorerSummary, type TaskFacts } from "./insights.js";
import { byFactoryVersion } from "./stats.js";
import { Badge, Empty, Icon, PageHeader, type Tone } from "./ui.js";

// ───────────────────────────── formatting ─────────────────────────────

export const usd = (n: number | null) => (n === null ? "–" : n >= 1000 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `$${n.toFixed(2)}`);
export const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const num = (n: number | null, d = 1) => (n === null ? "–" : n.toFixed(d));
const dur = (s: number | null) => (s === null ? "–" : formatDuration(s));
export const when = (iso: string) => `${shortDay(iso)}, ${iso.slice(11, 16)}`;

export function ago(iso: string, now: string): string {
  const s = Math.max(0, (Date.parse(now) - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  received: { label: "Queued", tone: "neutral" },
  preparing: { label: "Preparing", tone: "info" },
  working: { label: "Working", tone: "info" },
  awaiting_review: { label: "Awaiting review", tone: "warn" },
  iterating: { label: "Iterating", tone: "info" },
  merged: { label: "Merged", tone: "good" },
  closed: { label: "Closed", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
};

export const Status = ({ s }: { s: TaskStatus }) => (
  <Badge tone={STATUS[s].tone} live={s === "working" || s === "preparing" || s === "iterating"}>{STATUS[s].label}</Badge>
);

const STATUS_ICON: Record<TaskStatus, string> = { received: "queued", preparing: "spin", working: "spin", iterating: "spin", awaiting_review: "half", merged: "done", closed: "minus", failed: "fail" };

export const StatusIcon = ({ s }: { s: TaskStatus }) => (
  <span class={`si ${STATUS[s].tone}${STATUS_ICON[s] === "spin" ? " live" : ""}`} title={STATUS[s].label}><Icon name={STATUS_ICON[s]!} size={16} /></span>
);

const SOURCE: Record<string, string> = { github_issue: "GitHub issue", api: "API", benchmark_replay: "Benchmark" };
const initials = (model: string) => (model.match(/haiku|sonnet|opus|gpt|gemini|codex/i)?.[0] ?? model).slice(0, 2).toUpperCase();

/** One run as a list row: status, title and context, PR, cost, age. */
function RunRow({ t, f, now, note, needs }: { t: TaskRecord; f?: TaskFacts | undefined; now: string; note?: string; needs?: boolean }) {
  return (
    <div class={`row${needs ? " needs" : ""}`}>
      <StatusIcon s={t.status} />
      <div class="ttl">
        <a href={`/tasks/${t.id}`}>{t.title}</a>
        <span class="s2">
          {note ? <span class="w">{note}</span> : <><span class="w">{STATUS[t.status].label}</span>{t.source.repo.name}{t.source.issueNumber !== null ? `#${t.source.issueNumber}` : ""}{f && f.turns.length ? `, ${f.turns.length} turn${f.turns.length === 1 ? "" : "s"}` : ""}{t.evidence.length ? `, ${t.evidence.length} evidence` : ""}{f?.lastError && isOpen(t.status) ? ", last turn errored" : ""}</>}
        </span>
      </div>
      <span class="pr">{t.pr ? <a href={t.pr.url}>PR #{t.pr.number}</a> : <span class="muted">no PR</span>}</span>
      <span class="cost num">{usd(t.usage.costUsd)}</span>
      <span class="when" title={t.createdAt}>{ago(t.updatedAt, now)}</span>
    </div>
  );
}

const RowHead = () => <div class="rowhead"><span /><span>Run</span><span>PR</span><span>Cost</span><span>Updated</span></div>;

const Card = ({ children, flush }: { children: Child; flush?: boolean }) => <div class={`card${flush ? " flush" : ""}`}>{children}</div>;

function RangePicker({ days, now, base }: { days: number; now: string; base: string }) {
  const from = new Date(Date.parse(now) - (days - 1) * 86_400_000).toISOString();
  return (
    <>
      <div class="seg">{[7, 30, 90].map((d) => <a href={`${base}?days=${d}`} class={days === d ? "on" : ""}>{d}d</a>)}</div>
      <span class="range"><Icon name="cal" />{shortDay(from)} – {shortDay(now)}, {now.slice(0, 4)}</span>
    </>
  );
}

// ───────────────────────────── dashboard ─────────────────────────────

export function DashboardPage({ i, days, now }: { i: Insights; days: DayRow[]; now: string }) {
  const c = i.cycle;
  const prs = days.reduce((s, d) => s + d.opened, 0);
  const meanPerPr = prs === 0 ? null : days.reduce((s, d) => s + (d.costPerPr ?? 0) * d.opened, 0) / prs;
  const stages = [
    { label: "Kickoff to PR opened", st: c.kickoffToPr, color: "var(--series-1)" },
    { label: "PR to first human review", st: c.prToFirstReview, color: "var(--series-2)" },
    { label: "First review to merge", st: c.firstReviewToMerge, color: "var(--series-3)" },
  ];
  const dayKeys = days.map((d) => d.day);
  const outcomes: Array<[string, number]> = [["Reverted", i.outcomes.reverted], ["Linked to an incident", i.outcomes.incidents], ["Needed a hotfix", i.outcomes.hotfix], ["Reworked within weeks", i.outcomes.rework]];
  const bad = outcomes.reduce((n, [, v]) => n + v, 0);
  return (
    <>
      <PageHeader title="Dashboard">
        <RangePicker days={i.days} now={now} base="/" />
      </PageHeader>

      <div class="readout" style="--cols:5">
        <div><div class="k">Cost per PR</div><div class="v">{usd(meanPerPr)}</div><div class="c">median {usd(i.cost.medianPerPr.value)}</div></div>
        <div><div class="k">PRs merged</div><div class="v">{i.merged}</div><div class="c">of {prs} opened</div></div>
        <div><div class="k" title="A human commit is a new PR head that appeared while no agent turn was running.">Autonomy</div><div class="v">{pct(i.autonomy.rate)}</div><div class="c">{i.autonomy.noHumanCommits} of {i.autonomy.merged} merged PRs had no human commit</div></div>
        <div><div class="k">Cycle time</div><div class="v">{dur(c.kickoffToMerge.value)}</div><div class="c">median kickoff to merge</div></div>
        <div><div class="k">Spend</div><div class="v">{usd(i.cost.total)}</div><div class="c">{usd(i.cost.perMerged)} per merged PR</div></div>
      </div>

      <div class="card">
        <div class="head">
          <h3>Cost per PR</h3>
          <div class="legend"><span><i style="background:var(--series-1)" />Inference</span><span><i class="ref" />Median</span><span class="muted">Compute and platform are not metered yet</span></div>
        </div>
        <TimeChart label="Mean model cost per PR, by the day the PR opened" days={dayKeys} series={[{ name: "Inference", color: "var(--series-1)", values: days.map((d) => d.costPerPr) }]} format={(n) => usd(n)} height={250} width={1080} refValue={i.cost.medianPerPr.value} />
      </div>

      <div class="card flush" style="margin-top:16px">
        <div class="split">
          <div>
            <div class="head">
              <h3>Pull requests per day</h3>
              <div class="legend"><span><i class="sq" style="background:var(--series-1)" />Merged</span><span><i class="sq" style="background:var(--series-2)" />Not merged yet</span></div>
            </div>
            <BarChart label="Pull requests opened per day, split by whether they merged" days={dayKeys} series={[{ name: "Merged", color: "var(--series-1)", values: days.map((d) => d.merged) }, { name: "Not merged yet", color: "var(--series-2)", values: days.map((d) => Math.max(0, d.opened - d.merged)) }]} height={210} width={520} />
          </div>
          <div>
            <h3>Where the time goes</h3>
            <div class="meta">Median of each stage, over merged PRs</div>
            <div style="margin-top:22px" class="hbar">
              {stages.filter((x) => (x.st.value ?? 0) > 0).map((x) => <span style={`flex:${x.st.value};background:${x.color}`} title={`${x.label}: ${dur(x.st.value)}`} />)}
            </div>
            <table class="tbl" style="margin-top:12px">
              <tbody>
                {stages.map((x) => (
                  <tr>
                    <td style="padding-left:0"><span class="legend"><span><i class="sq" style={`background:${x.color}`} />{x.label}</span></span></td>
                    <td class="r num">{dur(x.st.value)}</td>
                    <td class="r muted" style="padding-right:0">{x.st.n} PRs</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="meta" style="margin-top:14px">{pct(i.autonomy.firstTryRate)} merged as first proposed, with no review round.</div>
          </div>
        </div>
      </div>

      <div class="card flush" style="margin-top:16px">
        <div class="split">
          <div>
            <h3>Cost by PR size</h3>
            <div class="meta">Lines changed on the PR's latest head</div>
            <table class="tbl" style="margin-top:10px">
              <thead><tr><th style="padding-left:0">Size</th><th class="r">PRs</th><th class="r">Merged</th><th class="r">Median cost</th><th class="r" style="padding-right:0">Review rounds</th></tr></thead>
              <tbody>
                {i.cost.bySize.map((b, k) => (
                  <tr>
                    <td style="padding-left:0"><b style="font-weight:600">{b.size}</b> <span class="muted">{k === 0 ? `under ${b.under}` : b.under === null ? `${i.cost.bySize[k - 1]!.under} and up` : `${i.cost.bySize[k - 1]!.under} to ${b.under - 1}`}</span></td>
                    <td class="r num">{b.prs}</td>
                    <td class="r num">{b.merged}</td>
                    <td class="r num">{usd(b.medianCostUsd)}</td>
                    <td class="r num" style="padding-right:0">{num(b.medianReviewRounds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3>Most expensive</h3>
            <div class="meta">Model spend per run in this range</div>
            {i.cost.mostExpensive.length === 0 ? <Empty title="No PRs yet" /> : (
              <table class="tbl" style="margin-top:10px">
                <tbody>
                  {i.cost.mostExpensive.map((f) => (
                    <tr>
                      <td style="padding-left:0;max-width:260px;overflow:hidden;text-overflow:ellipsis"><a class="title" href={`/tasks/${f.task.id}`}>{f.task.title}</a></td>
                      <td class="r num muted">{f.prSize ? `+${f.prSize.additions} −${f.prSize.deletions}` : "–"}</td>
                      <td class="r num" style="padding-right:0"><b style="font-weight:600">{usd(f.task.usage.costUsd)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div class="section-title">After the merge</div>
      <div class="readout" style="--cols:4">
        {outcomes.map(([k, v]) => <div><div class="k">{k}</div><div class="v" style={v > 0 ? "color:var(--bad)" : ""}>{v}</div></div>)}
      </div>
      <p class="note" style="margin-top:-4px">{bad === 0 ? "Nothing merged in this range has come back so far." : "Counted when the metrics source reports it, which can be weeks after the merge."}</p>

      {i.scorers.some((x) => x.n > 0 && !x.name.startsWith("facts.stage_s.")) ? (
        <>
          <div class="section-title">Scorers<a class="link" style="margin-left:auto;font-size:13.5px;font-weight:450" href="/scorers">All scorers</a></div>
          <div class="readout" style="--cols:4">
            {i.scorers.filter((x) => !x.name.startsWith("facts.stage_s.") && x.n > 0).slice(0, 4).map((x) => <div><div class="k">{x.title}</div><div class="v">{formatScorer(x)}</div><div class="c">{x.kind === "pass_fail" ? "pass rate" : "median"} over {x.n} run{x.n === 1 ? "" : "s"}</div></div>)}
          </div>
        </>
      ) : null}
    </>
  );
}

function scorerValue(scorers: ScorerSummary[], name: string): string {
  const s = scorers.find((x) => x.name === name);
  return s ? formatScorer(s) : "–";
}

function formatScorer(s: ScorerSummary): string {
  if (s.value === null) return "–";
  switch (s.kind) {
    case "pass_fail": return pct(s.value);
    case "usd": return usd(s.value);
    case "seconds": return dur(s.value);
    default: return num(s.value);
  }
}

// ───────────────────────────── activity ─────────────────────────────

const INBOX: Record<InboxItem["kind"], string> = { blocked: "Blocked", ci_failing: "CI failing", pr_review: "Review the PR", failed: "Failed" };

export type Stage = "all" | "needs_you" | "working" | "review" | "merged" | "ended";
const STAGES: Array<{ key: Exclude<Stage, "all">; label: string; icon: string; tone: Tone }> = [
  { key: "needs_you", label: "Needs you", icon: "info", tone: "warn" },
  { key: "working", label: "Working", icon: "spin", tone: "info" },
  { key: "review", label: "In review", icon: "half", tone: "warn" },
  { key: "merged", label: "Merged", icon: "done", tone: "good" },
  { key: "ended", label: "Failed or closed", icon: "fail", tone: "bad" },
];

export function ActivityPage({ items, facts, now, stage }: { items: InboxItem[]; facts: TaskFacts[]; now: string; stage: Stage }) {
  const needs = new Set(items.map((x) => x.facts.task.id));
  const byStage: Record<Exclude<Stage, "all">, Array<{ f: TaskFacts; note?: string }>> = {
    needs_you: items.map((x) => ({ f: x.facts, note: `${INBOX[x.kind]}. ${x.detail.slice(0, 140)}` })),
    working: facts.filter((f) => isOpen(f.task.status) && f.task.status !== "awaiting_review" && !needs.has(f.task.id)).map((f) => ({ f })),
    review: facts.filter((f) => f.task.status === "awaiting_review" && !needs.has(f.task.id)).map((f) => ({ f })),
    merged: facts.filter((f) => f.task.status === "merged").map((f) => ({ f })),
    ended: facts.filter((f) => (f.task.status === "failed" || f.task.status === "closed") && !needs.has(f.task.id)).map((f) => ({ f })),
  };
  const shown = STAGES.filter((g) => stage === "all" || g.key === stage);
  const total = shown.reduce((n, g) => n + byStage[g.key].length, 0);
  return (
    <>
      <PageHeader title="Activity" sub="Every run by stage. What needs a person comes first." />
      <div class="filters">
        <a href="/activity" class={stage === "all" ? "on" : ""}>All</a>
        {STAGES.map((g) => <a href={`/activity?stage=${g.key}`} class={stage === g.key ? "on" : ""}>{g.label}<span class="n">{byStage[g.key].length}</span></a>)}
        <span class="right">Showing {total} result{total === 1 ? "" : "s"}</span>
      </div>
      {shown.map((g) => {
        const rows = byStage[g.key];
        const cap = g.key === "merged" || g.key === "ended" ? 25 : 200;
        return (
          <details class="group rows" open={rows.length > 0 && (stage !== "all" || g.key !== "ended")}>
            <summary>{g.key === "needs_you" ? <span class="dot hivis" /> : <span class={`si ${g.tone}`}><Icon name={g.icon} size={16} /></span>}{g.label}<span class="n">{rows.length}</span><span class="chev"><Icon name="chev" size={16} /></span></summary>
            {rows.length === 0 ? <Empty title={g.key === "needs_you" ? "You're all caught up" : "Nothing here"}>{g.key === "needs_you" ? "Nothing needs a person right now." : null}</Empty> : rows.slice(0, cap).map((r) => <RunRow t={r.f.task} f={r.f} now={now} note={r.note} needs={g.key === "needs_you"} />)}
            {rows.length > cap ? <a class="more link" href="/runs">See all {rows.length} in Runs</a> : null}
          </details>
        );
      })}
    </>
  );
}

// ───────────────────────────── runs ─────────────────────────────

export function RunsPage({ tasks, all, filter, facts, now, live }: { tasks: TaskRecord[]; all: TaskRecord[]; filter: RunFilter; facts: Map<string, TaskFacts>; now: string; live: boolean }) {
  const opts = (xs: string[]) => [...new Set(xs)].sort();
  const repos = opts(all.map((t) => `${t.source.repo.owner}/${t.source.repo.name}`));
  const versions = opts(all.map((t) => t.factoryVersion));
  const models = opts(all.map((t) => t.harness.model));
  const count = (st: string) => all.filter((t) => (st === "all" ? true : st === "open" ? isOpen(t.status) : st === "done" ? !isOpen(t.status) : t.status === st)).length;
  const tab = (status: string, label: string) => {
    const q = new URLSearchParams({ ...filterParams(filter), status });
    return <a href={`/runs?${q}`} class={filter.status === status ? "on" : ""}>{label}<span class="c">{count(status)}</span></a>;
  };
  return (
    <>
      <PageHeader title="Runs" sub={`${tasks.length} of ${all.length} runs, ${usd(tasks.reduce((s, t) => s + t.usage.costUsd, 0))} model spend`} />
      <div class="tabs">{tab("all", "All")}{tab("open", "Active")}{tab("awaiting_review", "Awaiting review")}{tab("merged", "Merged")}{tab("failed", "Failed")}{tab("done", "Finished")}</div>
      <form method="get" action="/runs" class="toolbar">
        <input type="hidden" name="status" value={filter.status} />
        <input class="in" type="search" name="q" value={filter.q} placeholder="Search title or id" style="min-width:220px" />
        <Select name="repo" value={filter.repo} all="All repos" options={repos} />
        <Select name="version" value={filter.version} all="All versions" options={versions} />
        <Select name="model" value={filter.model} all="All models" options={models} />
        <Select name="source" value={filter.source} all="All sources" options={["github_issue", "api", "benchmark_replay"]} />
        <label class="t2" style="font-size:13px;display:inline-flex;gap:6px;align-items:center"><input type="checkbox" name="live" value="1" checked={live} /> Auto-refresh</label>
        <button class="btn" type="submit">Apply</button>
      </form>
      {tasks.length === 0 ? (
        <Card><Empty title={all.length === 0 ? "No runs yet" : "No runs match"}>{all.length === 0 ? <>Label a GitHub issue <code>factory</code> to start one.</> : "Try a different filter."}</Empty></Card>
      ) : <RunsTable tasks={tasks} facts={facts} now={now} />}
    </>
  );
}

function filterParams(f: RunFilter): Record<string, string> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "" && v !== "all")) as Record<string, string>;
}

function Select({ name, value, all, options }: { name: string; value: string; all: string; options: string[] }) {
  return (
    <select class="in" name={name}>
      <option value="">{all}</option>
      {options.map((o) => <option value={o} selected={o === value}>{o}</option>)}
    </select>
  );
}

function RunsTable({ tasks, facts, now }: { tasks: TaskRecord[]; facts: Map<string, TaskFacts>; now: string }) {
  return <><RowHead /><div class="rows">{tasks.map((t) => <RunRow t={t} f={facts.get(t.id)} now={now} />)}</div></>;
}

// ───────────────────────────── run detail ─────────────────────────────

export function TaskPage({ t, events, facts, now, viewer = null, team = null, factory = null }: { t: TaskRecord; events: LedgerEvent[]; facts: TaskFacts; now: string; viewer?: string | null; team?: Team | null; factory?: FactoryView | null }) {
  const scores = [...latestScores(t.scores).values()];
  const end = isOpen(t.status) ? now : t.updatedAt;
  return (
    <>
      <PageHeader
        crumb={<><a href="/tasks">Tasks</a> / <span class="mono">{t.id}</span></>}
        title={t.title}
        sub={<span style="display:inline-flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px"><Status s={t.status} />{t.requestedBy ? <span>asked by <a class="link" href={`/people/${t.requestedBy}`}>{t.requestedBy}</a></span> : null}<span>{t.harness.name} with {t.harness.model}</span><span class="mono">{t.factoryVersion}{t.versionArm === "candidate" ? " (candidate)" : ""}</span><span>started {when(t.createdAt)}</span></span>}
      >
        {t.pr ? <a class="btn" href={t.pr.url}><Icon name="pr" />PR #{t.pr.number}</a> : null}
        {t.status === "merged" ? (
          <form method="post" action={`/tasks/${t.id}/benchmark`}><button class="btn" type="submit"><Icon name="flask" />Turn into benchmark task</button></form>
        ) : null}
        {isOpen(t.status) ? (
          <form method="post" action={`/tasks/${t.id}/cancel`} class="actions">
            <input class="in" name="reason" placeholder="Reason (optional)" maxlength={1000} style="width:170px" />
            <button class="btn danger" type="submit"><Icon name="stop" />Stop task</button>
          </form>
        ) : null}
      </PageHeader>

      {facts.lastError && isOpen(t.status) ? <div class="alert bad"><b>Last error.</b> {facts.lastError}</div> : null}
      {facts.cancelled ? <div class="alert warn">Stopped{facts.cancelled.by ? ` by ${facts.cancelled.by}` : ""}{facts.cancelled.reason ? `: ${facts.cancelled.reason}` : "."} A new comment on the issue or PR resumes it.</div> : null}

      <div class="readout">
        <div><div class="k">Model cost</div><div class="v">{usd(t.usage.costUsd)}</div><div class="c">{t.usage.inputTokens.toLocaleString()} tokens in, {t.usage.outputTokens.toLocaleString()} out</div></div>
        <div><div class="k">{isOpen(t.status) ? "Running for" : "Ask to done"}</div><div class="v">{dur((Date.parse(end) - Date.parse(t.createdAt)) / 1000)}</div><div class="c">{facts.turns.length} agent turns, {t.people.reviewRounds} review rounds</div></div>
        <div><div class="k">PR size</div><div class="v">{facts.prSize ? `+${facts.prSize.additions} −${facts.prSize.deletions}` : "–"}</div><div class="c">{facts.prSize ? `${facts.prSize.changedFiles} files${facts.ciOnHead ? `, CI ${facts.ciOnHead === "success" ? "green" : "red"} on head` : ""}` : "No PR yet"}</div></div>
        <div><div class="k">Human commits</div><div class="v">{facts.humanPushes}</div><div class="c">{facts.humanPushes === 0 ? "Fully agent-written" : "Pushed by people between turns"}</div></div>
      </div>

      {t.status === "awaiting_review" || (t.risk && t.pr) ? <ReviewPanel t={t} facts={facts} team={team} factory={factory} /> : null}

      <div class="grid detail" style="align-items:start">
        <div class="stack" style="min-width:0">
          <Card>
            <div class="head"><h3>Conversation</h3><span class="muted" style="font-size:12.5px">the ask, the agent's replies and what people wrote</span></div>
            <div class="convo" style="margin-top:8px">
              <div class="say"><div class="who"><b>{t.requestedBy ?? "asker"}</b>asked</div><div class="txt">{t.ask}</div><div class="at">{when(t.createdAt)}</div></div>
              {conversation(t, events, facts).map((m) => (
                <div class={`say${m.agent ? " agent" : ""}`}><div class="who"><b>{m.who}</b>{m.role}</div><div class="txt">{m.text}{m.url ? <> <a class="link" href={m.url}>open</a></> : null}</div><div class="at">{when(m.at)}</div></div>
              ))}
            </div>
            {t.status !== "merged" && t.status !== "closed" ? (
              viewer ? (
                <form method="post" action={`/tasks/${t.id}/messages`} class="ask">
                  <textarea name="text" required maxlength={10000} placeholder={t.status === "awaiting_review" ? "Ask for a change, or ask the agent a question about the PR" : "Answer the agent, steer it, or ask how it's going"} />
                  <button class="btn primary" type="submit" style="align-self:flex-end">Send</button>
                </form>
              ) : <p class="note"><a class="link" href={`/signin?back=/tasks/${t.id}`}>Sign in</a> to write to the agent. You can also comment on the {t.pr ? "PR" : "issue"}.</p>
            ) : null}
          </Card>
          <Card>
            <h3 style="margin-bottom:10px">Agent turns</h3>
            {facts.turns.length === 0 ? <Empty title="No turns yet" /> : facts.turns.map((r) => {
              const tr = facts.transcripts.find((x) => x.turn === r.n);
              return (
                <div class="turn">
                  <div class="top">
                    <b style="font-weight:600">Turn {r.n}, {r.reason}</b>
                    <span class="muted">{when(r.startedAt)}</span>
                    <span class="num">{r.durationS === null ? <Badge tone="info" live>running</Badge> : dur(r.durationS)}</span>
                    <span class="num">{usd(r.usage?.costUsd ?? null)}</span>
                    {r.stopReason ? <span class="muted">{r.stopReason.replace("_", " ")}</span> : null}
                    <span style="margin-left:auto">{tr ? <a class="btn" href={`/tasks/${t.id}/transcripts/${encodeURIComponent(tr.key)}`}>View session</a> : null}</span>
                  </div>
                  {r.summary ? <div class="sum">{r.summary.slice(0, 600)}</div> : null}
                </div>
              );
            })}
          </Card>
          {t.evidence.length > 0 ? (
            <Card flush>
              <div style="padding:18px 20px 6px"><h3>Evidence</h3></div>
              <div class="scroll"><table class="tbl">
                <tbody>{t.evidence.map((e) => <tr><td><span class="chip">{e.kind}</span></td><td><a class="link" href={e.url}>{e.title}</a></td><td class="mono muted">{e.commitSha.slice(0, 7)}</td><td class="muted">{e.environment}</td><td class="r muted">{when(e.createdAt)}</td></tr>)}</tbody>
              </table></div>
            </Card>
          ) : null}
          {t.outcomes.length > 0 ? (
            <Card flush>
              <div style="padding:18px 20px 6px"><h3>After the merge</h3></div>
              <div class="scroll"><table class="tbl">
                <tbody>{t.outcomes.map((o) => <tr><td><Badge tone={o.kind === "merged" ? "good" : o.kind === "closed_unmerged" ? "neutral" : "bad"}>{o.kind.replace("_", " ")}</Badge></td><td class="wrapcell">{o.detail}</td><td class="muted">{o.source}</td><td class="r muted">happened {when(o.at)}<div>learned {when(o.arrivedAt)}</div></td></tr>)}</tbody>
              </table></div>
            </Card>
          ) : null}
          <Card>
            <h3>Timeline</h3>
            <ul class="timeline" style="margin-top:10px">
              {events.map((e) => {
                const bad = e.type === "error" || (e.type === "egress" && e.data.allowed === false) || e.type === "cancelled";
                const good = e.type === "status_changed" && e.data.to === "merged";
                return (
                  <li>
                    <span class={`dot ${bad ? "bad" : good ? "good" : ""}`} />
                    <div style="min-width:0"><b style="font-weight:550">{e.type.replaceAll("_", " ")}</b> <span class={bad ? "" : "t2"} style={bad ? "color:var(--bad)" : ""}>{describe(e)}</span></div>
                    <span class="muted num" style="font-size:12px">{when(e.at)}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>
        <div class="stack">
          <Card>
            <h3>Details</h3>
            <dl class="kv" style="margin-top:12px">
              <dt>Source</dt><dd>{t.source.url !== null ? <a class="link" href={t.source.url}>{t.source.repo.owner}/{t.source.repo.name}#{t.source.issueNumber}</a> : `${t.source.repo.owner}/${t.source.repo.name}`}</dd>
              <dt>Branch</dt><dd class="mono">{t.branch ?? "–"}</dd>
              {(t.repos ?? []).length > 1 ? <><dt>Repos</dt><dd>{t.repos!.map((r) => <div><span class="mono">{r.repo.owner}/{r.repo.name}</span>{r.pr ? <> <a class="link" href={r.pr.url}>#{r.pr.number}</a></> : <span class="muted"> no PR yet</span>}</div>)}</dd></> : null}
              {team ? <><dt>Team</dt><dd><a class="link" href={`/teams/${team.slug}`}>{team.name}</a>, <a class="link" href={`/factories/${team.factory}`}>{team.factory}</a> factory</dd></> : null}
              <dt>Environment</dt><dd>{t.environment ? <><span class="mono">{t.environment.name}</span> <span class="muted">({t.environment.plugin})</span></> : "–"}</dd>
              <dt>Workspace</dt><dd>{t.workspace ? <><span class="mono">{t.workspace.id.slice(0, 24)}</span> <span class="muted">({t.workspace.plugin})</span></> : "–"}</dd>
              <dt>People</dt><dd>{t.people.comments} comments, {t.people.reviewRounds} review rounds</dd>
            </dl>
          </Card>
          <Card>
            <h3>Scores</h3>
            {scores.length === 0 ? <div class="muted" style="margin-top:8px;font-size:13px">None yet.</div> : (
              <dl class="kv" style="margin-top:12px;grid-template-columns:minmax(0,1fr) auto">
                {scores.map((s) => <><dt title={s.reason}>{s.scorer.replace("facts.", "")}</dt><dd class="num" style="text-align:right">{s.label ?? s.value}</dd></>)}
              </dl>
            )}
          </Card>
          {facts.deniedHosts.length > 0 ? (
            <Card>
              <h3>Blocked network access</h3>
              <div class="t2" style="font-size:13px;margin-top:8px">The sandbox tried to reach hosts outside its allowlist:</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">{facts.deniedHosts.map((h) => <span class="chip mono">{h}</span>)}</div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}


type Said = { who: string; role: string; text: string; at: string; agent: boolean; url: string | null };

/** The task as a conversation: agent turn summaries, people's messages from the app, comments and foreman replies. */
export function conversation(t: TaskRecord, events: readonly LedgerEvent[], facts: TaskFacts): Said[] {
  const out: Said[] = [];
  for (const r of facts.turns) {
    if (r.summary) out.push({ who: "agent", role: r.reason === "intake" ? "worked on it" : r.reason === "review" ? "answered review" : "was steered", text: r.summary.slice(0, 1500), at: r.finishedAt ?? r.startedAt, agent: true, url: null });
  }
  for (const e of events) {
    const d = e.data;
    if (e.type === "message_received" && typeof d.text === "string") out.push({ who: String(d.author ?? "someone"), role: "wrote in the app", text: d.text, at: e.at, agent: false, url: typeof d.url === "string" ? d.url : null });
    else if (e.type === "comment_received" && d.isBot !== true) out.push({ who: String(d.author ?? "someone"), role: `commented on the ${d.on === "pr" ? "PR" : "issue"}`, text: "", at: e.at, agent: false, url: d.on === "pr" ? (t.pr?.url ?? null) : t.source.url });
    else if (e.type === "foreman_replied") out.push({ who: "foreman", role: "replied", text: "Answered on the issue.", at: e.at, agent: true, url: typeof d.url === "string" ? d.url : null });
  }
  // A message from the app is also a comment signal; show it once.
  const msgs = out.filter((m) => m.role === "wrote in the app");
  return out
    .filter((m) => !(m.role.startsWith("commented") && msgs.some((x) => x.who === m.who && Math.abs(Date.parse(x.at) - Date.parse(m.at)) < 120_000)))
    .sort((a, b) => a.at.localeCompare(b.at));
}

const RISK_NEEDS: Record<string, string> = { low: "Needs 1 approval.", medium: "Needs 1 approval from someone who knows the area.", high: "Needs 2 approvals, one from CODEOWNERS." };

/** What a reviewer needs before opening the diff: risk, test users already set up, and the checks. */
function ReviewPanel({ t, facts, team, factory }: { t: TaskRecord; facts: TaskFacts; team: Team | null; factory: FactoryView | null }) {
  const users = t.evidence.filter((e) => e.kind === "test-user");
  const media = t.evidence.filter((e) => e.kind === "screenshot" || e.kind === "video");
  const tests = t.evidence.filter((e) => e.kind === "test-output");
  const world = (t.worldChecks ?? []).at(-1) ?? null;
  const judge = t.scores.filter((s) => s.scorer.startsWith("judge.")).at(-1) ?? null;
  return (
    <div class="card" style="margin-bottom:16px">
      <div class="head">
        <div>
          <h3>{t.status === "awaiting_review" ? "Waiting for your review" : "Review"}</h3>
          <div class="muted" style="font-size:13px;margin-top:2px">{t.pr ? <>PR <a class="link" href={t.pr.url}>#{t.pr.number}</a>{facts.prSize ? `, +${facts.prSize.additions} −${facts.prSize.deletions} in ${facts.prSize.changedFiles} files` : ""}{(t.repos ?? []).length > 1 ? `, and ${t.repos!.length - 1} more repo${t.repos!.length === 2 ? "" : "s"}` : ""}</> : "No PR yet"}</div>
        </div>
        {t.pr ? <a class="btn primary" href={t.pr.url}><Icon name="pr" />Review on GitHub</a> : null}
      </div>
      <div class="split" style="margin:14px -22px -20px;border-top:1px solid var(--rule)">
        <div>
          <div class="muted" style="font-size:12.5px">Merge risk</div>
          {t.risk ? (
            <>
              <div class={`risk ${t.risk.level}`} style="margin-top:6px;font-size:16px"><i />{t.risk.level[0]!.toUpperCase() + t.risk.level.slice(1)}</div>
              <div class="t2" style="font-size:13.5px;margin-top:4px">{RISK_NEEDS[t.risk.level]} {t.risk.reasons.join(" ")}</div>
              <div class="muted" style="font-size:12.5px;margin-top:6px">{factory?.mergeRisk ? `${team?.name ?? "The team"}'s review rules` : "The org's default rules"} decide low, medium and high{t.risk.headSha !== t.pr?.headSha ? ", on an earlier head" : ""}.</div>
            </>
          ) : <div class="muted" style="margin-top:6px;font-size:13.5px">Not assessed yet.</div>}
          <div class="muted" style="font-size:12.5px;margin-top:16px">Checks</div>
          <dl class="kv" style="margin-top:6px;grid-template-columns:140px minmax(0,1fr);font-size:13.5px">
            <dt>CI on the PR</dt><dd>{facts.ciOnHead === null ? <span class="muted">no result yet</span> : <Badge tone={facts.ciOnHead === "success" ? "good" : "bad"}>{facts.ciOnHead === "success" ? "green" : "red"} on head</Badge>}</dd>
            <dt>E2E in its env</dt><dd>{tests.length ? tests.map((e) => <div><a class="link" href={e.url}>{e.title}</a></div>) : <span class="muted">no test output attached</span>}</dd>
            <dt>OpenWorld</dt><dd>{world ? <><Badge tone={world.status === "passed" ? "good" : world.status === "failed" ? "bad" : "warn"}>{world.status}</Badge> <span class="t2">{world.simDays} days in {world.world}{world.status !== "passed" && world.invariants.some((i) => !i.ok) ? `: ${world.invariants.filter((i) => !i.ok).map((i) => i.name).join(", ")}` : ""}</span>{world.reportUrl ? <> <a class="link" href={world.reportUrl}>report</a></> : null}</> : factory?.world ? <span class="muted">runs after review starts</span> : <span class="muted">no world for this team</span>}</dd>
            {judge ? <><dt>Review judge</dt><dd>{judge.label ?? judge.value} <span class="muted">{judge.reason.slice(0, 160)}</span></dd></> : null}
          </dl>
        </div>
        <div>
          <div class="muted" style="font-size:12.5px">Try it yourself, already set up</div>
          {users.length === 0 ? <div class="muted" style="font-size:13.5px;margin-top:6px">The agent attached no test users. Ask it to set one up in the state the change is about.</div> : (
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">{users.map((e: Evidence) => (
              <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;border:1px solid var(--rule);border-radius:6px;padding:8px 10px">
                <div style="min-width:0"><b style="font-weight:550">{e.testUser?.state ?? e.title}</b><div class="muted" style="font-size:12.5px">{e.testUser?.role ?? "user"}{e.environment ? `, ${e.environment}` : ""}</div></div>
                <a class="btn" href={e.testUser?.loginUrl ?? e.url}>Open as this user</a>
              </div>
            ))}</div>
          )}
          {media.length > 0 ? <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">{media.slice(0, 6).map((e) => <a class="chip" href={e.url}><Icon name={e.kind === "video" ? "eye" : "eye"} />{e.title}</a>)}</div> : null}
        </div>
      </div>
    </div>
  );
}

function describe(e: LedgerEvent): string {
  const d = e.data;
  const s = (k: string) => (typeof d[k] === "string" || typeof d[k] === "number" ? String(d[k]) : "");
  switch (e.type) {
    case "status_changed": return `${s("from")} → ${s("to")}`;
    case "ci_completed": return `${s("name")}: ${s("conclusion")} on ${s("headSha").slice(0, 7)}`;
    case "pr_opened": return `#${s("number")}`;
    case "pushed": return `${s("sha").slice(0, 7)}${d.byFactory === false ? " by a person" : d.byFactory === true ? " by the agent" : ""}`;
    case "turn_started": return `${s("reason")} turn`;
    case "turn_finished": return `${s("reason")} turn, ${s("stopReason")}`;
    case "comment_received": return `from ${s("author")} on the ${s("on")}${d.isBot === true ? " (bot)" : ""}`;
    case "environment_attached": return `${s("name")} (${s("plugin")})`;
    case "workspace_attached": return `${s("id").slice(0, 24)} (${s("plugin")})`;
    case "branch_set": return s("branch");
    case "error": return `${s("stage")}: ${s("message").slice(0, 300)}`;
    case "egress": return `${d.allowed === false ? "denied" : "allowed"} ${s("host")} ×${s("count")}`;
    case "signal_received": return `${s("type")} from ${s("actor")}`;
    case "message_received": return `from ${s("author")}`;
    case "world_check": return `${s("world")}: ${s("status")}`;
    case "merge_risk": return `${s("level")}`;
    case "version_routed": return `${s("version")} (${s("arm")})`;
    case "scope_planned": return Array.isArray(d.repos) ? `${d.repos.length} repos` : "";
    case "pr_stats": return `+${s("additions")} −${s("deletions")} in ${s("changedFiles")} files`;
    case "transcript_saved": return `turn ${s("turn")}, ${s("lines")} lines`;
    case "cancelled": return `by ${s("by") || "someone"}${s("reason") ? `: ${s("reason")}` : ""}`;
    case "evidence_added": return typeof d.evidence === "object" && d.evidence !== null && "title" in d.evidence ? String(d.evidence.title) : "";
    case "outcome_added": return typeof d.outcome === "object" && d.outcome !== null && "kind" in d.outcome ? String(d.outcome.kind) : "";
    case "score_added": return typeof d.score === "object" && d.score !== null && "scorer" in d.score ? `${String(d.score.scorer)} = ${String((d.score as { label?: unknown }).label ?? (d.score as { value?: unknown }).value)}` : "";
    default: return "";
  }
}

// ───────────────────────────── session transcript ─────────────────────────────

export type TranscriptLine = { at: string; kind: string; [k: string]: unknown };

export function parseTranscript(jsonl: string): TranscriptLine[] {
  return jsonl
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        const v = JSON.parse(l) as unknown;
        return typeof v === "object" && v !== null && "kind" in v ? [v as TranscriptLine] : [];
      } catch {
        return [];
      }
    });
}

export function TranscriptPage({ t, turn, lines }: { t: TaskRecord; turn: number | null; lines: TranscriptLine[] }) {
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const tools = lines.filter((l) => l.kind === "tool_call");
  return (
    <>
      <PageHeader
        crumb={<><a href="/runs">Runs</a> / <a href={`/tasks/${t.id}`}>{t.title.slice(0, 50)}</a></>}
        title={`Session${turn !== null ? `, turn ${turn}` : ""}`}
        sub={`${lines.length} entries, ${tools.length} tool calls, ${tools.filter((l) => l.status === "failed").length} failed. The factory's own copy of what the agent did.`}
      />
      <Card>
        {lines.map((l) => {
          switch (l.kind) {
            case "prompt":
              return <div class="msg"><span class="who">Factory<br />{l.at.slice(11, 16)}</span><details><summary><b style="font-weight:600">Prompt</b> <span class="muted">show</span></summary><pre class="block" style="margin-top:8px">{text(l.text)}</pre></details></div>;
            case "message":
              return <div class="msg"><span class="who">Agent<br />{l.at.slice(11, 16)}</span><div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:14.5px;line-height:1.55;max-width:75ch">{text(l.text)}</div></div>;
            case "tool_call":
              return <div class={`tool${l.status === "failed" ? " bad" : ""}`}><span class="muted">{l.at.slice(11, 16)}</span><Icon name={l.status === "failed" ? "x" : "check"} size={14} /><span>{text(l.title)}</span><span class="muted">{text(l.status)}</span></div>;
            case "plan":
              return <div class="msg"><span class="who">Agent<br />{l.at.slice(11, 16)}</span><div><b style="font-weight:600">Plan</b><ol style="margin:6px 0 0;padding-left:20px" class="t2">{(Array.isArray(l.entries) ? l.entries : []).map((e) => <li>{text(e)}</li>)}</ol></div></div>;
            case "result":
              return <div class="msg"><span class="who">{l.at.slice(11, 16)}</span><Badge tone="good">Turn ended, {text(l.stopReason).replace("_", " ")}</Badge></div>;
            case "error":
              return <div class="alert bad" style="margin:10px 0">{text(l.message)}</div>;
            default:
              return <pre class="block">{JSON.stringify(l)}</pre>;
          }
        })}
      </Card>
    </>
  );
}

// ───────────────────────────── factory pages ─────────────────────────────

function ProviderTable({ rows }: { rows: Array<{ key: string; label: string; f: FactoryInfo }> }) {
  return (
    <Card flush>
      <div class="scroll"><table class="tbl">
        <thead><tr><th>Abstraction</th><th>Provider</th><th>Options</th></tr></thead>
        <tbody>
          {rows.map(({ key, label, f }) => {
            const p = f.providers[key];
            return (
              <tr>
                <td><b style="font-weight:550">{label}</b><div class="muted mono">{key}</div></td>
                <td>{p ? <Badge tone="good">{p.name}</Badge> : <Badge tone="neutral" dot={false}>not configured</Badge>}</td>
                <td class="wrapcell mono t2">{p && Object.keys(p.options).length > 0 ? JSON.stringify(p.options) : <span class="muted">–</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </Card>
  );
}

type Role = "implementation" | "foreman";
const ROLES: Record<Role, { title: string; desc: string; icon: string; tone: string }> = {
  implementation: { title: "implementation", desc: "Implements the change, deploys it to its own environment, proves it works with evidence, opens the PR and iterates on review.", icon: "code", tone: "info" },
  foreman: { title: "foreman", desc: "Answers people on the issue and PR while the worker is busy, and steers the worker within the factory's fixed rules.", icon: "chat", tone: "brand" },
};

export function AgentsPage({ f }: { f: FactoryInfo }) {
  return (
    <>
      <PageHeader title="Agents" sub="Who does the work in this factory. Any harness that speaks the Agent Client Protocol can be the worker." />
      <div class="spec">
        {(Object.keys(ROLES) as Role[]).map((k) => (
          <a href={`/agents/${k}`}>
            <div><h4>{ROLES[k].title}</h4><div class="role">{k === "implementation" ? "Worker, one per run" : "Answers people, one per run"}</div></div>
            <p>{ROLES[k].desc}</p>
            <dl class="kv">
              {k === "implementation" ? <><dt>Harness</dt><dd>{f.agent.name}</dd></> : null}
              <dt>Model</dt><dd>{k === "implementation" ? f.agent.model : f.foreman.model}</dd>
              <dt>Prompts</dt><dd>{k === "implementation" ? "system, intake, review" : "system"}</dd>
            </dl>
          </a>
        ))}
        <div>
          <div><h4>Your own agent</h4><div class="role">Swap the worker</div></div>
          <p>Claude Code, Codex, Copilot CLI, Gemini CLI or any other ACP harness. Set <span class="mono">providers.agent</span> in factory.yaml and every new run uses it.</p>
          <div />
        </div>
      </div>
    </>
  );
}

export function AgentPage({ f, role, prompt, mcpUrl }: { f: FactoryInfo; role: Role; prompt: string; mcpUrl: string | null }) {
  const r = ROLES[role];
  const prompts: Array<[string, string]> = role === "implementation" ? [["System", f.prompts.system], ["Intake turn", f.prompts.intake], ["Review turn", f.prompts.review]] : [["System", f.prompts.foreman]];
  const cur = prompts.find(([k]) => k.toLowerCase().startsWith(prompt)) ?? prompts[0]!;
  return (
    <>
      <PageHeader crumb={<><a href="/agents">Agents</a> / {r.title}</>} title={r.title} />
      <div class="card" style="padding:20px 28px">
        <div class="form-sec"><h2>Description</h2><div class="d">What this agent is responsible for.</div><div class="t2">{r.desc}</div></div>
        <div class="form-sec">
          <h2>Agent resources</h2><div class="d">What the agent can reach while it works.</div>
          <dl class="field">
            {role === "implementation" ? <><dt>Harness</dt><dd><span class="chip"><Icon name="agent" size={13} />{f.agent.name}</span><span class="muted" style="font-size:12.5px">over ACP, inside the run's sandbox</span></dd></> : null}
            <dt>Model</dt><dd><span class="chip mono">{role === "implementation" ? f.agent.model : f.foreman.model}</span><span class="muted" style="font-size:12.5px">through the factory's model gateway</span></dd>
            <dt>MCPs</dt><dd><span class="chip"><Icon name="apps" size={13} />factory{mcpUrl ? "" : " (/mcp)"}</span>{f.providers.devEnvironment ? <span class="chip"><Icon name="env" size={13} />{f.providers.devEnvironment.name} environment skill</span> : null}</dd>
            <dt>Secrets</dt><dd><span class="chip"><Icon name="key" size={13} />repo token (one repo, 1 h)</span><span class="chip"><Icon name="key" size={13} />model key (per run budget)</span></dd>
            <dt>Limits</dt><dd><span class="chip">{usd(f.rules.maxTaskUsd)} per run</span><span class="chip">{f.rules.maxReviewRounds} review rounds</span><span class="chip">people merge</span></dd>
          </dl>
        </div>
        <div class="form-sec">
          <h2>Instructions</h2><div class="d">The prompts this agent gets, as deployed in factory version <span class="mono">{f.version}</span>.</div>
          {prompts.length > 1 ? <div class="seg ptabs">{prompts.map(([k]) => <a href={`/agents/${role}?prompt=${k.split(" ")[0]!.toLowerCase()}`} class={k === cur[0] ? "on" : ""}>{k}</a>)}</div> : null}
          <pre class="block" style="max-height:640px">{cur[1]}</pre>
        </div>
      </div>
    </>
  );
}

export function AutomationsPage({ f }: { f: FactoryInfo }) {
  const signals = f.providers.signals;
  const repos = signals && Array.isArray(signals.options.repos) ? (signals.options.repos as unknown[]).map(String) : [];
  return (
    <>
      <PageHeader title="Automations" sub="What starts a run, and the rules every run follows." />
      <div class="grid g2">
        <Card>
          <h3>Trigger</h3>
          <div class="big" style="font-size:18px">Issue labelled <span class="chip mono" style="font-size:13px;height:24px">{f.rules.label}</span></div>
          <div class="meta">{signals ? `Signals from ${signals.name}${repos.length ? ` on ${repos.join(", ")}` : ""}` : "Signals via webhook"}. A comment on the PR or issue wakes the same run.</div>
        </Card>
        <Card>
          <h3>Rules</h3>
          <dl class="kv" style="margin-top:12px;grid-template-columns:minmax(0,1fr) auto">
            <dt>Spend cap per run</dt><dd class="num">{usd(f.rules.maxTaskUsd)}</dd>
            <dt>Max review rounds</dt><dd class="num">{f.rules.maxReviewRounds}</dd>
            <dt>Max nudges</dt><dd class="num">{f.rules.maxNudges}</dd>
            <dt>Who merges</dt><dd>A person, always</dd>
          </dl>
        </Card>
      </div>
      <p class="note">Configured in <span class="mono">{f.providersFrom}</span>. Factory version <span class="mono">{f.version}</span>.</p>
    </>
  );
}

export function EnvironmentsPage({ f, active }: { f: FactoryInfo; active: TaskRecord[] }) {
  return (
    <>
      <PageHeader title="Environments" sub="Where agents run their tools, and where they deploy the product to test it." />
      <ProviderTable rows={[{ key: "workspace", label: "Workspace (sandbox)", f }, { key: "devEnvironment", label: "Dev environment", f }]} />
      <div class="section-title">Live environments <span class="muted" style="font-weight:450">{active.length}</span></div>
      <Card flush>
        {active.length === 0 ? <Empty title="No environments are up">Each run gets its own, created on intake and put to sleep while it waits for review.</Empty> : (
          <div class="scroll"><table class="tbl">
            <thead><tr><th>Environment</th><th>Run</th><th>Status</th><th>Workspace</th></tr></thead>
            <tbody>{active.map((t) => <tr><td class="mono">{t.environment?.name}</td><td><a class="title" href={`/tasks/${t.id}`}>{t.title.slice(0, 50)}</a></td><td><Status s={t.status} /></td><td class="mono muted">{t.workspace?.id.slice(0, 28) ?? "–"}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

export function AppsPage({ f, mcpUrl }: { f: FactoryInfo; mcpUrl: string | null }) {
  return (
    <>
      <PageHeader title="MCPs and apps" sub="How the factory connects to your tools, and how your tools reach the factory." />
      <Card>
        <h3>Factory MCP server</h3>
        <div class="big mono" style="font-size:14px">{mcpUrl ?? "/mcp on the factory server"}</div>
        <div class="meta">Streamable HTTP with the factory API token. Tools: list_tasks, get_task, get_task_events, add_to_benchmark, list_benchmark_runs, get_benchmark_run. Also as stdio: <span class="mono">openfactory-mcp</span>.</div>
      </Card>
      <div class="section-title">Connected apps</div>
      <ProviderTable rows={[
        { key: "codeForge", label: "Code host", f },
        { key: "signals", label: "Signals", f },
        { key: "chat", label: "Chat", f },
        { key: "metrics", label: "Metrics (DORA / DX)", f },
        { key: "evidence", label: "Evidence storage", f },
        { key: "modelGateway", label: "Model gateway", f },
      ]} />
      <p class="note">Telemetry goes out over OpenTelemetry (OTLP) when OTEL_EXPORTER_OTLP_ENDPOINT is set on the server.</p>
    </>
  );
}

export function SecretsPage({ f }: { f: FactoryInfo }) {
  return (
    <>
      <PageHeader title="Secrets" sub="Credentials are minted per run and never pass through the dashboard. Values are never shown." />
      <ProviderTable rows={[{ key: "secrets", label: "Secrets vault", f }, { key: "modelGateway", label: "Per-run model keys", f }]} />
      <div class="readout" style="--cols:3;margin-top:16px">
        <div><div class="k">Repo token</div><div class="v">Per run</div><div class="c">Scoped to one repo, refreshed before every turn</div></div>
        <div><div class="k">Model key</div><div class="v">Per run</div><div class="c">Its own budget. The org key never enters a sandbox</div></div>
        <div><div class="k">Network</div><div class="v">Allowlist</div><div class="c">Denied hosts show on the run's page</div></div>
      </div>
    </>
  );
}

export function ScorersPage({ scorers }: { scorers: ScorerSummary[] }) {
  return (
    <>
      <PageHeader title="Scorers" sub="Every run is scored when it changes state, and again when late outcomes arrive." />
      <div class="spec">
        {scorers.map((s) => (
          <div style="grid-template-columns:220px minmax(0,1fr) 140px;align-items:center;padding:18px 24px">
            <div><h4 style="font-size:15.5px">{s.title}</h4><div class="role mono">{s.name}</div></div>
            <p style="font-size:14px">{s.measures}</p>
            <div style="text-align:right"><div style="font-size:24px;font-weight:600;font-stretch:118%;line-height:30px">{formatScorer(s)}</div><div class="muted" style="font-size:12.5px">{s.kind === "pass_fail" ? "pass rate" : "median"} over {s.n} run{s.n === 1 ? "" : "s"}</div></div>
          </div>
        ))}
      </div>
      <p class="note">Custom scorers are plugins implementing the Scorer contract. They appear here once they have scored a run.</p>
    </>
  );
}

export function VersionsPage({ tasks }: { tasks: TaskRecord[] }) {
  const rows = byFactoryVersion(tasks);
  return (
    <>
      <PageHeader title="Versions" sub="Live results per factory version. Runs differ, so use a benchmark A/B to prove one version better." />
      <Card flush>
        <div class="scroll"><table class="tbl">
          <thead><tr><th>Version</th><th class="r">Runs</th><th class="r">Merged</th><th class="r">Spend</th><th class="r">Cost / merged</th><th class="r">CI first push</th><th class="r">Review rounds</th><th class="r">Ask → done</th><th class="r">Last used</th></tr></thead>
          <tbody>
            {rows.map(({ version, lastSeen, rollup: r }) => (
              <tr>
                <td class="mono">{version}</td>
                <td class="r num">{r.tasks}</td>
                <td class="r num">{r.merged}</td>
                <td class="r num">{usd(r.totalCostUsd)}</td>
                <td class="r num">{usd(r.costPerMergedUsd)}</td>
                <td class="r num">{pct(r.ciFirstPassRate)}</td>
                <td class="r num">{num(r.meanReviewRounds)}</td>
                <td class="r num">{dur(r.medianLeadTimeS)}</td>
                <td class="r muted">{lastSeen ? when(lastSeen) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Card>
    </>
  );
}

// ───────────────────────────── benchmarks ─────────────────────────────

export function BenchPage({ tasks, runs, versions, models }: { tasks: BenchmarkTask[]; runs: BenchRun[]; versions: string[]; models: [string, string] }) {
  const points = runs.flatMap((r) =>
    r.report === null
      ? []
      : [
          { label: r.arms[0].label, run: r.id, passRate: r.report.a.passRate, costUsd: r.report.a.meanCostUsd, series: 1 as const },
          { label: r.arms[1].label, run: r.id, passRate: r.report.b.passRate, costUsd: r.report.b.meanCostUsd, series: 2 as const },
        ],
  );
  return (
    <>
      <PageHeader title="Benchmarks" sub="Past runs replayed under two factory versions. Each result comes with a range, and says so when the difference is too small to trust." />
      {points.length > 0 ? (
        <Card>
          <div class="head"><h3>Correctness vs cost</h3><div class="legend"><span><i style="background:var(--series-1)" />Arm A</span><span><i style="background:var(--series-2)" />Arm B</span><span class="muted">Up and to the left is better</span></div></div>
          <PassCostChart points={points} />
        </Card>
      ) : null}
      <div class="section-title">Suite <span class="muted" style="font-weight:450">{tasks.length}</span></div>
      <Card flush>
        {tasks.length === 0 ? <Empty title="Empty.">Open a merged run and press "Turn into benchmark task".</Empty> : (
          <div class="scroll"><table class="tbl">
            <thead><tr><th>Benchmark task</th><th>From run</th><th>Repo</th><th>Start</th><th>Checks</th><th class="r">Added</th></tr></thead>
            <tbody>
              {tasks.map((b) => (
                <tr>
                  <td><b style="font-weight:550" class="mono">{b.id}</b><div class="muted" style="font-size:12px">{b.ask.split("\n")[0]?.slice(0, 60)}</div></td>
                  <td><a class="link mono" href={`/tasks/${b.sourceTaskId}`}>{b.sourceTaskId}</a></td>
                  <td>{b.repo.owner}/{b.repo.name}</td>
                  <td class="mono">{b.startCommit.slice(0, 7)}</td>
                  <td>{b.check.kind === "tests_from_merged_pr" ? <span class="chip">{Object.keys(b.check.files).length} hidden test{Object.keys(b.check.files).length === 1 ? "" : "s"}</span> : <span class="chip">command</span>}{b.check.world ? <span class="chip" style="margin-left:4px">{Object.keys(b.check.world.files).length} world</span> : null}</td>
                  <td class="r muted">{when(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      {tasks.length > 0 ? (
        <>
          <div class="section-title">Start an A/B run</div>
          <form method="post" action="/bench/runs" class="card">
            <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px">
              {tasks.map((b) => <label style="display:inline-flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" name="taskIds" value={b.id} checked /> <span class="mono">{b.id}</span></label>)}
            </div>
            <div class="grid g2">
              <ArmFields arm="A" model={models[0]} versions={versions} />
              <ArmFields arm="B" model={models[1]} versions={versions} />
            </div>
            <div class="toolbar" style="margin:16px 0 0">
              <label class="t2" style="font-size:13px">Repeats per arm <input class="in" name="repeats" type="number" min="1" max="20" value="2" style="width:72px" /></label>
              <label class="t2" style="font-size:13px">Budget $ <input class="in" name="maxCostUsd" type="number" min="0.5" step="0.5" value="5" style="width:84px" /></label>
              <button class="btn primary" type="submit">Start run</button>
            </div>
            <p class="note">Each attempt gets a fresh workspace, a fresh agent session and, for world checks, a fresh environment. Spending stops at the budget.</p>
          </form>
        </>
      ) : null}
      <div class="section-title">Runs</div>
      {runs.length === 0 ? <Card><Empty title="No runs yet" /></Card> : <div class="stack">{runs.map((r) => <RunCard run={r} />)}</div>}
    </>
  );
}

function ArmFields({ arm, model, versions }: { arm: "A" | "B"; model: string; versions: string[] }) {
  return (
    <div style="border:1px solid var(--border);border-radius:8px;padding:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><i style={`width:8px;height:8px;border-radius:50%;background:var(--series-${arm === "A" ? 1 : 2})`} /><b style="font-weight:600">Arm {arm}</b></div>
      <dl class="kv" style="align-items:center">
        <dt>Model</dt><dd><input class="in" name={`model${arm}`} value={model} style="width:100%" /></dd>
        <dt>Version</dt><dd><input class="in" name={`version${arm}`} value={versions[0] ?? "fv_current"} list="versions" style="width:100%" /></dd>
        <dt>Extra prompt</dt><dd><input class="in" name={`prompt${arm}`} value="" placeholder="optional" style="width:100%" /></dd>
      </dl>
      <datalist id="versions">{versions.map((v) => <option value={v} />)}</datalist>
    </div>
  );
}

function TaskGrid({ run }: { run: BenchRun }) {
  const [a, b] = run.arms;
  const cell = (taskId: string, arm: string) => {
    const rs = run.results.filter((r) => r.benchmarkTaskId === taskId && r.arm === arm);
    if (rs.length === 0) return <span class="muted">–</span>;
    const p = rs.filter((r) => r.passed).length;
    return <Badge tone={p === rs.length ? "good" : p === 0 ? "bad" : "warn"} dot={false}>{p}/{rs.length}</Badge>;
  };
  return (
    <table class="tbl">
      <thead><tr><th style="padding-left:0">Task</th><th class="r">Arm A, {a.label}</th><th class="r" style="padding-right:0">Arm B, {b.label}</th></tr></thead>
      <tbody>{run.taskIds.map((id) => <tr><td class="mono" style="padding-left:0">{id}</td><td class="r">{cell(id, a.label)}</td><td class="r" style="padding-right:0">{cell(id, b.label)}</td></tr>)}</tbody>
    </table>
  );
}

function RunCard({ run }: { run: BenchRun }) {
  const [a, b] = run.arms;
  const rep = run.report;
  const done = run.results.length;
  const planned = run.taskIds.length * run.repeats * 2;
  return (
    <div class="card">
      <div class="head">
        <div>
          <div style="display:flex;gap:10px;align-items:center"><b class="mono">{run.id}</b><Badge tone={run.status === "done" ? "good" : run.status === "failed" ? "bad" : "info"} live={run.status === "running"}>{run.status}</Badge></div>
          <div class="meta">Started {when(run.createdAt)}. {done} of {planned} attempts, {usd(run.spentUsd)} of {usd(run.maxCostUsd)} spent{run.stoppedForBudget ? ", stopped at budget" : ""}.</div>
        </div>
        <div class="legend"><span><i style="background:var(--series-1)" />A: {a.model} @ <span class="mono">{a.factoryVersion}</span></span><span><i style="background:var(--series-2)" />B: {b.model} @ <span class="mono">{b.factoryVersion}</span></span></div>
      </div>
      {rep !== null ? (
        <>
          <div class={`alert ${rep.verdict === "too_close" ? "warn" : ""}`} style={`margin:14px 0;${rep.verdict === "too_close" ? "" : "background:var(--good-soft);border-color:transparent"}`}><b>{rep.summary}</b></div>
          <div class="grid g2">
            <table class="tbl">
              <thead><tr><th style="padding-left:0">Arm</th><th class="r">Pass</th><th class="r">Mean cost</th><th class="r" style="padding-right:0">Mean time</th></tr></thead>
              <tbody>{[rep.a, rep.b].map((s) => <tr><td style="padding-left:0">{s.arm}</td><td class="r num">{s.passes}/{s.attempts}, {pct(s.passRate)}</td><td class="r num">{usd(s.meanCostUsd)}</td><td class="r num" style="padding-right:0">{dur(s.meanDurationS)}</td></tr>)}</tbody>
            </table>
            <TaskGrid run={run} />
          </div>
        </>
      ) : done > 0 ? <div style="margin-top:12px"><TaskGrid run={run} /></div> : null}
      {run.error !== null ? <div class="alert bad" style="margin-top:12px">{run.error}</div> : null}
      {done > 0 ? (
        <details style="margin-top:12px"><summary class="t2" style="font-size:13px">Attempts ({done})</summary>
          <table class="tbl" style="margin-top:8px">
            <thead><tr><th>Arm</th><th>Task</th><th>#</th><th>Result</th><th class="r">Cost</th><th>Notes</th></tr></thead>
            <tbody>{run.results.map((r) => <tr><td>{r.arm}</td><td class="mono">{r.benchmarkTaskId}</td><td>{r.attempt}</td><td><Badge tone={r.passed ? "good" : "bad"}>{r.passed ? "pass" : "fail"}</Badge>{r.checks ? <div class="muted" style="font-size:12px;margin-top:3px">repo {r.checks.repo ? "✓" : "✗"}, world {r.checks.world === null ? "–" : r.checks.world ? "✓" : "✗"}</div> : null}</td><td class="r num">{usd(r.usage.costUsd)}</td><td class="wrapcell"><pre class="block" style="max-height:160px">{r.notes.slice(-600)}</pre></td></tr>)}</tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

export function ErrorPage({ message }: { message: string }) {
  return (
    <>
      <PageHeader title="Can't load this page" />
      <div class="alert bad">{message}</div>
    </>
  );
}
