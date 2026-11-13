/**
 * Late outcomes: on a schedule, ask every OutcomeSource what happened to the tasks merged inside the
 * watch window (reverts, follow-up fixes, incidents, deploys) and record each as `outcome_added`.
 * The ledger dedupes on source + task + kind + ref, so polling the same facts again is a no-op.
 * Tasks that gained an outcome are rescored and re-exported, so scorers and DX see it.
 */
import { mergeOf, type MergedTask, type OutcomeSource, type TaskId } from "@openfactory/contracts";
import type { Ledger } from "@openfactory/ledger";
import { describeError } from "./steps.js";
import type { Log } from "./deps.js";

export type OutcomeWatchDeps = {
  ledger: Pick<Ledger, "listTasks" | "append">;
  sources: OutcomeSource[];
  /** Rescore and export one task (scoreAndExport). */
  rescore: (taskId: TaskId) => Promise<void>;
  log: Log;
};

export type OutcomeWatchOptions = {
  /** Tasks merged longer ago than this are no longer watched. */
  windowDays: number;
  intervalMs: number;
  /** Most merged tasks read per poll. */
  maxTasks?: number;
};

export type OutcomePollResult = { watched: number; added: number; tasks: TaskId[]; failedSources: string[] };

const DAY = 86_400_000;

/** One pass over every source. Never throws; a failing source is logged and the others still run. */
export async function pollOutcomes(deps: OutcomeWatchDeps, opts: Pick<OutcomeWatchOptions, "windowDays" | "maxTasks">, now = new Date()): Promise<OutcomePollResult> {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - opts.windowDays * DAY).toISOString();
  const all = (await deps.ledger.listTasks({ status: "merged", limit: opts.maxTasks ?? 1000 })).map(mergeOf).filter((m): m is MergedTask => m !== null);
  const merged = all.filter((m) => m.mergedAt >= cutoff);
  const changed = new Set<TaskId>();
  // A task whose window just closed with nothing found is rescored once, so "held up" gets its final value.
  for (const m of all) if (m.mergedAt < cutoff && !m.record.scores.some((s) => s.scorer === "facts.held_up")) changed.add(m.record.id);
  const result: OutcomePollResult = { watched: merged.length, added: 0, tasks: [], failedSources: [] };
  const known = new Set(merged.map((m) => m.record.id));

  for (const source of merged.length === 0 ? [] : deps.sources) {
    let found;
    try {
      found = await source.poll(merged, nowIso);
    } catch (e) {
      result.failedSources.push(source.name);
      deps.log("outcome source failed", { source: source.name, error: describeError(e) });
      continue;
    }
    for (const f of found) {
      if (!known.has(f.taskId)) continue; // a source may only report on the tasks it was given
      const dedupeKey = `outcome:${source.name}:${f.taskId}:${f.outcome.kind}:${f.ref}`;
      try {
        const r = await deps.ledger.append(f.taskId, "outcome_added", { outcome: f.outcome }, { dedupeKey, at: nowIso });
        if (r.appended) {
          result.added++;
          changed.add(f.taskId);
          deps.log("outcome recorded", { taskId: f.taskId, kind: f.outcome.kind, source: source.name, ref: f.ref });
        }
      } catch (e) {
        deps.log("outcome append failed", { taskId: f.taskId, error: describeError(e) });
      }
    }
  }

  for (const id of changed) await deps.rescore(id);
  result.tasks = [...changed];
  return result;
}

/** Poll now and then every `intervalMs` until stopped. Polls never overlap. */
export function watchOutcomes(deps: OutcomeWatchDeps, opts: OutcomeWatchOptions): { stop(): Promise<void> } {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> = Promise.resolve();
  let stopped = false;
  const tick = () => {
    running = pollOutcomes(deps, opts)
      .then((r) => {
        if (r.added > 0 || r.failedSources.length > 0) deps.log("outcomes polled", r);
      })
      .catch((e) => deps.log("outcome poll failed", { error: describeError(e) }))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, opts.intervalMs);
      });
  };
  tick();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
