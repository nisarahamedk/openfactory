import type { MetricsSink, TaskRecord } from "@openfactory/contracts";

/** A faithful fake MetricsSink: keeps the latest copy of each task in memory. */
export class InMemoryMetricsSink implements MetricsSink {
  readonly name = "memory";
  readonly rows = new Map<string, TaskRecord>();

  async writeTasks(records: TaskRecord[]): Promise<void> {
    for (const r of records) this.rows.set(r.id, structuredClone(r));
  }
}
