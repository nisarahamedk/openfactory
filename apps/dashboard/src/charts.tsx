/**
 * Inline-SVG charts, server-rendered. Hover (crosshair + tooltip) comes from the shell's
 * small script reading `data-points`; without it the chart still reads.
 * Colors are CSS tokens (series-1..3 from a CVD-validated palette), so dark mode works.
 */

export interface Series {
  name: string;
  /** CSS color, e.g. "var(--series-1)". */
  color: string;
  values: Array<number | null>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** 0 and up to 4 round ticks covering max. */
function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(Number(v.toFixed(6)));
  if ((out.at(-1) ?? 0) < max) out.push(Number((out.length * step).toFixed(6)));
  return out;
}

/**
 * Time-series area/line chart over days. `stacked` stacks the series (parts of a whole);
 * otherwise each is drawn from zero. Gaps (null) break the line.
 */
export function TimeChart({ days, series, format, height = 220, stacked = false, area = true, label, width = 760 }: { days: string[]; series: Series[]; format: (n: number) => string; height?: number; stacked?: boolean; area?: boolean; label: string; width?: number }) {
  const W = width;
  const H = height;
  const pad = { l: 56, r: 12, t: 10, b: 28 };
  const n = days.length;
  const tops = days.map((_, i) => (stacked ? series.reduce((s, x) => s + (x.values[i] ?? 0), 0) : Math.max(0, ...series.map((x) => x.values[i] ?? 0))));
  const yt = ticks(Math.max(0, ...tops));
  const yMax = yt.at(-1) ?? 1;
  const x = (i: number) => pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / yMax);
  const base = days.map(() => 0);
  const shapes = series.map((s) => {
    const lower = [...base];
    const upper = days.map((_, i) => (s.values[i] === null ? null : (stacked ? lower[i]! : 0) + (s.values[i] ?? 0)));
    if (stacked) upper.forEach((u, i) => (base[i] = u ?? base[i]!));
    // Split into runs without nulls.
    const runs: number[][] = [];
    let cur: number[] = [];
    upper.forEach((u, i) => {
      if (u === null) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else cur.push(i);
    });
    if (cur.length) runs.push(cur);
    return { s, runs, upper, lower };
  });
  const every = Math.max(1, Math.ceil(n / 7));
  const points = days.map((d, i) => ({
    x: Number(x(i).toFixed(1)),
    label: shortDay(d),
    rows: series.map((s) => ({ name: s.name, color: s.color, value: s.values[i] === null ? "–" : format(s.values[i] ?? 0) })),
  }));
  return (
    <div class="chart" data-points={JSON.stringify(points)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {yt.map((t) => (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} class="gl" />
            <text x={pad.l - 10} y={y(t) + 4} class="ax" text-anchor="end">{format(t)}</text>
          </g>
        ))}
        {days.map((d, i) => (i % every === 0 || i === n - 1 ? <text x={x(i)} y={H - 6} class="ax" text-anchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{shortDay(d)}</text> : null))}
        {shapes.map(({ s, runs, upper, lower }) =>
          runs.map((run) => {
            const top = run.map((i) => `${x(i).toFixed(1)},${y(upper[i]!).toFixed(1)}`);
            const bottom = [...run].reverse().map((i) => `${x(i).toFixed(1)},${y(stacked ? lower[i]! : 0).toFixed(1)}`);
            return (
              <g>
                {area ? <polygon points={[...top, ...bottom].join(" ")} fill={s.color} fill-opacity="0.16" /> : null}
                <polyline points={top.join(" ")} fill="none" stroke={s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
                {run.length === 1 ? <circle cx={x(run[0]!)} cy={y(upper[run[0]!]!)} r="3.5" fill={s.color} /> : null}
              </g>
            );
          }),
        )}
        <line class="xh" x1="0" x2="0" y1={pad.t} y2={H - pad.b} />
      </svg>
      <div class="tip" />
    </div>
  );
}

/** Correctness vs cost: one point per arm per finished benchmark run. */
export function PassCostChart({ points }: { points: Array<{ label: string; run: string; passRate: number; costUsd: number; series: 1 | 2 }> }) {
  const W = 760;
  const H = 260;
  const pad = { l: 56, r: 24, t: 12, b: 44 };
  const xt = ticks(Math.max(0.01, ...points.map((p) => p.costUsd)));
  const maxCost = xt.at(-1) ?? 1;
  const x = (c: number) => pad.l + (W - pad.l - pad.r) * (c / maxCost);
  const y = (r: number) => pad.t + (H - pad.t - pad.b) * (1 - r);
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Pass rate against mean cost per attempt">
        {[0, 0.25, 0.5, 0.75, 1].map((r) => (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(r)} y2={y(r)} class="gl" />
            <text x={pad.l - 10} y={y(r) + 4} class="ax" text-anchor="end">{`${r * 100}%`}</text>
          </g>
        ))}
        {xt.map((c) => <text x={x(c)} y={H - 24} class="ax" text-anchor="middle">{`$${c.toFixed(2)}`}</text>)}
        <text x={(W + pad.l) / 2} y={H - 4} class="ax" text-anchor="middle">mean cost per attempt</text>
        {points.map((p) => (
          <g>
            <circle cx={x(p.costUsd)} cy={y(p.passRate)} r="7" fill={`var(--series-${p.series})`} stroke="var(--panel)" stroke-width="2">
              <title>{`${p.run} arm ${p.label}: ${Math.round(p.passRate * 100)}% pass, $${p.costUsd.toFixed(2)} per attempt`}</title>
            </circle>
            <text x={x(p.costUsd) + 12} y={y(p.passRate) + 4} class="ax">{`${p.label} · ${p.run}`}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
