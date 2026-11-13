import type { LedgerEvent, Score, Scorer, TaskRecord } from "@openfactory/contracts";
import { factScorers } from "./facts.js";

export * from "./facts.js";
export { parseEvents, type ParsedEvents } from "./events.js";

/** Outcome of one scoring pass: the new scores plus scorers that threw (a scorer bug, not a task fact). */
export interface ScoringRun {
  scores: Score[];
  errors: Array<{ scorer: string; message: string }>;
}

/**
 * Run scorers over one task. A scorer that returns null doesn't apply yet and is skipped.
 * A scorer that throws is reported in `errors` and never blocks the others.
 */
export function runScorers(
  record: TaskRecord,
  events: LedgerEvent[],
  now: string,
  scorers: readonly Scorer[] = factScorers,
): ScoringRun {
  const run: ScoringRun = { scores: [], errors: [] };
  for (const s of scorers) {
    try {
      const result = s.score(record, events, now);
      if (result !== null) run.scores.push(result);
    } catch (err) {
      run.errors.push({ scorer: s.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return run;
}

/**
 * Merge fresh scores into a record's existing ones. A score replaces the earlier one
 * from the same scorer AND version; scores from other versions are kept, so a scorer
 * change never silently rewrites history.
 */
export function mergeScores(existing: readonly Score[], fresh: readonly Score[]): Score[] {
  const key = (s: Score) => `${s.scorer}@${s.scorerVersion}`;
  const map = new Map(existing.map((s) => [key(s), s] as const));
  for (const s of fresh) map.set(key(s), s);
  return [...map.values()];
}

/** Latest score value per scorer name (highest-numbered version wins), for display. */
export function latestScores(scores: readonly Score[]): Map<string, Score> {
  const out = new Map<string, Score>();
  for (const s of scores) {
    const prev = out.get(s.scorer);
    if (prev === undefined || Number(s.scorerVersion) >= Number(prev.scorerVersion)) out.set(s.scorer, s);
  }
  return out;
}
