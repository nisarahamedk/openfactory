import { CATEGORIES, CATEGORY_LABEL, share, type TeamSuite } from "./mix.js";
import { Badge, Empty } from "./ui.js";

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);

function Bar({ v, series }: { v: number; series: 1 | 2 }) {
  return (
    <span style="display:inline-flex;align-items:center;gap:8px;min-width:150px">
      <span style={`display:inline-block;height:8px;border-radius:2px;width:${Math.max(2, Math.round(v * 110))}px;background:var(--series-${series});opacity:${v === 0 ? 0.25 : 1}`} />
      <span class="num t2" style="font-size:12.5px">{Math.round(v * 100)}%</span>
    </span>
  );
}

/** Each team's suite next to the work the team really does, and run results re-weighted to that work. */
export function TeamSuites({ suites, days }: { suites: TeamSuite[]; days: number }) {
  const shown = suites.filter((s) => s.suite.length > 0 || s.live.length > 0);
  if (!shown.length) return null;
  return (
    <>
      <div class="section-title">Team suites against the work they do <span class="n">last {days} days</span></div>
      <p class="note" style="margin-top:-4px;margin-bottom:12px">A suite picked by hand rarely matches what a team really asks for. Each team's results are re-weighted by its live task mix, and the share of live work the suite doesn't cover is shown rather than ignored.</p>
      <div class="stack">
        {shown.map((s) => {
          const cats = CATEGORIES.filter((c) => (s.liveMix.get(c) ?? 0) > 0 || (s.suiteMix.get(c) ?? 0) > 0);
          return (
            <div class="card flush">
              <div class="split">
                <div>
                  <div class="head"><h3><a class="link" href={`/teams/${s.team.slug}`}>{s.team.name}</a> <span class="muted" style="font-weight:400">on <a class="link" href={`/factories/${s.team.factory}`}>{s.team.factory}</a></span></h3>
                    {s.live.length ? <Badge tone={s.coverage >= 0.8 ? "good" : s.coverage >= 0.5 ? "warn" : "bad"}>{pct(s.coverage)} of live work covered</Badge> : null}
                  </div>
                  <div class="meta">{s.suite.length} benchmark task{s.suite.length === 1 ? "" : "s"} · {s.live.length} live task{s.live.length === 1 ? "" : "s"}</div>
                  {cats.length ? (
                    <table class="tbl" style="margin-top:10px">
                      <thead><tr><th style="padding-left:0">Kind of work</th><th>Live mix</th><th>Suite</th></tr></thead>
                      <tbody>{cats.map((c) => (
                        <tr><td style="padding-left:0">{CATEGORY_LABEL[c]}{(s.suiteMix.get(c) ?? 0) === 0 && (s.liveMix.get(c) ?? 0) > 0 ? <span class="badge warn" style="margin-left:6px;font-size:12px">not in suite</span> : null}</td><td><Bar v={share(s.liveMix, c)} series={1} /></td><td><Bar v={share(s.suiteMix, c)} series={2} /></td></tr>
                      ))}</tbody>
                    </table>
                  ) : <Empty title="No tasks yet" />}
                </div>
                <div>
                  <h3>Latest run on this suite</h3>
                  {s.run ? (
                    <>
                      <div class="meta"><a class="link mono" href={`/bench#${s.run.id}`}>{s.run.id}</a> · pass rate and cost per attempt, together</div>
                      <table class="tbl" style="margin-top:10px">
                        <thead><tr><th style="padding-left:0">Arm</th><th class="r">Pass, suite</th><th class="r">Pass, live mix</th><th class="r">Cost, suite</th><th class="r">Cost, live mix</th></tr></thead>
                        <tbody>{s.run.arms.map((a) => (
                          <tr><td style="padding-left:0"><b style="font-weight:550">{a.label}</b><div class="muted" style="font-size:12px">{a.version} · {a.model} · {a.raw.n} attempts</div></td><td class="r num">{pct(a.raw.pass)}</td><td class="r num"><b>{pct(a.weighted.pass)}</b></td><td class="r num">{usd(a.raw.cost)}</td><td class="r num"><b>{usd(a.weighted.cost)}</b></td></tr>
                        ))}</tbody>
                      </table>
                      <p class="note">Live-mix figures weight each kind of work by how often the team really asks for it.{s.coverage < 1 && s.live.length ? ` ${pct(1 - s.coverage)} of live work has no benchmark task, so no figure speaks for it.` : ""}</p>
                    </>
                  ) : <p class="muted">No run has used this suite yet.</p>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** What each factory version changes, from factory.yaml: the parts a factory engineer varies and A/B tests. */
export function VersionDefs({ versions }: { versions: Record<string, { label: string | null; prompt: string | null; models: { default: string; routes: Array<{ model: string; labels?: string[] | undefined; keywords?: string[] | undefined }> } | null; effort: string | null; agentsMd: string | null; skills: string[]; mcp: string[]; codegraph: boolean }> | undefined }) {
  const rows = Object.entries(versions ?? {});
  if (!rows.length) return null;
  const routing = (m: NonNullable<(typeof rows)[number][1]["models"]>) => [m.default, ...m.routes.map((r) => `${r.model} for ${[...(r.labels ?? []), ...(r.keywords ?? [])].join("/")}`)].join("; ");
  return (
    <>
      <div class="section-title">What each version changes <span class="n">{rows.length}</span></div>
      <div class="card flush"><div class="scroll"><table class="tbl">
        <thead><tr><th>Version</th><th>Routing policy</th><th>Effort</th><th>Skills</th><th>Tools</th><th>AGENTS.md and prompt</th></tr></thead>
        <tbody>{rows.map(([id, v]) => (
          <tr>
            <td><b class="mono" style="font-weight:550">{id}</b>{v.label ? <div class="muted" style="font-size:12.5px">{v.label}</div> : null}</td>
            <td class="wrapcell" style="min-width:180px">{v.models ? routing(v.models) : <span class="muted">factory default</span>}</td>
            <td>{v.effort ?? <span class="muted">default</span>}</td>
            <td>{v.skills.length ? v.skills.map((x) => <span class="pill">{x}</span>) : <span class="muted">—</span>}</td>
            <td>{[...(v.codegraph ? ["codegraph"] : []), ...v.mcp].map((x) => <span class="pill">{x}</span>)}{!v.codegraph && !v.mcp.length ? <span class="muted">—</span> : null}</td>
            <td class="wrapcell t2" style="font-size:13px">{[v.agentsMd, v.prompt].filter(Boolean).join(" · ").slice(0, 220) || <span class="muted">—</span>}</td>
          </tr>
        ))}</tbody>
      </table></div></div>
    </>
  );
}
