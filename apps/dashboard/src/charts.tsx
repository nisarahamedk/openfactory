/**
 * Small inline-SVG charts. No chart library: the page is server-rendered and has to work
 * without JavaScript. Colors come from the page's CSS tokens so both themes work.
 */

/** Grouped bars per day: PRs opened vs merged. */
export function OpenedMergedChart({ days }: { days: Array<{ day: string; opened: number; merged: number }> }) {
  const W = 1100;
  const H = 160;
  const pad = { l: 28, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...days.map((d) => Math.max(d.opened, d.merged)));
  const slot = (W - pad.l - pad.r) / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(12, slot / 2 - 2));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [...new Set([0, Math.ceil(max / 2), max])];
  const labelEvery = Math.ceil(days.length / 7);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} class="chart" role="img" aria-label="PRs opened and merged per day">
      {ticks.map((t) => (
        <g>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} class="grid" />
          <text x={pad.l - 6} y={y(t) + 4} class="axis" text-anchor="end">{t}</text>
        </g>
      ))}
      {days.map((d, i) => {
        const x = pad.l + i * slot + slot / 2;
        return (
          <g>
            <rect x={x - bw - 1} y={y(d.opened)} width={bw} height={y(0) - y(d.opened)} class="s1" rx="1"><title>{`${d.day}: ${d.opened} opened`}</title></rect>
            <rect x={x + 1} y={y(d.merged)} width={bw} height={y(0) - y(d.merged)} class="s2" rx="1"><title>{`${d.day}: ${d.merged} merged`}</title></rect>
            {i % labelEvery === 0 ? <text x={x} y={H - 6} class="axis" text-anchor="middle">{d.day.slice(5)}</text> : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Correctness vs cost: one point per arm per finished run. Up and left is better. */
export function PassCostChart({ points }: { points: Array<{ label: string; run: string; passRate: number; costUsd: number; series: 1 | 2 }> }) {
  const W = 1100;
  const H = 220;
  const pad = { l: 40, r: 16, t: 10, b: 40 };
  const maxCost = Math.max(0.01, ...points.map((p) => p.costUsd)) * 1.15;
  const x = (c: number) => pad.l + (W - pad.l - pad.r) * (c / maxCost);
  const y = (r: number) => pad.t + (H - pad.t - pad.b) * (1 - r);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} class="chart" role="img" aria-label="Pass rate against mean cost per attempt">
      {[0, 0.5, 1].map((r) => (
        <g>
          <line x1={pad.l} x2={W - pad.r} y1={y(r)} y2={y(r)} class="grid" />
          <text x={pad.l - 6} y={y(r) + 4} class="axis" text-anchor="end">{`${r * 100}%`}</text>
        </g>
      ))}
      {[0, 0.5, 1].map((f) => (
        <text x={x(maxCost * f)} y={H - 22} class="axis" text-anchor="middle">{`$${(maxCost * f).toFixed(2)}`}</text>
      ))}
      <text x={(W + pad.l) / 2} y={H - 2} class="axis" text-anchor="middle">mean cost per attempt</text>
      {points.map((p) => (
        <g>
          <circle cx={x(p.costUsd)} cy={y(p.passRate)} r="6" class={p.series === 1 ? "s1" : "s2"}>
            <title>{`${p.run} arm ${p.label}: ${Math.round(p.passRate * 100)}% pass, $${p.costUsd.toFixed(2)} per attempt`}</title>
          </circle>
          <text x={x(p.costUsd) + 9} y={y(p.passRate) + 4} class="axis">{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

/** A horizontal stacked bar of time per stage (kickoff → PR → first review → merge). */
export function StageBar({ parts }: { parts: Array<{ label: string; seconds: number | null; cls: string }> }) {
  const known = parts.filter((p): p is { label: string; seconds: number; cls: string } => p.seconds !== null && p.seconds > 0);
  const total = known.reduce((s, p) => s + p.seconds, 0);
  if (total === 0) return <div class="muted">Not enough finished PRs yet.</div>;
  return (
    <div class="stagebar">
      {known.map((p) => (
        <div class={p.cls} style={`flex:${p.seconds / total}`} title={`${p.label}`} />
      ))}
    </div>
  );
}
