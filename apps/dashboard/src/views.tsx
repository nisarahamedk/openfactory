import type { Child } from "hono/jsx";
import type { BenchmarkTask, LedgerEvent, TaskRecord, TaskStatus } from "@openfactory/contracts";
import type { BenchRun } from "@openfactory/bench";
import { formatDuration, latestScores } from "@openfactory/scoring";
import { OpenedMergedChart, PassCostChart, StageBar } from "./charts.js";
import { isOpen, type InboxItem, type Insights, type RunFilter, type ScorerSummary, type TaskFacts } from "./insights.js";
import type { FactoryInfo } from "@openfactory/client";
import { byFactoryVersion } from "./stats.js";

const CSS = `
:root{--bg:#fafaf9;--panel:#fff;--text:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#2563eb;--good:#15803d;--bad:#b91c1c;--warn:#a16207;--chip:#f5f5f4;--s1:#2563eb;--s2:#16a34a;--s3:#d97706;--s4:#9333ea}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--panel:#1c1917;--text:#f5f5f4;--muted:#a8a29e;--line:#292524;--accent:#60a5fa;--good:#4ade80;--bad:#f87171;--warn:#facc15;--chip:#292524;--s1:#60a5fa;--s2:#4ade80;--s3:#fbbf24;--s4:#c084fc}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}
header{display:flex;gap:18px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
header b{font-size:15px;margin-right:6px}header a{color:var(--muted);text-decoration:none}header a.on{color:var(--text);font-weight:600}
header .badge{display:inline-block;min-width:18px;padding:0 6px;margin-left:4px;border-radius:99px;background:var(--bad);color:#fff;font-size:11px;text-align:center}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 16px}h2{font-size:15px;margin:24px 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.tile .v{font-size:22px;font-weight:600}.tile .k{color:var(--muted);font-size:12px}.tile .n{color:var(--muted);font-size:11px}
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}tr:last-child td{border-bottom:0}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
a{color:var(--accent)}.muted{color:var(--muted)}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--chip);font-size:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px}
button,input,select{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--text)}
button{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}
.flash{padding:10px 12px;border-radius:8px;margin-bottom:12px;border:1px solid var(--line);background:var(--panel)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--chip);padding:8px;border-radius:6px;max-height:240px;overflow:auto;margin:4px 0}
.note{color:var(--muted);font-size:12px;margin-top:6px}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}.filters input[type=search]{min-width:200px}
.inbox .item{display:flex;gap:12px;align-items:flex-start}.inbox .kind{min-width:110px}
.chart{width:100%;height:auto;display:block}.chart .grid{stroke:var(--line)}.chart .axis{fill:var(--muted);font-size:11px}
.chart .s1{fill:var(--s1)}.chart .s2{fill:var(--s2)}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-top:4px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.stagebar{display:flex;height:12px;border-radius:6px;overflow:hidden;margin:8px 0 4px;background:var(--chip)}.stagebar div{min-width:2px}
.b1{background:var(--s1)}.b2{background:var(--s3)}.b3{background:var(--s2)}
details summary{cursor:pointer}
.tabs{display:flex;gap:6px;margin:0 0 10px}.tabs a{padding:3px 10px;border-radius:99px;text-decoration:none;color:var(--muted);border:1px solid var(--line)}.tabs a.on{color:var(--text);border-color:var(--text)}
`;

export type Nav = "home" | "runs" | "metrics" | "bench" | "scorers" | "versions" | "factory";

export function Layout(props: { title: string; nav: Nav; flash: string | null; inboxCount?: number; refreshSec?: number; children: Child }) {
  const link = (nav: Nav, href: string, label: string, extra?: Child) => (
    <a href={href} class={props.nav === nav ? "on" : ""}>{label}{extra}</a>
  );
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {props.refreshSec ? <meta http-equiv="refresh" content={String(props.refreshSec)} /> : null}
        <title>{`${props.title} · Factory`}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header>
          <b>SlopwareFactory</b>
          {link("home", "/", "Home", props.inboxCount ? <span class="badge">{props.inboxCount}</span> : null)}
          {link("runs", "/runs", "Runs")}
          {link("metrics", "/metrics", "Dashboard")}
          {link("bench", "/bench", "Benchmarks")}
          {link("scorers", "/scorers", "Scorers")}
          {link("versions", "/versions", "Versions")}
          {link("factory", "/factory", "Factory")}
        </header>
        <main>
          {props.flash !== null ? <div class="flash">{props.flash}</div> : null}
          {props.children}
        </main>
      </body>
    </html>
  );
}

const usd = (n: number | null) => (n === null ? "–" : `$${n.toFixed(2)}`);
const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);
const num = (n: number | null, d = 1) => (n === null ? "–" : n.toFixed(d));
const dur = (s: number | null) => (s === null ? "–" : formatDuration(s));
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

function ago(iso: string, now: string): string {
  const s = Math.max(0, (Date.parse(now) - Date.parse(iso)) / 1000);
  return s >= 2 * 86_400 ? `${Math.floor(s / 86_400)} days ago` : `${formatDuration(s)} ago`;
}

