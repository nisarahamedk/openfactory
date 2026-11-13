import type { LedgerEvent, Score, Scorer, TaskRecord } from "@openfactory/contracts";

/**
 * A faithful fake Scorer: counts the task's events of one type. Returns null when the
 * task has no events yet, like a real scorer that doesn't apply yet.
 */
export class EventCountScorer implements Scorer {
  readonly name: string;
  readonly version = "1";

  constructor(private readonly eventType: string) {
    this.name = `fake.count.${eventType}`;
  }

  score(_record: TaskRecord, events: LedgerEvent[], now: string): Score | null {
    if (events.length === 0) return null;
    const n = events.filter((e) => e.type === this.eventType).length;
    return { scorer: this.name, scorerVersion: this.version, value: n, label: String(n), reason: `${n} "${this.eventType}" events`, at: now };
  }
}
