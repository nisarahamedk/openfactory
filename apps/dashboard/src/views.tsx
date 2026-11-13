import type { Child } from "hono/jsx";
import type { BenchmarkTask, LedgerEvent, Score, TaskRecord } from "@openfactory/contracts";
import type { BenchRun } from "@openfactory/bench";
import { formatDuration, latestScores } from "@openfactory/scoring";
import { byFactoryVersion, rollup, type Rollup } from "./stats.js";

const CSS = `
:root{--bg:#fafaf9;--panel:#fff;--text:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#2563eb;--good:#15803d;--bad:#b91c1c;--warn:#a16207;--chip:#f5f5f4}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--panel:#1c1917;--text:#f5f5f4;--muted:#a8a29e;--line:#292524;--accent:#60a5fa;--good:#4ade80;--bad:#f87171;--warn:#facc15;--chip:#292524}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}
header{display:flex;gap:20px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
header b{font-size:15px}header a{color:var(--muted);text-decoration:none}header a.on{color:var(--text);font-weight:600}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 16px}h2{font-size:15px;margin:24px 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.tile .v{font-size:22px;font-weight:600}.tile .k{color:var(--muted);font-size:12px}
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-weight:500;font-size:12px}tr:last-child td{border-bottom:0}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
a{color:var(--accent)}.muted{color:var(--muted)}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--chip);font-size:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px}
button,input,select{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--text)}
button{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}
.flash{padding:10px 12px;border-radius:8px;margin-bottom:12px;border:1px solid var(--line);background:var(--panel)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--chip);padding:8px;border-radius:6px;max-height:240px;overflow:auto}
.note{color:var(--muted);font-size:12px;margin-top:6px}
`;