function statusClass(s: string): string {
  if (s === "merged") return "good";
  if (s === "failed" || s === "closed") return "bad";
  if (s === "awaiting_review") return "warn";
  return "";
}

const Status = ({ s }: { s: TaskStatus }) => <span class={`chip ${statusClass(s)}`}>{s.replace("_", " ")}</span>;

function Tile({ v, k, n }: { v: Child; k: string; n?: string }) {
  return (
    <div class="tile">
      <div class="v">{v}</div>
      <div class="k">{k}</div>
      {n ? <div class="n">{n}</div> : null}
    </div>
  );
}

// ───────────────────────────── home: waiting on you ─────────────────────────────

const INBOX_LABEL: Record<InboxItem["kind"], { label: string; cls: string }> = {
  blocked: { label: "Blocked", cls: "bad" },
  ci_failing: { label: "CI failing", cls: "bad" },
  pr_review: { label: "PR review", cls: "warn" },
  failed: { label: "Failed", cls: "bad" },
};

export function HomePage({ items, live, now, i }: { items: InboxItem[]; live: TaskFacts[]; now: string; i: Insights }) {
  return (
    <>
      <h1>Waiting on you</h1>
      {items.length === 0 ? (
        <div class="card muted">Nothing needs you right now.</div>
      ) : (
        <div class="wrap inbox">
          <table>
            <tr><th>Why</th><th>Task</th><th>Detail</th><th>Since</th><th></th></tr>
            {items.map((it) => {
              const t = it.facts.task;
              return (
                <tr>
                  <td><span class={`chip ${INBOX_LABEL[it.kind].cls}`}>{INBOX_LABEL[it.kind].label}</span></td>
                  <td><a href={`/tasks/${t.id}`}>{t.title.slice(0, 70)}</a><div class="muted">{t.source.repo.owner}/{t.source.repo.name}</div></td>
                  <td style="white-space:normal;max-width:420px">{it.detail.slice(0, 300)}</td>
                  <td class="muted">{ago(it.since, now)}</td>
                  <td>{t.pr ? <a href={t.pr.url}>Open PR</a> : t.source.url ? <a href={t.source.url}>Open issue</a> : null}</td>
                </tr>
              );
            })}
          </table>
        </div>
      )}
      <p class="note">Items leave this list when the task moves on: a review is given, CI goes green, or the task is retried or closed.</p>

      <h2>Running now ({live.length})</h2>
      {live.length === 0 ? <p class="muted">No agent is working right now.</p> : <RunsTable tasks={live.map((f) => f.task)} facts={new Map(live.map((f) => [f.task.id, f]))} now={now} />}

      <h2>Last {i.days} days</h2>
      <div class="tiles">
        <Tile v={i.started} k="tasks started" n={`${i.open} still open`} />
        <Tile v={i.merged} k="PRs merged" />
        <Tile v={pct(i.autonomy.rate)} k="autonomy" n={`${i.autonomy.noHumanCommits} of ${i.autonomy.merged} merged PRs had no human commit`} />
        <Tile v={usd(i.cost.medianPerPr.value)} k="median cost per PR" />
        <Tile v={dur(i.cycle.kickoffToMerge.value)} k="median ask → merge" />
      </div>
      <p class="note"><a href="/metrics">Full dashboard</a></p>
    </>
  );
}

// ───────────────────────────── runs ─────────────────────────────

export function RunsPage({ tasks, all, filter, facts, now, live }: { tasks: TaskRecord[]; all: TaskRecord[]; filter: RunFilter; facts: Map<string, TaskFacts>; now: string; live: boolean }) {
  const opts = (xs: string[]) => [...new Set(xs)].sort();
  const repos = opts(all.map((t) => `${t.source.repo.owner}/${t.source.repo.name}`));
  const versions = opts(all.map((t) => t.factoryVersion));
  const models = opts(all.map((t) => t.harness.model));
  const tab = (status: string, label: string) => {
    const q = new URLSearchParams({ ...filterParams(filter), status });
    return <a href={`/runs?${q}`} class={filter.status === status ? "on" : ""}>{label}</a>;
  };
  return (
    <>
      <h1>Runs</h1>
      <div class="tabs">{tab("all", "All")}{tab("open", "Open")}{tab("awaiting_review", "Awaiting review")}{tab("merged", "Merged")}{tab("failed", "Failed")}{tab("done", "Finished")}</div>
      <form method="get" action="/runs" class="filters">
        <input type="hidden" name="status" value={filter.status} />
        <input type="search" name="q" value={filter.q} placeholder="Search title or id" />
        <Select name="repo" value={filter.repo} all="All repos" options={repos} />
        <Select name="version" value={filter.version} all="All factory versions" options={versions} />
        <Select name="model" value={filter.model} all="All models" options={models} />
        <Select name="source" value={filter.source} all="All sources" options={["github_issue", "api", "benchmark_replay"]} />
        <label class="muted"><input type="checkbox" name="live" value="1" checked={live} /> auto-refresh</label>
        <button type="submit">Filter</button>
      </form>
      <p class="muted">{tasks.length} of {all.length} runs · spend {usd(tasks.reduce((s, t) => s + t.usage.costUsd, 0))}</p>
      <RunsTable tasks={tasks} facts={facts} now={now} />
      {all.length === 0 ? <p class="muted">No tasks yet. Label a GitHub issue <code>factory</code> to start one.</p> : null}
    </>
  );
}

