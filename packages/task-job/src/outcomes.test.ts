import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import type { MergedTask, OutcomeSource, TaskId } from "@openfactory/contracts";
import { Ledger } from "@openfactory/ledger";
import { pollOutcomes } from "./outcomes.js";

const repo = { host: "github" as const, owner: "acme", name: "app" };

async function ledgerWith(tasks: Array<{ id: string; mergedAt: string | null }>) {
  const ledger = new Ledger(drizzle(new PGlite()));
  await ledger.migrate();
  for (const t of tasks) {
    await ledger.createTask({ id: t.id as TaskId, factoryVersion: "fv", source: { kind: "github_issue", repo, issueNumber: 1, url: null }, title: t.id, ask: "a", harness: { name: "h", model: "m" } });
    if (t.mergedAt === null) continue;
    await ledger.append(t.id as TaskId, "outcome_added", { outcome: { kind: "merged", source: "github", detail: "merge abcdef0123", at: t.mergedAt, arrivedAt: t.mergedAt } });
    await ledger.setStatus(t.id as TaskId, "merged");
  }
  return ledger;
}

describe("pollOutcomes", () => {
  const now = new Date("2026-11-20T00:00:00Z");

  it("records each new outcome once, only for watched tasks, and rescores the tasks that changed", async () => {
    const ledger = await ledgerWith([
      { id: "task_new", mergedAt: "2026-11-15T00:00:00Z" },
      { id: "task_old", mergedAt: "2026-09-01T00:00:00Z" },
      { id: "task_open", mergedAt: null },
    ]);
    const given: string[][] = [];
    const source: OutcomeSource = {
      name: "fake",
      poll: async (merged: MergedTask[], at) => {
        given.push(merged.map((m) => `${m.record.id}@${m.mergeSha}`));
        return [
          { taskId: "task_new" as TaskId, ref: "pr:40", outcome: { kind: "reverted", source: "fake", detail: "reverted by PR #40", at: "2026-11-18T00:00:00Z", arrivedAt: at } },
          { taskId: "task_old" as TaskId, ref: "pr:41", outcome: { kind: "hotfix", source: "fake", detail: "outside the window", at: "2026-11-18T00:00:00Z", arrivedAt: at } },
        ];
      },
    };
    const rescored: string[] = [];
    const deps = { ledger, sources: [source], rescore: async (id: TaskId) => void rescored.push(id), log: () => {} };

    const first = await pollOutcomes(deps, { windowDays: 30 }, now);
    expect(given).toEqual([["task_new@abcdef0123"]]);
    expect(first.added).toBe(1);
    expect(rescored.sort()).toEqual(["task_new", "task_old"]); // task_old: its window closed, so held_up is settled once

    const second = await pollOutcomes(deps, { windowDays: 30 }, now);
    expect(second.added).toBe(0);
    const rec = await ledger.getTask("task_new" as TaskId);
    expect(rec!.outcomes.map((o) => o.kind)).toEqual(["merged", "reverted"]);
    expect((await ledger.getTask("task_old" as TaskId))!.outcomes.map((o) => o.kind)).toEqual(["merged"]);
    const ev = (await ledger.events("task_new" as TaskId)).filter((e) => e.type === "outcome_added");
    expect(ev.at(-1)!.at).toBe(now.toISOString()); // on the timeline when we learned it
  });

  it("a failing source is reported and doesn't stop the others", async () => {
    const ledger = await ledgerWith([{ id: "task_new", mergedAt: "2026-11-15T00:00:00Z" }]);
    const broken: OutcomeSource = { name: "broken", poll: async () => { throw new Error("503"); } };
    const ok: OutcomeSource = {
      name: "ok",
      poll: async (_m, at) => [{ taskId: "task_new" as TaskId, ref: "incident:1", outcome: { kind: "incident_linked", source: "ok", detail: "inc 1", at, arrivedAt: at } }],
    };
    const r = await pollOutcomes({ ledger, sources: [broken, ok], rescore: async () => {}, log: () => {} }, { windowDays: 30 }, now);
    expect(r.failedSources).toEqual(["broken"]);
    expect(r.added).toBe(1);
  });
});