export function Layout(props: { title: string; nav: "tasks" | "versions" | "bench"; flash: string | null; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${props.title} · Factory`}</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header>
          <b>SlopwareFactory</b>
          <a href="/" class={props.nav === "tasks" ? "on" : ""}>Tasks</a>
          <a href="/versions" class={props.nav === "versions" ? "on" : ""}>Factory versions</a>
          <a href="/bench" class={props.nav === "bench" ? "on" : ""}>Benchmarks</a>
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
const when = (iso: string) => iso.replace("T", " ").slice(0, 16);

function statusClass(s: string): string {
  if (s === "merged") return "good";
  if (s === "failed" || s === "closed") return "bad";
  if (s === "awaiting_review") return "warn";
  return "";
}

function Tiles({ r }: { r: Rollup }) {
  return (
    <div class="tiles">
      <div class="tile"><div class="v">{r.tasks}</div><div class="k">tasks ({r.open} open)</div></div>
      <div class="tile"><div class="v">{r.merged}</div><div class="k">merged</div></div>
      <div class="tile"><div class="v">{usd(r.totalCostUsd)}</div><div class="k">model spend</div></div>
      <div class="tile"><div class="v">{usd(r.costPerMergedUsd)}</div><div class="k">cost per merged change</div></div>
      <div class="tile"><div class="v">{pct(r.ciFirstPassRate)}</div><div class="k">CI green on first push</div></div>
      <div class="tile"><div class="v">{num(r.meanReviewRounds)}</div><div class="k">review rounds per PR</div></div>
      <div class="tile"><div class="v">{r.medianLeadTimeS === null ? "–" : formatDuration(r.medianLeadTimeS)}</div><div class="k">median ask → done</div></div>
    </div>
  );
}

function scoreCell(scores: Score[], name: string) {
  const s = latestScores(scores).get(name);
  if (s === undefined) return <span class="muted">–</span>;
  if (name === "facts.ci_first_pass") return <span class={s.value === 1 ? "good" : "bad"}>{s.label ?? s.value}</span>;
  return <span title={s.reason}>{s.label ?? s.value}</span>;
}

export function TasksPage({ tasks }: { tasks: TaskRecord[] }) {
  return (
    <>
      <h1>Tasks</h1>
      <Tiles r={rollup(tasks)} />
      <h2>All tasks</h2>
      <div class="wrap">
        <table>
          <tr><th>Task</th><th>Status</th><th>Factory version</th><th>Model</th><th class="num">Cost</th><th class="num">Review rounds</th><th>CI first push</th><th>Ask → done</th><th>PR</th><th>Started</th></tr>
          {tasks.map((t) => (
            <tr>
              <td><a href={`/tasks/${t.id}`}>{t.title.slice(0, 60)}</a><div class="muted">{t.id}</div></td>
              <td><span class={`chip ${statusClass(t.status)}`}>{t.status}</span></td>
              <td><code>{t.factoryVersion}</code></td>
              <td>{t.harness.model}</td>
              <td class="num">{usd(t.usage.costUsd)}</td>
              <td class="num">{t.pr === null ? "–" : t.people.reviewRounds}</td>
              <td>{scoreCell(t.scores, "facts.ci_first_pass")}</td>
              <td>{scoreCell(t.scores, "facts.lead_time_s")}</td>
              <td>{t.pr === null ? <span class="muted">–</span> : <a href={t.pr.url}>#{t.pr.number}</a>}</td>
              <td class="muted">{when(t.createdAt)}</td>
            </tr>
          ))}
        </table>
      </div>
      {tasks.length === 0 ? <p class="muted">No tasks yet. Label a GitHub issue <code>factory</code> to start one.</p> : null}
    </>
  );
}

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
              <td>{r.medianLeadTimeS === null ? "–" : formatDuration(r.medianLeadTimeS)}</td>
              <td class="muted">{when(lastSeen)}</td>
            </tr>
          ))}
        </table>
      </div>
      <p class="note">These numbers describe live work; they are not proof one version is better, since tasks differ. Use a benchmark A-vs-B run for that.</p>
    </>
  );
}

export function TaskPage({ t, events }: { t: TaskRecord; events: LedgerEvent[] }) {
  const scores = [...latestScores(t.scores).values()];
  return (
    <>
      <h1>{t.title}</h1>
      <p>
        <span class={`chip ${statusClass(t.status)}`}>{t.status}</span>{" "}
        <span class="muted">{t.id} · factory <code>{t.factoryVersion}</code> · {t.harness.name} / {t.harness.model}</span>
      </p>
      <div class="grid2">
        <div class="card">
          <b>Work</b>
          <div>Source: {t.source.url !== null ? <a href={t.source.url}>{t.source.repo.owner}/{t.source.repo.name}#{t.source.issueNumber}</a> : `${t.source.repo.owner}/${t.source.repo.name}`}</div>
          <div>PR: {t.pr === null ? "–" : <a href={t.pr.url}>#{t.pr.number}</a>}</div>
          <div>Branch: {t.branch ?? "–"} · Environment: {t.environment?.name ?? "–"}</div>
          <div>Cost: {usd(t.usage.costUsd)} ({t.usage.inputTokens.toLocaleString()} in / {t.usage.outputTokens.toLocaleString()} out tokens)</div>
          <div>People: {t.people.comments} comments, {t.people.reviewRounds} review rounds</div>
          {t.status === "merged" ? (
            <form method="post" action={`/tasks/${t.id}/benchmark`} style="margin-top:10px">
              <button type="submit">Add to benchmark</button>
            </form>
          ) : (
            <p class="note">"Add to benchmark" is available once the PR is merged.</p>
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
      <h2>Evidence</h2>
      {t.evidence.length === 0 ? <p class="muted">None.</p> : (
        <div class="wrap"><table>
          <tr><th>Kind</th><th>Title</th><th>Commit</th><th>Environment</th><th>When</th></tr>
          {t.evidence.map((e) => <tr><td>{e.kind}</td><td><a href={e.url}>{e.title}</a></td><td><code>{e.commitSha.slice(0, 7)}</code></td><td>{e.environment}</td><td class="muted">{when(e.createdAt)}</td></tr>)}
        </table></div>
      )}
      <h2>After the merge</h2>
      {t.outcomes.length === 0 ? <p class="muted">Nothing reported (reverts, incidents and rework show up here).</p> : (
        <div class="wrap"><table>
          <tr><th>Outcome</th><th>Detail</th><th>Happened</th><th>Learned</th></tr>
          {t.outcomes.map((o) => <tr><td class={o.kind === "merged" ? "good" : "bad"}>{o.kind}</td><td>{o.detail}</td><td class="muted">{when(o.at)}</td><td class="muted">{when(o.arrivedAt)}</td></tr>)}
        </table></div>
      )}
      <h2>Timeline</h2>
      <div class="wrap"><table>
        <tr><th>When</th><th>Event</th><th>Detail</th></tr>
        {events.map((e) => <tr><td class="muted">{when(e.at)}</td><td>{e.type}</td><td class="muted" style="white-space:normal">{describe(e)}</td></tr>)}
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
    case "pushed": return s("sha").slice(0, 7);
    case "turn_finished": return `${s("reason")} turn, ${s("stopReason")}`;
    case "comment_received": return `from ${s("author")}`;
    default: return "";
  }
}

export function BenchPage({ tasks, runs, versions, models }: { tasks: BenchmarkTask[]; runs: BenchRun[]; versions: string[]; models: [string, string] }) {
  return (
    <>
      <h1>Benchmarks</h1>
      <p class="muted">Past tasks, replayed under two factory versions. A run says how much B beats A, with a range, and says so when the difference is too small to trust.</p>
      <h2>Suite ({tasks.length})</h2>
      {tasks.length === 0 ? <p class="muted">Empty. Open a merged task and press "Add to benchmark".</p> : (
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
          <p><b class={rep.verdict === "too_close" ? "warn" : "good"}>{rep.summary}</b></p>
          <table>
            <tr><th>Arm</th><th class="num">Pass</th><th class="num">Pass rate</th><th class="num">Mean cost</th><th class="num">Mean time</th></tr>
            {[rep.a, rep.b].map((s) => <tr><td>{s.arm}</td><td class="num">{s.passes}/{s.attempts}</td><td class="num">{pct(s.passRate)}</td><td class="num">{usd(s.meanCostUsd)}</td><td class="num">{formatDuration(s.meanDurationS)}</td></tr>)}
          </table>
        </>
      ) : null}
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
