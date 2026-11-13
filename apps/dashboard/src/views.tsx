import type { Child } from "hono/jsx";
import type { BenchmarkTask, LedgerEvent, TaskRecord, TaskStatus } from "@openfactory/contracts";
import type { BenchRun } from "@openfactory/bench";
import type { FactoryInfo } from "@openfactory/client";
import { formatDuration, latestScores } from "@openfactory/scoring";
import { PassCostChart, shortDay, TimeChart } from "./charts.js";
import { isOpen, type DayRow, type InboxItem, type Insights, type RunFilter, type ScorerSummary, type TaskFacts } from "./insights.js";
import { byFactoryVersion } from "./stats.js";
import { Badge, Empty, Icon, PageHeader, Stat, type Tone } from "./ui.js";

// ───────────────────────────── formatting ─────────────────────────────

export const usd = (n: number | null) => (n === null ? "–" : n >= 1000 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `$${n.toFixed(2)}`);
const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const num = (n: number | null, d = 1) => (n === null ? "–" : n.toFixed(d));
const dur = (s: number | null) => (s === null ? "–" : formatDuration(s));
const when = (iso: string) => `${shortDay(iso)}, ${iso.slice(11, 16)}`;

function ago(iso: string, now: string): string {
  const s = Math.max(0, (Date.parse(now) - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

const STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
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

const STATUS_ICON: Record<TaskStatus, string> = { received: "queued", preparing: "spin", working: "spin", iterating: "spin", awaiting_review: "eye", merged: "check", closed: "minus", failed: "x" };

export const StatusIcon = ({ s }: { s: TaskStatus }) => (
  <span class={`si ${STATUS[s].tone}${STATUS_ICON[s] === "spin" ? " live" : ""}`} title={STATUS[s].label}><Icon name={STATUS_ICON[s]!} size={14} /></span>
);

const SOURCE: Record<string, string> = { github_issue: "GitHub issue", api: "API", benchmark_replay: "Benchmark" };
const initials = (model: string) => (model.match(/haiku|sonnet|opus|gpt|gemini|codex/i)?.[0] ?? model).slice(0, 2).toUpperCase();

/** One run as a list row: status, title, what it produced, cost, model, age. */
function RunRow({ t, f, now, note }: { t: TaskRecord; f?: TaskFacts | undefined; now: string; note?: string }) {
  return (
    <div class="row">
      <StatusIcon s={t.status} />
      <div class="ttl">
        <a href={`/tasks/${t.id}`}>{t.title}</a>
        <span class="s2">{note ?? <>{STATUS[t.status].label} · {t.source.repo.name}{t.source.issueNumber !== null ? `#${t.source.issueNumber}` : ""}{f && f.turns.length ? ` · ${f.turns.length} turn${f.turns.length === 1 ? "" : "s"}` : ""}{f?.lastError && isOpen(t.status) ? " · last turn errored" : ""}</>}</span>
      </div>
      <div class="chips">
        {t.pr ? <a class="chip" href={t.pr.url}><Icon name="pr" size={13} />PR #{t.pr.number}</a> : null}
        {t.evidence.length > 0 ? <span class="chip"><Icon name="image" size={13} />{t.evidence.length} evidence</span> : null}
        {t.environment ? <span class="chip"><Icon name="env" size={13} />{t.environment.name.slice(0, 18)}</span> : null}
        <span class="chip"><Icon name={t.source.kind === "benchmark_replay" ? "flask" : t.source.kind === "api" ? "code" : "issue"} size={13} />{SOURCE[t.source.kind] ?? t.source.kind}</span>
      </div>
      <span class="cost num">{usd(t.usage.costUsd)}</span>
      <span class="av" title={`${t.harness.name} · ${t.harness.model}`}>{initials(t.harness.model)}</span>
      <span class="when" title={t.createdAt}>{ago(t.updatedAt, now)}</span>
    </div>
  );
}

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
    { label: "Kickoff → PR opened", st: c.kickoffToPr, color: "var(--series-1)" },
    { label: "PR → first human review", st: c.prToFirstReview, color: "var(--series-2)" },
    { label: "First review → merge", st: c.firstReviewToMerge, color: "var(--series-3)" },
  ];
  const dayKeys = days.map((d) => d.day);
  return (
    <>
      <PageHeader title="Dashboard">
        <RangePicker days={i.days} now={now} base="/" />
      </PageHeader>

      <div class="stack">
        <Card>
          <div class="head">
            <div>
              <h3>Cost per PR</h3>
              <div class="big">{usd(meanPerPr)}</div>
              <div class="meta">{usd(i.cost.total)} model spend · {prs} PRs · median {usd(i.cost.medianPerPr.value)}</div>
            </div>
            <div class="legend"><span><i style="background:var(--series-1)" />Inference</span><span class="muted"><i style="background:var(--border-strong)" />Compute (not metered yet)</span></div>
          </div>
          <TimeChart label="Mean model cost per PR, by the day the PR opened" days={dayKeys} series={[{ name: "Inference", color: "var(--series-1)", values: days.map((d) => d.costPerPr) }]} format={(n) => usd(n)} height={260} width={1040} />
        </Card>

        <div class="grid g2">
          <Card>
            <div class="head">
              <div><h3>PRs opened</h3><div class="big">{prs}</div><div class="meta">{i.merged} merged · {i.failed + i.closed} ended without a merge</div></div>
              <div class="legend"><span><i style="background:var(--series-1)" />Opened</span><span><i style="background:var(--series-3)" />Merged</span></div>
            </div>
            <TimeChart label="PRs opened and merged per day" days={dayKeys} series={[{ name: "Opened", color: "var(--series-1)", values: days.map((d) => d.opened) }, { name: "Merged", color: "var(--series-3)", values: days.map((d) => d.merged) }]} format={(n) => String(Math.round(n))} height={190} area={false} width={500} />
          </Card>
          <Card>
            <h3>Total runs</h3>
            <div class="big">{i.started}</div>
            <div class="meta">{i.open} running or waiting now</div>
            <TimeChart label="Runs started per day" days={dayKeys} series={[{ name: "Runs", color: "var(--series-1)", values: days.map((d) => d.started) }]} format={(n) => String(Math.round(n))} height={190} width={500} />
          </Card>
        </div>

        <div class="grid g4">
          <Stat title="Autonomy" value={pct(i.autonomy.rate)} meta={`${i.autonomy.noHumanCommits} of ${i.autonomy.merged} merged PRs had no human commit`} hint="A human commit is a new PR head that appeared while no agent turn was running." />
          <Stat title="Merged as first proposed" value={pct(i.autonomy.firstTryRate)} meta={`${i.autonomy.mergedFirstTry} of ${i.autonomy.merged} with no review round`} />
          <Stat title="CI green on first push" value={scorerValue(i.scorers, "facts.ci_first_pass")} meta="Every check passed on the PR's first commit" />
          <Stat title="Spend per merged PR" value={usd(i.cost.perMerged)} meta="Total spend ÷ merged PRs, failures included" />
        </div>

        <div class="grid g2">
          <Card>
            <h3>PR cycle time</h3>
            <div class="big">{dur(c.kickoffToMerge.value)}</div>
            <div class="meta">Median kickoff → merge over {c.kickoffToMerge.n} PRs</div>
            <div style="margin-top:18px" class="hbar">
              {stages.filter((s) => (s.st.value ?? 0) > 0).map((s) => <span style={`flex:${s.st.value};background:${s.color}`} title={`${s.label}: ${dur(s.st.value)}`} />)}
            </div>
            <table class="tbl" style="margin-top:10px">
              <tbody>
                {stages.map((s) => (
                  <tr>
                    <td style="padding-left:0"><span class="legend"><span><i style={`background:${s.color}`} />{s.label}</span></span></td>
                    <td class="r num">{dur(s.st.value)}</td>
                    <td class="r muted" style="padding-right:0">{s.st.n} PRs</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card>
            <h3>Cost per PR by size</h3>
            <div class="meta">Lines changed (additions + deletions) on the PR's latest head</div>
            <table class="tbl" style="margin-top:8px">
              <thead><tr><th style="padding-left:0">Size</th><th class="r">PRs</th><th class="r">Merged</th><th class="r">Median cost</th><th class="r" style="padding-right:0">Review rounds</th></tr></thead>
              <tbody>
                {i.cost.bySize.map((b, k) => (
                  <tr>
                    <td style="padding-left:0"><b>{b.size}</b> <span class="muted">{k === 0 ? `< ${b.under}` : b.under === null ? `≥ ${i.cost.bySize[k - 1]!.under}` : `${i.cost.bySize[k - 1]!.under}–${b.under - 1}`}</span></td>
                    <td class="r num">{b.prs}</td>
                    <td class="r num">{b.merged}</td>
                    <td class="r num">{usd(b.medianCostUsd)}</td>
                    <td class="r num" style="padding-right:0">{num(b.medianReviewRounds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <div class="grid g2">
          <Card flush>
            <div style="padding:18px 20px 6px"><h3>Most expensive PRs</h3></div>
            {i.cost.mostExpensive.length === 0 ? <Empty title="No PRs yet" /> : (
              <div class="scroll"><table class="tbl">
                <thead><tr><th>Run</th><th class="r">Size</th><th class="r">Turns</th><th class="r">Cost</th></tr></thead>
                <tbody>
                  {i.cost.mostExpensive.map((f) => (
                    <tr>
                      <td><a class="title" href={`/tasks/${f.task.id}`}>{f.task.title.slice(0, 48)}</a><div class="muted" style="font-size:12px">{f.task.pr ? `#${f.task.pr.number} · ` : ""}{STATUS[f.task.status].label}</div></td>
                      <td class="r num">{f.prSize ? `+${f.prSize.additions} −${f.prSize.deletions}` : "–"}</td>
                      <td class="r num">{f.turns.length}</td>
                      <td class="r num"><b>{usd(f.task.usage.costUsd)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </Card>
          <Card>
            <h3>After the merge</h3>
            <div class="meta">What happened to merged changes later, from the metrics source</div>
            <div class="grid g2" style="margin-top:14px;gap:12px">
              {([["Reverted", i.outcomes.reverted], ["Linked to an incident", i.outcomes.incidents], ["Needed a hotfix", i.outcomes.hotfix], ["Reworked within weeks", i.outcomes.rework]] as Array<[string, number]>).map(([k, v]) => (
                <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px">
                  <div class="big" style={`font-size:22px;margin:0;${v > 0 ? "color:var(--bad)" : ""}`}>{v}</div>
                  <div class="meta">{k}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div>
          <div class="section-title" style="margin-top:12px;display:flex;justify-content:space-between"><span>Scorers</span><a class="link" style="font-size:13px;font-weight:500" href="/scorers">All scorers</a></div>
          <div class="grid g4">
            {i.scorers.filter((s) => !s.name.startsWith("facts.stage_s.") && s.n > 0).slice(0, 8).map((s) => <Stat title={s.title} value={formatScorer(s)} meta={`${s.kind === "pass_fail" ? "pass rate" : "median"} · ${s.n} run${s.n === 1 ? "" : "s"}`} />)}
          </div>
        </div>
      </div>
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
  { key: "review", label: "In review", icon: "eye", tone: "warn" },
  { key: "merged", label: "Merged", icon: "check", tone: "good" },
  { key: "ended", label: "Failed or closed", icon: "x", tone: "bad" },
];

export function ActivityPage({ items, facts, now, stage }: { items: InboxItem[]; facts: TaskFacts[]; now: string; stage: Stage }) {
  const needs = new Set(items.map((x) => x.facts.task.id));
  const byStage: Record<Exclude<Stage, "all">, Array<{ f: TaskFacts; note?: string }>> = {
    needs_you: items.map((x) => ({ f: x.facts, note: `${INBOX[x.kind]} · ${x.detail.slice(0, 140)}` })),
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
        <span class="lbl">Stage</span>
        <a href="/activity" class={stage === "all" ? "on" : ""}>All</a>
        {STAGES.map((g) => <a href={`/activity?stage=${g.key}`} class={stage === g.key ? "on" : ""}>{g.label}<span class="n">{byStage[g.key].length}</span></a>)}
        <span class="right">Showing {total} result{total === 1 ? "" : "s"}</span>
      </div>
      {shown.map((g) => {
        const rows = byStage[g.key];
        const cap = g.key === "merged" || g.key === "ended" ? 25 : 200;
        return (
          <details class="group rows" open={rows.length > 0 && (stage !== "all" || g.key !== "ended")}>
            <summary><span class="chev"><Icon name="chev" size={14} /></span><span class={`si ${g.tone}${g.icon === "spin" ? " live" : ""}`}><Icon name={g.icon} size={13} /></span>{g.label}<span class="n">{rows.length}</span></summary>
            {rows.length === 0 ? <Empty title={g.key === "needs_you" ? "You're all caught up" : "Nothing here"}>{g.key === "needs_you" ? "Nothing needs a person right now." : null}</Empty> : rows.slice(0, cap).map((r) => <RunRow t={r.f.task} f={r.f} now={now} note={r.note} />)}
            {rows.length > cap ? <div class="row muted" style="font-size:12.5px"><a class="link" href="/runs">See all {rows.length} in Runs</a></div> : null}
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
      <PageHeader title="Runs" sub={`${tasks.length} of ${all.length} runs · ${usd(tasks.reduce((s, t) => s + t.usage.costUsd, 0))} model spend`} />
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
  return <div class="rows">{tasks.map((t) => <RunRow t={t} f={facts.get(t.id)} now={now} />)}</div>;
}

// ───────────────────────────── run detail ─────────────────────────────

export function TaskPage({ t, events, facts, now }: { t: TaskRecord; events: LedgerEvent[]; facts: TaskFacts; now: string }) {
  const scores = [...latestScores(t.scores).values()];
  const end = isOpen(t.status) ? now : t.updatedAt;
  return (
    <>
      <PageHeader
        crumb={<><a href="/runs">Runs</a> / <span class="mono">{t.id}</span></>}
        title={t.title}
        sub={<span style="display:inline-flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px"><Status s={t.status} /><span>{t.harness.name} · {t.harness.model}</span><span class="mono">{t.factoryVersion}</span><span>started {when(t.createdAt)}</span></span>}
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

      <div class="grid g4">
        <Stat title="Model cost" value={usd(t.usage.costUsd)} meta={`${t.usage.inputTokens.toLocaleString()} in · ${t.usage.outputTokens.toLocaleString()} out tokens`} />
        <Stat title={isOpen(t.status) ? "Running for" : "Ask → done"} value={dur((Date.parse(end) - Date.parse(t.createdAt)) / 1000)} meta={`${facts.turns.length} agent turns · ${t.people.reviewRounds} review rounds`} />
        <Stat title="PR size" value={facts.prSize ? `+${facts.prSize.additions} −${facts.prSize.deletions}` : "–"} meta={facts.prSize ? `${facts.prSize.changedFiles} files${facts.ciOnHead ? ` · CI ${facts.ciOnHead === "success" ? "green" : "red"} on head` : ""}` : "No PR yet"} />
        <Stat title="Human commits" value={facts.humanPushes} meta={facts.humanPushes === 0 ? "Fully agent-written" : "Pushed by people between turns"} />
      </div>

      <div class="grid detail" style="margin-top:16px;align-items:start">
        <div class="stack" style="min-width:0">
          <Card>
            <h3>Ask</h3>
            <div class="t2" style="margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px">{t.ask}</div>
          </Card>
          <div>
            <div class="section-title" style="margin-top:4px">Agent turns</div>
            {facts.turns.length === 0 ? <Card><Empty title="No turns yet" /></Card> : facts.turns.map((r) => {
              const tr = facts.transcripts.find((x) => x.turn === r.n);
              return (
                <div class="turn">
                  <div class="top">
                    <b>Turn {r.n}</b>
                    <span class="chip">{r.reason}</span>
                    <span class="muted">{when(r.startedAt)}</span>
                    <span class="num">{r.durationS === null ? <Badge tone="info" live>running</Badge> : dur(r.durationS)}</span>
                    <span class="muted num">{r.usage ? `${r.usage.inputTokens.toLocaleString()} in · ${r.usage.outputTokens.toLocaleString()} out` : ""}</span>
                    <b class="num">{usd(r.usage?.costUsd ?? null)}</b>
                    {r.stopReason ? <span class="muted">{r.stopReason}</span> : null}
                    <span style="margin-left:auto">{tr ? <a class="btn" href={`/tasks/${t.id}/transcripts/${encodeURIComponent(tr.key)}`}>View session</a> : null}</span>
                  </div>
                  {r.summary ? <div class="sum">{r.summary.slice(0, 600)}</div> : null}
                </div>
              );
            })}
          </div>
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
              <dt>Environment</dt><dd>{t.environment ? <><span class="mono">{t.environment.name}</span> <span class="muted">({t.environment.plugin})</span></> : "–"}</dd>
              <dt>Workspace</dt><dd>{t.workspace ? <><span class="mono">{t.workspace.id.slice(0, 24)}</span> <span class="muted">({t.workspace.plugin})</span></> : "–"}</dd>
              <dt>People</dt><dd>{t.people.comments} comments · {t.people.reviewRounds} review rounds</dd>
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
        title={`Session${turn !== null ? ` · turn ${turn}` : ""}`}
        sub={`${lines.length} entries · ${tools.length} tool calls, ${tools.filter((l) => l.status === "failed").length} failed. The factory's own copy of what the agent did.`}
      />
      <Card>
        {lines.map((l) => {
          switch (l.kind) {
            case "prompt":
              return <div class="msg"><span class="av user">You</span><details><summary><b>Prompt</b> <span class="muted">{when(l.at)} · click to expand</span></summary><pre class="block" style="margin-top:8px">{text(l.text)}</pre></details></div>;
            case "message":
              return <div class="msg"><span class="av agent">AI</span><div><div class="muted" style="font-size:12px">{when(l.at)}</div><div style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:13.5px">{text(l.text)}</div></div></div>;
            case "tool_call":
              return <div class={`tool${l.status === "failed" ? " bad" : ""}`}><span>{l.status === "failed" ? "✗" : "›"}</span><span>{text(l.title)}</span><span class="muted" style="margin-left:auto">{text(l.status)}</span></div>;
            case "plan":
              return <div class="msg"><span class="av agent">AI</span><div><b>Plan</b><ol style="margin:6px 0 0;padding-left:20px" class="t2">{(Array.isArray(l.entries) ? l.entries : []).map((e) => <li>{text(e)}</li>)}</ol></div></div>;
            case "result":
              return <div style="margin:12px 0 0 40px"><Badge tone="good">Turn ended · {text(l.stopReason)}</Badge></div>;
            case "error":
              return <div class="alert bad" style="margin:10px 0 0 40px">{text(l.message)}</div>;
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
      <PageHeader title="Agents" sub="Who does the work in this factory. Any ACP harness can be the worker." />
      <div class="tiles">
        {(Object.keys(ROLES) as Role[]).map((k) => (
          <a class="tile" href={`/agents/${k}`}>
            <span class={`ic ${ROLES[k].tone}`}><Icon name={ROLES[k].icon} size={22} /></span>
            <h4>{ROLES[k].title}</h4>
            <p>{ROLES[k].desc}</p>
            <div class="ft">{k === "implementation" ? <><span class="chip">{f.agent.name}</span><span class="chip mono">{f.agent.model}</span></> : <span class="chip mono">{f.foreman.model}</span>}</div>
          </a>
        ))}
        <div class="tile ghost">
          <span class="ic neutral"><Icon name="plus" size={22} /></span>
          <h4>Bring your own agent</h4>
          <p>Claude Code, Codex, Copilot CLI, Gemini CLI or any harness that speaks the Agent Client Protocol. Set <span class="mono">providers.agent</span> in factory.yaml.</p>
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
      <PageHeader crumb={<><a href="/agents">Agents</a> / {r.title}</>} title={<span style="display:inline-flex;gap:12px;align-items:center"><span class={`ic ${r.tone}`} style="width:32px;height:32px;border-radius:8px;display:grid;place-items:center"><Icon name={r.icon} size={18} /></span>{r.title}</span>} />
      <div class="card" style="padding:4px 24px">
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
      <div class="grid g3" style="margin-top:16px">
        <Stat title="Repo token" value="Per run" meta="Scoped to one repo, refreshed before every turn" />
        <Stat title="Model key" value="Per run" meta="Its own budget; the org key never enters a sandbox" />
        <Stat title="Network" value="Allowlist" meta="Denied hosts show on the run's page" />
      </div>
    </>
  );
}

export function ScorersPage({ scorers }: { scorers: ScorerSummary[] }) {
  return (
    <>
      <PageHeader title="Scorers" sub="Every run is scored when it changes state, and again when late outcomes arrive." />
      <div class="rows">
        {scorers.map((s) => (
          <div class="row" style="min-height:68px;padding:12px 20px">
            <span class={`ic ${s.kind === "pass_fail" ? "good" : s.kind === "usd" ? "warn" : "info"}`} style="width:32px;height:32px;border-radius:8px;display:grid;place-items:center;flex:none"><Icon name={s.kind === "pass_fail" ? "check" : s.kind === "usd" ? "dash" : s.kind === "seconds" ? "clock" : "scorer"} size={16} /></span>
            <div class="ttl"><b>{s.title}</b><span class="s2" style="white-space:normal">{s.measures}</span></div>
            <span class="chip mono">{s.name}</span>
            <span class="muted num" style="flex:none;width:70px;text-align:right;font-size:12.5px">{s.n} run{s.n === 1 ? "" : "s"}</span>
            <div class="val"><b class="num">{formatScorer(s)}</b><div class="muted" style="font-size:11.5px">{s.kind === "pass_fail" ? "pass rate" : "median"}</div></div>
          </div>
        ))}
      </div>
      <p class="note">Custom scorers are plugins implementing the Scorer contract; they appear here once they have scored a run.</p>
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
      <thead><tr><th style="padding-left:0">Task</th><th class="r">A · {a.label}</th><th class="r" style="padding-right:0">B · {b.label}</th></tr></thead>
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
          <div class="meta">{when(run.createdAt)} · {done}/{planned} attempts · {usd(run.spentUsd)} of {usd(run.maxCostUsd)}{run.stoppedForBudget ? " · stopped at budget" : ""}</div>
        </div>
        <div class="legend"><span><i style="background:var(--series-1)" />A: {a.model} @ <span class="mono">{a.factoryVersion}</span></span><span><i style="background:var(--series-2)" />B: {b.model} @ <span class="mono">{b.factoryVersion}</span></span></div>
      </div>
      {rep !== null ? (
        <>
          <div class={`alert ${rep.verdict === "too_close" ? "warn" : ""}`} style={`margin:14px 0;${rep.verdict === "too_close" ? "" : "background:var(--good-soft);border-color:transparent"}`}><b>{rep.summary}</b></div>
          <div class="grid g2">
            <table class="tbl">
              <thead><tr><th style="padding-left:0">Arm</th><th class="r">Pass</th><th class="r">Mean cost</th><th class="r" style="padding-right:0">Mean time</th></tr></thead>
              <tbody>{[rep.a, rep.b].map((s) => <tr><td style="padding-left:0">{s.arm}</td><td class="r num">{s.passes}/{s.attempts} · {pct(s.passRate)}</td><td class="r num">{usd(s.meanCostUsd)}</td><td class="r num" style="padding-right:0">{dur(s.meanDurationS)}</td></tr>)}</tbody>
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
            <tbody>{run.results.map((r) => <tr><td>{r.arm}</td><td class="mono">{r.benchmarkTaskId}</td><td>{r.attempt}</td><td><Badge tone={r.passed ? "good" : "bad"}>{r.passed ? "pass" : "fail"}</Badge>{r.checks ? <div class="muted" style="font-size:12px;margin-top:3px">repo {r.checks.repo ? "✓" : "✗"} · world {r.checks.world === null ? "–" : r.checks.world ? "✓" : "✗"}</div> : null}</td><td class="r num">{usd(r.usage.costUsd)}</td><td class="wrapcell"><pre class="block" style="max-height:160px">{r.notes.slice(-600)}</pre></td></tr>)}</tbody>
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