function filterParams(f: RunFilter): Record<string, string> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "" && v !== "all")) as Record<string, string>;
}

function Select({ name, value, all, options }: { name: string; value: string; all: string; options: string[] }) {
  return (
    <select name={name}>
      <option value="">{all}</option>
      {options.map((o) => <option value={o} selected={o === value}>{o}</option>)}
    </select>
  );
}

function RunsTable({ tasks, facts, now }: { tasks: TaskRecord[]; facts: Map<string, TaskFacts>; now: string }) {
  return (
    <div class="wrap">
      <table>
        <tr><th>Run</th><th>Status</th><th>Source</th><th>Environment</th><th>Artifacts</th><th class="num">Turns</th><th class="num">Cost</th><th>Duration</th><th>Factory / model</th><th>Started</th></tr>
        {tasks.map((t) => {
          const f = facts.get(t.id);
          const end = isOpen(t.status) ? now : t.updatedAt;
          return (
            <tr>
              <td><a href={`/tasks/${t.id}`}>{t.title.slice(0, 60)}</a><div class="muted">{t.id}</div></td>
              <td><Status s={t.status} />{f?.lastError && isOpen(t.status) ? <div class="bad" title={f.lastError}>error</div> : null}</td>
              <td>{t.source.url ? <a href={t.source.url}>{t.source.repo.name}{t.source.issueNumber !== null ? `#${t.source.issueNumber}` : ""}</a> : `${t.source.repo.owner}/${t.source.repo.name}`}<div class="muted">{t.source.kind.replace("_", " ")}</div></td>
              <td>{t.environment?.name ?? <span class="muted">–</span>}</td>
              <td>
                {t.pr ? <a href={t.pr.url}>PR #{t.pr.number}</a> : <span class="muted">no PR</span>}
                {t.evidence.length > 0 ? <div class="muted">{t.evidence.length} evidence</div> : null}
              </td>
              <td class="num">{f ? f.turns.length : "–"}</td>
              <td class="num">{usd(t.usage.costUsd)}</td>
              <td>{dur((Date.parse(end) - Date.parse(t.createdAt)) / 1000)}</td>
              <td><code>{t.factoryVersion}</code><div class="muted">{t.harness.model}</div></td>
              <td class="muted">{when(t.createdAt)}</td>
            </tr>
          );
        })}
      </table>
    </div>
  );
}

// ───────────────────────────── metrics dashboard ─────────────────────────────

export function MetricsPage({ i }: { i: Insights }) {
  const c = i.cycle;
  const windows = [7, 30, 90];
  return (
    <>
      <h1>Dashboard</h1>
      <div class="tabs">{windows.map((d) => <a href={`/metrics?days=${d}`} class={i.days === d ? "on" : ""}>{d} days</a>)}</div>

      <h2>Autonomy</h2>
      <div class="tiles">
        <Tile v={pct(i.autonomy.rate)} k="autonomy: merged with no human commit" n={`${i.autonomy.noHumanCommits} of ${i.autonomy.merged} merged PRs`} />
        <Tile v={pct(i.autonomy.firstTryRate)} k="merged as first proposed" n={`${i.autonomy.mergedFirstTry} of ${i.autonomy.merged} had no review round`} />
        <Tile v={i.merged} k="PRs merged" n={`${i.started} tasks started, ${i.open} open`} />
        <Tile v={i.failed + i.closed} k="ended without a merge" n={`${i.failed} failed, ${i.closed} closed`} />
        <Tile v={scorerValue(i.scorers, "facts.ci_first_pass")} k="CI green on first push" />
      </div>
      <p class="note">A human commit is a new PR head that appeared while no agent turn was running. Review comments the agent then fixed still count as autonomous; "first proposed" is the stricter bar.</p>

      <h2>PR cycle time (medians)</h2>
      <div class="tiles">
        <Tile v={dur(c.kickoffToPr.value)} k="kickoff → PR opened" n={`${c.kickoffToPr.n} PRs`} />
        <Tile v={dur(c.prToFirstReview.value)} k="PR → first human review" n={`${c.prToFirstReview.n} PRs`} />
        <Tile v={dur(c.firstReviewToMerge.value)} k="first review → merge" n={`${c.firstReviewToMerge.n} PRs`} />
        <Tile v={dur(c.kickoffToMerge.value)} k="kickoff → merge" n={`${c.kickoffToMerge.n} PRs`} />
      </div>
      <div class="card">
        <StageBar parts={[{ label: `agent: ${dur(c.kickoffToPr.value)}`, seconds: c.kickoffToPr.value, cls: "b1" }, { label: `waiting for review: ${dur(c.prToFirstReview.value)}`, seconds: c.prToFirstReview.value, cls: "b2" }, { label: `review to merge: ${dur(c.firstReviewToMerge.value)}`, seconds: c.firstReviewToMerge.value, cls: "b3" }]} />
        <div class="legend"><span><i class="b1" />agent working</span><span><i class="b2" />waiting for a person</span><span><i class="b3" />review to merge</span></div>
      </div>

      <h2>Cost</h2>
      <div class="tiles">
        <Tile v={usd(i.cost.medianPerPr.value)} k="median cost per PR" n={`${i.cost.medianPerPr.n} PRs`} />
        <Tile v={usd(i.cost.perMerged)} k="total spend ÷ merged PRs" n="what a merged change really costs, failures included" />
        <Tile v={usd(i.cost.total)} k="model spend" n="inference only; sandbox compute is not metered yet" />
      </div>
      <h2>Cost per PR by size</h2>
      <div class="wrap"><table>
        <tr><th>Size (lines changed)</th><th class="num">PRs</th><th class="num">Merged</th><th class="num">Median cost</th><th class="num">Median review rounds</th></tr>
        {i.cost.bySize.map((b, k) => (
          <tr>
            <td><b>{b.size}</b> <span class="muted">{k === 0 ? `< ${b.under}` : b.under === null ? `≥ ${i.cost.bySize[k - 1]!.under}` : `${i.cost.bySize[k - 1]!.under}–${b.under - 1}`}</span></td>
            <td class="num">{b.prs}</td>
            <td class="num">{b.merged}</td>
            <td class="num">{usd(b.medianCostUsd)}</td>
            <td class="num">{num(b.medianReviewRounds)}</td>
          </tr>
        ))}
      </table></div>
      <p class="note">Size is additions plus deletions on the PR's latest head. A big change costing more is expected; a small change costing a lot is worth opening.</p>

      {i.cost.mostExpensive.length > 0 ? (
        <>
          <h2>Most expensive PRs</h2>
          <div class="wrap"><table>
            <tr><th>Task</th><th>Status</th><th class="num">Cost</th><th class="num">Size</th><th class="num">Review rounds</th><th class="num">Turns</th><th>PR</th></tr>
            {i.cost.mostExpensive.map((f) => (
              <tr>
                <td><a href={`/tasks/${f.task.id}`}>{f.task.title.slice(0, 60)}</a></td>
                <td><Status s={f.task.status} /></td>
                <td class="num">{usd(f.task.usage.costUsd)}</td>
                <td class="num">{f.prSize ? `+${f.prSize.additions} −${f.prSize.deletions}` : "–"}</td>
                <td class="num">{f.task.people.reviewRounds}</td>
                <td class="num">{f.turns.length}</td>
                <td>{f.task.pr ? <a href={f.task.pr.url}>#{f.task.pr.number}</a> : "–"}</td>
              </tr>
            ))}
          </table></div>
        </>
      ) : null}

      <h2>PRs opened vs merged</h2>
      <div class="card">
        <OpenedMergedChart days={i.daily} />
        <div class="legend"><span><i style="background:var(--s1)" />opened</span><span><i style="background:var(--s2)" />merged</span></div>
      </div>

      <h2>After the merge</h2>
      <div class="tiles">
        <Tile v={i.outcomes.reverted} k="reverted" />
        <Tile v={i.outcomes.incidents} k="linked to an incident" />
        <Tile v={i.outcomes.hotfix} k="needed a hotfix" />
        <Tile v={i.outcomes.rework} k="reworked within weeks" />
      </div>
      <p class="note">Late outcomes come from the metrics source (fake DX here) and keep arriving after a task is done. Tests passing is not the same as the change holding up.</p>

      <h2>Runs by status</h2>
      <div class="wrap"><table>
        {i.byStatus.map((s) => <tr><td><Status s={s.status} /></td><td class="num">{s.n}</td><td><a href={`/runs?status=${s.status}`}>view</a></td></tr>)}
      </table></div>

      <h2>Scorers</h2>
      <ScorerCards scorers={i.scorers.filter((s) => !s.name.startsWith("facts.stage_s."))} />
      <p class="note"><a href="/scorers">All scorers</a></p>
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

function ScorerCards({ scorers }: { scorers: ScorerSummary[] }) {
  return (
    <div class="tiles">
      {scorers.map((s) => <Tile v={formatScorer(s)} k={s.title} n={`${s.kind === "pass_fail" ? "pass rate" : "median"} over ${s.n} task${s.n === 1 ? "" : "s"}`} />)}
    </div>
  );
}

export function ScorersPage({ scorers }: { scorers: ScorerSummary[] }) {
  return (
    <>
      <h1>Scorers</h1>
      <p class="muted">Every task is scored when it changes state and again when late outcomes arrive. Fact scorers read the ledger, so they are free and hard to argue with.</p>
      <div class="wrap"><table>
        <tr><th>Scorer</th><th>Measures</th><th class="num">Tasks scored</th><th class="num">Value</th></tr>
        {scorers.map((s) => (
          <tr>
            <td><b>{s.title}</b><div class="muted"><code>{s.name}</code></div></td>
            <td style="white-space:normal">{s.measures}</td>
            <td class="num">{s.n}</td>
            <td class="num">{formatScorer(s)}<div class="muted">{s.kind === "pass_fail" ? "pass rate" : "median"}</div></td>
          </tr>
        ))}
      </table></div>
      <p class="note">Custom scorers are plugins implementing the Scorer contract; they show up here once they have scored a task.</p>
    </>
  );
}

// ───────────────────────────── versions ─────────────────────────────

export function VersionsPage({ tasks }: { tasks: TaskRecord[] }) {
  const rows = byFactoryVersion(tasks);
  return (
    <>
      <h1>Factory versions</h1>
      <div class="wrap">
        <table>
          <tr><th>Version</th><th class="num">Tasks</th><th class="num">Merged</th><th class="num">Spend</th><th class="num">Cost / merged</th><th class="num">CI first push</th><th class="num">Review rounds</th><th>Median ask → done</th><th>Last used</th></tr>
          {rows.map(({ version, lastSeen, rollup: r }) => (
            <tr>
              <td><code>{version}</code></td>
              <td class="num">{r.tasks}</td>
              <td class="num">{r.merged}</td>
              <td class="num">{usd(r.totalCostUsd)}</td>
              <td class="num">{usd(r.costPerMergedUsd)}</td>
              <td class="num">{pct(r.ciFirstPassRate)}</td>
              <td class="num">{num(r.meanReviewRounds)}</td>
              <td>{dur(r.medianLeadTimeS)}</td>
              <td class="muted">{when(lastSeen)}</td>
            </tr>
          ))}
        </table>
      </div>
      <p class="note">These numbers describe live work; they are not proof one version is better, since tasks differ. Use a benchmark A-vs-B run for that.</p>
    </>
  );
}

// ───────────────────────────── task (run) page ─────────────────────────────

export function TaskPage({ t, events, facts, now }: { t: TaskRecord; events: LedgerEvent[]; facts: TaskFacts; now: string }) {
  const scores = [...latestScores(t.scores).values()];
  const end = isOpen(t.status) ? now : t.updatedAt;
  return (
    <>
      <h1>{t.title}</h1>
      <p>
        <Status s={t.status} />{" "}
        <span class="muted">{t.id} · factory <code>{t.factoryVersion}</code> · {t.harness.name} / {t.harness.model} · started {when(t.createdAt)}</span>
      </p>
      {facts.lastError && isOpen(t.status) ? <div class="card bad">Last error: {facts.lastError}</div> : null}
      {facts.cancelled ? <div class="card warn">Stopped{facts.cancelled.by ? ` by ${facts.cancelled.by}` : ""}{facts.cancelled.reason ? `: ${facts.cancelled.reason}` : "."} A new comment on the issue or PR resumes it.</div> : null}
      <div class="tiles">
        <Tile v={usd(t.usage.costUsd)} k="model cost" n={`${t.usage.inputTokens.toLocaleString()} in / ${t.usage.outputTokens.toLocaleString()} out tokens`} />
        <Tile v={facts.turns.length} k="agent turns" n={`${t.people.reviewRounds} review round${t.people.reviewRounds === 1 ? "" : "s"}`} />
        <Tile v={dur((Date.parse(end) - Date.parse(t.createdAt)) / 1000)} k={isOpen(t.status) ? "running for" : "ask → done"} />
        <Tile v={t.pr ? <a href={t.pr.url}>#{t.pr.number}</a> : "–"} k="pull request" n={facts.ciOnHead ? `CI ${facts.ciOnHead === "success" ? "green" : "red"} on head` : undefined} />
        <Tile v={facts.prSize ? `+${facts.prSize.additions} −${facts.prSize.deletions}` : "–"} k="PR size" n={facts.prSize ? `${facts.prSize.changedFiles} files` : undefined} />
        <Tile v={facts.humanPushes} k="human commits" n={facts.humanPushes === 0 ? "fully agent-written" : "pushed by people between turns"} />
        <Tile v={t.evidence.length} k="evidence items" />
      </div>
      <div class="grid2" style="margin-top:10px">
        <div class="card">
          <b>Work</b>
          <div>Source: {t.source.url !== null ? <a href={t.source.url}>{t.source.repo.owner}/{t.source.repo.name}#{t.source.issueNumber}</a> : `${t.source.repo.owner}/${t.source.repo.name}`}</div>
          <div>Branch: {t.branch ?? "–"}</div>
          <div>Environment: {t.environment ? `${t.environment.name} (${t.environment.plugin})` : "–"}</div>
          <div>Workspace: {t.workspace ? `${t.workspace.id} (${t.workspace.plugin})` : "–"}</div>
          <div>People: {t.people.comments} comments, {t.people.reviewRounds} review rounds</div>
          {isOpen(t.status) ? (
            <form method="post" action={`/tasks/${t.id}/cancel`} style="margin-top:10px" class="filters">
              <input name="reason" placeholder="Reason (optional)" maxlength={1000} />
              <button type="submit" style="background:var(--bad);border-color:var(--bad)">Stop task</button>
            </form>
          ) : null}
          {t.status === "merged" ? (
            <form method="post" action={`/tasks/${t.id}/benchmark`} style="margin-top:10px">
              <button type="submit">Turn into benchmark task</button>
            </form>
          ) : (
            <p class="note">"Turn into benchmark task" is available once the PR is merged.</p>
          )}
        </div>
        <div class="card">
          <b>Scores</b>
          {scores.length === 0 ? <p class="muted">None yet.</p> : (
            <table>
              {scores.map((s) => (
                <tr><td>{s.scorer}</td><td class="num">{s.label ?? s.value}</td><td class="muted" style="white-space:normal">{s.reason}</td></tr>
              ))}
            </table>
          )}
        </div>
      </div>
      <h2>The ask</h2>
      <div class="card"><pre>{t.ask}</pre></div>

      <h2>Agent turns</h2>
      {facts.turns.length === 0 ? <p class="muted">No turns yet.</p> : (
        <div class="wrap"><table>
          <tr><th>#</th><th>Why</th><th>Started</th><th>Took</th><th class="num">Tokens in / out</th><th class="num">Cost</th><th>Stop</th><th>Transcript</th><th>Summary</th></tr>
          {facts.turns.map((r) => (
            <tr>
              <td>{r.n}</td>
              <td>{r.reason}</td>
              <td class="muted">{when(r.startedAt)}</td>
              <td>{r.durationS === null ? <span class="warn">running</span> : dur(r.durationS)}</td>
              <td class="num">{r.usage ? `${r.usage.inputTokens.toLocaleString()} / ${r.usage.outputTokens.toLocaleString()}` : "–"}</td>
              <td class="num">{usd(r.usage?.costUsd ?? null)}</td>
              <td>{r.stopReason ?? "–"}</td>
              <td>{(() => {
                const tr = facts.transcripts.find((x) => x.turn === r.n);
                return tr ? <a href={`/tasks/${t.id}/transcripts/${encodeURIComponent(tr.key)}`}>View session</a> : <span class="muted">–</span>;
              })()}</td>
              <td style="white-space:normal;min-width:260px">{r.summary ? <details><summary>{r.summary.split("\n")[0]?.slice(0, 90)}</summary><pre>{r.summary}</pre></details> : <span class="muted">–</span>}</td>
            </tr>
          ))}
        </table></div>
      )}

      <h2>Evidence</h2>
      {t.evidence.length === 0 ? <p class="muted">None.</p> : (
        <div class="wrap"><table>
          <tr><th>Kind</th><th>Title</th><th>Commit</th><th>Environment</th><th>When</th></tr>
          {t.evidence.map((e) => <tr><td>{e.kind}</td><td><a href={e.url}>{e.title}</a></td><td><code>{e.commitSha.slice(0, 7)}</code></td><td>{e.environment}</td><td class="muted">{when(e.createdAt)}</td></tr>)}
        </table></div>
      )}

      {facts.deniedHosts.length > 0 ? (
        <>
          <h2>Blocked network access</h2>
          <div class="card">The sandbox tried to reach hosts outside its allowlist: {facts.deniedHosts.map((h) => <code style="margin-right:8px">{h}</code>)}</div>
        </>
      ) : null}

      <h2>After the merge</h2>
      {t.outcomes.length === 0 ? <p class="muted">Nothing reported (reverts, incidents and rework show up here).</p> : (
        <div class="wrap"><table>
          <tr><th>Outcome</th><th>Detail</th><th>Source</th><th>Happened</th><th>Learned</th></tr>
          {t.outcomes.map((o) => <tr><td class={o.kind === "merged" ? "good" : "bad"}>{o.kind}</td><td>{o.detail}</td><td>{o.source}</td><td class="muted">{when(o.at)}</td><td class="muted">{when(o.arrivedAt)}</td></tr>)}
        </table></div>
      )}

      <h2>Timeline</h2>
      <div class="wrap"><table>
        <tr><th>When</th><th>Event</th><th>Detail</th></tr>
        {events.map((e) => <tr><td class="muted">{when(e.at)}</td><td>{e.type.replaceAll("_", " ")}</td><td class={e.type === "error" || (e.type === "egress" && e.data.allowed === false) ? "bad" : "muted"} style="white-space:normal">{describe(e)}</td></tr>)}
      </table></div>
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
    case "workspace_attached": return `${s("id")} (${s("plugin")})`;
    case "branch_set": return s("branch");
    case "error": return `${s("stage")}: ${s("message").slice(0, 300)}`;
    case "pr_stats": return `+${s("additions")} −${s("deletions")} in ${s("changedFiles")} files`;
    case "transcript_saved": return `turn ${s("turn")}, ${s("lines")} lines`;
    case "cancelled": return `by ${s("by") || "someone"}${s("reason") ? `: ${s("reason")}` : ""}`;
    case "egress": return `${d.allowed === false ? "denied" : "allowed"} ${s("host")} ×${s("count")}`;
    case "signal_received": return `${s("type")} from ${s("actor")}`;
    case "evidence_added": return typeof d.evidence === "object" && d.evidence !== null && "title" in d.evidence ? String(d.evidence.title) : "";
    case "outcome_added": return typeof d.outcome === "object" && d.outcome !== null && "kind" in d.outcome ? String(d.outcome.kind) : "";
    case "score_added": return typeof d.score === "object" && d.score !== null && "scorer" in d.score ? `${String(d.score.scorer)} = ${String((d.score as { label?: unknown }).label ?? (d.score as { value?: unknown }).value)}` : "";
    default: return "";
  }
}

// ───────────────────────────── benchmarks ─────────────────────────────

export function BenchPage({ tasks, runs, versions, models }: { tasks: BenchmarkTask[]; runs: BenchRun[]; versions: string[]; models: [string, string] }) {
  const points = runs.flatMap((r) =>
    r.report === null
      ? []
      : [
          { label: `${r.arms[0].label}`, run: r.id, passRate: r.report.a.passRate, costUsd: r.report.a.meanCostUsd, series: 1 as const },
          { label: `${r.arms[1].label}`, run: r.id, passRate: r.report.b.passRate, costUsd: r.report.b.meanCostUsd, series: 2 as const },
        ],
  );
  return (
    <>
      <h1>Benchmarks</h1>
      <p class="muted">Past tasks, replayed under two factory versions. A run says how much B beats A, with a range, and says so when the difference is too small to trust.</p>
      {points.length > 0 ? (
        <>
          <h2>Correctness vs cost</h2>
          <div class="card">
            <PassCostChart points={points} />
            <div class="legend"><span><i style="background:var(--s1)" />arm A</span><span><i style="background:var(--s2)" />arm B</span><span>Up and to the left is better.</span></div>
          </div>
        </>
      ) : null}
      <h2>Suite ({tasks.length})</h2>
      {tasks.length === 0 ? <p class="muted">Empty. Open a merged task and press "Turn into benchmark task".</p> : (
        <div class="wrap"><table>
          <tr><th>Benchmark task</th><th>From task</th><th>Repo</th><th>Start commit</th><th>Check</th><th>Added</th></tr>
          {tasks.map((b) => (
            <tr>
              <td>{b.id}<div class="muted">{b.ask.split("\n")[0]?.slice(0, 60)}</div></td>
              <td><a href={`/tasks/${b.sourceTaskId}`}>{b.sourceTaskId}</a></td>
              <td>{b.repo.owner}/{b.repo.name}</td>
              <td><code>{b.startCommit.slice(0, 7)}</code></td>
              <td>{b.check.kind === "tests_from_merged_pr" ? `${Object.keys(b.check.files).length} hidden test file(s)` : "command"}</td>
              <td class="muted">{when(b.createdAt)}</td>
            </tr>
          ))}
        </table></div>
      )}
      {tasks.length > 0 ? (
        <>
          <h2>Start an A-vs-B run</h2>
          <form method="post" action="/bench/runs" class="card">
            <div style="margin-bottom:8px">
              {tasks.map((b) => <label style="margin-right:12px"><input type="checkbox" name="taskIds" value={b.id} checked /> {b.id}</label>)}
            </div>
            <div class="grid2">
              <ArmFields arm="A" model={models[0]} versions={versions} />
              <ArmFields arm="B" model={models[1]} versions={versions} />
            </div>
            <div style="margin-top:8px">
              Repeats per arm <input name="repeats" type="number" min="1" max="20" value="2" style="width:70px" />{" "}
              Budget $ <input name="maxCostUsd" type="number" min="0.5" step="0.5" value="5" style="width:80px" />{" "}
              <button type="submit">Run</button>
            </div>
            <p class="note">Each attempt is a fresh workspace and a fresh agent session. Spending stops at the budget.</p>
          </form>
        </>
      ) : null}
      <h2>Runs</h2>
      {runs.length === 0 ? <p class="muted">No runs yet.</p> : runs.map((r) => <RunCard run={r} />)}
    </>
  );
}

function ArmFields({ arm, model, versions }: { arm: "A" | "B"; model: string; versions: string[] }) {
  return (
    <div>
      <b>Arm {arm}</b>
      <div>Model <input name={`model${arm}`} value={model} /></div>
      <div>Factory version <input name={`version${arm}`} value={versions[0] ?? "fv_current"} list="versions" /></div>
      <datalist id="versions">{versions.map((v) => <option value={v} />)}</datalist>
      <div>Extra system prompt <input name={`prompt${arm}`} value="" placeholder="optional" /></div>
    </div>
  );
}

/** Per benchmark task: passes / attempts for each arm. */
function TaskGrid({ run }: { run: BenchRun }) {
  const [a, b] = run.arms;
  const cell = (taskId: string, arm: string) => {
    const rs = run.results.filter((r) => r.benchmarkTaskId === taskId && r.arm === arm);
    if (rs.length === 0) return <span class="muted">–</span>;
    const p = rs.filter((r) => r.passed).length;
    return <span class={p === rs.length ? "good" : p === 0 ? "bad" : "warn"}>{p}/{rs.length}</span>;
  };
  return (
    <table>
      <tr><th>Task</th><th class="num">A ({a.label})</th><th class="num">B ({b.label})</th></tr>
      {run.taskIds.map((id) => <tr><td>{id}</td><td class="num">{cell(id, a.label)}</td><td class="num">{cell(id, b.label)}</td></tr>)}
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
      <div>
        <b>{run.id}</b> <span class={`chip ${run.status === "done" ? "good" : run.status === "failed" ? "bad" : "warn"}`}>{run.status}</span>{" "}
        <span class="muted">{when(run.createdAt)} · {done}/{planned} attempts · spent {usd(run.spentUsd)} of {usd(run.maxCostUsd)}{run.stoppedForBudget ? " (stopped at budget)" : ""}</span>
      </div>
      <div class="muted">A = {a.label}: {a.model} @ {a.factoryVersion} · B = {b.label}: {b.model} @ {b.factoryVersion}</div>
      {rep !== null ? (
        <>
          <p>
            <b class={rep.verdict === "too_close" ? "warn" : "good"}>{rep.summary}</b>
          </p>
          <div class="grid2">
            <table>
              <tr><th>Arm</th><th class="num">Pass</th><th class="num">Pass rate</th><th class="num">Mean cost</th><th class="num">Mean time</th></tr>
              {[rep.a, rep.b].map((s) => <tr><td>{s.arm}</td><td class="num">{s.passes}/{s.attempts}</td><td class="num">{pct(s.passRate)}</td><td class="num">{usd(s.meanCostUsd)}</td><td class="num">{dur(s.meanDurationS)}</td></tr>)}
            </table>
            <TaskGrid run={run} />
          </div>
        </>
      ) : done > 0 ? <TaskGrid run={run} /> : null}
      {run.error !== null ? <p class="bad">{run.error}</p> : null}
      {done > 0 ? (
        <details><summary class="muted">Attempts</summary>
          <table>
            <tr><th>Arm</th><th>Task</th><th>#</th><th>Result</th><th class="num">Cost</th><th>Notes</th></tr>
            {run.results.map((r) => <tr><td>{r.arm}</td><td>{r.benchmarkTaskId}</td><td>{r.attempt}</td><td class={r.passed ? "good" : "bad"}>{r.passed ? "pass" : "fail"}</td><td class="num">{usd(r.usage.costUsd)}</td><td style="white-space:normal"><pre>{r.notes.slice(-600)}</pre></td></tr>)}
          </table>
        </details>
      ) : null}
    </div>
  );
}

export function ErrorPage({ message }: { message: string }) {
  return (
    <>
      <h1>Can't load this page</h1>
      <div class="card bad">{message}</div>
    </>
  );
}

// ───────────────────────────── transcript ─────────────────────────────

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
      <p><a href={`/tasks/${t.id}`}>← {t.title}</a></p>
      <h1>Session{turn !== null ? `, turn ${turn}` : ""}</h1>
      <p class="muted">{lines.length} entries · {tools.length} tool calls ({tools.filter((l) => l.status === "failed").length} failed). The factory's own copy of what the agent did, independent of the harness.</p>
      {lines.map((l) => {
        switch (l.kind) {
          case "prompt":
            return <details class="card"><summary><b>Prompt</b> <span class="muted">{when(l.at)}</span></summary><pre>{text(l.text)}</pre></details>;
          case "message":
            return <div class="card"><div class="muted" style="font-size:12px">agent · {when(l.at)}</div><pre style="background:none;padding:0;max-height:none">{text(l.text)}</pre></div>;
          case "tool_call":
            return <div style="padding:2px 14px" class={l.status === "failed" ? "bad" : "muted"}>⚙ {text(l.title)} <span class="chip">{text(l.status)}</span></div>;
          case "plan":
            return <div class="card"><b>Plan</b><ol>{(Array.isArray(l.entries) ? l.entries : []).map((e) => <li>{text(e)}</li>)}</ol></div>;
          case "result":
            return <div class="card good">Turn ended: {text(l.stopReason)}</div>;
          case "error":
            return <div class="card bad">{text(l.message)}</div>;
          default:
            return <pre>{JSON.stringify(l)}</pre>;
        }
      })}
    </>
  );
}

// ───────────────────────────── factory definition ─────────────────────────────

export function FactoryPage({ f }: { f: FactoryInfo }) {
  return (
    <>
      <h1>Factory</h1>
      <p class="muted">Version <code>{f.version}</code> · configured from <code>{f.providersFrom}</code></p>
      <div class="tiles">
        <Tile v={f.agent.name} k="agent harness" n={f.agent.model} />
        <Tile v={f.foreman.model} k="foreman model" />
        <Tile v={<code>{f.rules.label}</code>} k="issue label that starts a task" />
        <Tile v={usd(f.rules.maxTaskUsd)} k="spend cap per task" />
        <Tile v={f.rules.maxReviewRounds} k="max review rounds" n={`${f.rules.maxNudges} nudges`} />
      </div>
      <h2>Providers</h2>
      <div class="wrap"><table>
        <tr><th>Abstraction</th><th>Provider</th><th>Options</th></tr>
        {Object.entries(f.providers).map(([k, p]) => (
          <tr><td>{k}</td><td><code>{p.name}</code></td><td style="white-space:normal">{Object.keys(p.options).length === 0 ? <span class="muted">–</span> : <code>{JSON.stringify(p.options)}</code>}</td></tr>
        ))}
      </table></div>
      <p class="note">Every abstraction is a plugin. Options whose names look secret are redacted by the server.</p>
      <h2>Prompts</h2>
      {(Object.entries(f.prompts) as Array<[string, string]>).map(([k, v]) => (
        <details class="card"><summary><b>{k}</b> <span class="muted">{v.length.toLocaleString()} chars</span></summary><pre style="max-height:480px">{v}</pre></details>
      ))}
    </>
  );
}
