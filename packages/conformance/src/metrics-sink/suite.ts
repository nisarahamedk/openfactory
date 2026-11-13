import { afterEach, describe, expect, it } from "vitest";
import type { MetricsSink } from "@openfactory/contracts";
import { fixtureRecord } from "../fixtures.js";
import type { Subject } from "../harness.js";

/** A MetricsSink under test, plus a way to read what reached the destination. */
export interface MetricsSinkSubject extends Subject<MetricsSink> {
  /** The stored row for a task as seen at the destination, reduced to its status; null if absent. */
  readStatus(taskId: string): Promise<string | null>;
  /** Number of task rows at the destination. */
  countTasks(): Promise<number>;
}

/**
 * Conformance for a MetricsSink: writes are idempotent upserts keyed by task id, an
 * empty batch is a no-op, and a batch with several tasks lands every one of them.
 */
export function describeMetricsSinkConformance(label: string, make: () => Promise<MetricsSinkSubject>): void {
  describe(`MetricsSink conformance: ${label}`, () => {
    let current: MetricsSinkSubject | null = null;
    const open = async () => (current = await make());
    afterEach(async () => {
      await current?.cleanup();
      current = null;
    });

    it("has a name", async () => {
      expect((await open()).subject.name).toMatch(/\S/);
    });

    it("an empty batch is a no-op", async () => {
      const s = await open();
      await s.subject.writeTasks([]);
      expect(await s.countTasks()).toBe(0);
    });

    it("writes every task in a batch", async () => {
      const s = await open();
      await s.subject.writeTasks([fixtureRecord({ id: "task_c1" }), fixtureRecord({ id: "task_c2", status: "working", pr: null })]);
      expect(await s.countTasks()).toBe(2);
      expect(await s.readStatus("task_c2")).toBe("working");
    });

    it("re-writing a task updates its row instead of adding one", async () => {
      const s = await open();
      await s.subject.writeTasks([fixtureRecord({ id: "task_c1", status: "awaiting_review" })]);
      await s.subject.writeTasks([fixtureRecord({ id: "task_c1", status: "merged" })]);
      await s.subject.writeTasks([fixtureRecord({ id: "task_c1", status: "merged" })]);
      expect(await s.countTasks()).toBe(1);
      expect(await s.readStatus("task_c1")).toBe("merged");
    });
  });
}
