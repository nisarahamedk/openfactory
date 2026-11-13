import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskId } from "@openfactory/contracts";
import { Ledger } from "./store.js";

const repo = { host: "github" as const, owner: "acme", name: "app" };

async function fresh() {
  const ledger = new Ledger(drizzle(new PGlite()));
  await ledger.migrate();
  return ledger;
}

describe("Ledger", () => {
  let ledger: Ledger;
  beforeEach(async () => {
    ledger = await fresh();
  });

  async function create(dedupeKey?: string) {
    return ledger.createTask({
      id: "task_1",
      factoryVersion: "fv_test",
      source: { kind: "github_issue", repo, issueNumber: 7, url: "https://x/7" },
      title: "Add dark mode",
      ask: "please",
      harness: { name: "claude-code", model: "sonnet" },
      ...(dedupeKey ? { dedupeKey } : {}),
    });
  }

  it("creates a task once per delivery", async () => {
    expect((await create("d1")).appended).toBe(true);
    expect((await ledger.findByIssue(repo, 7))?.id).toBe("task_1");
    expect((await ledger.events("task_1")).map((e) => e.type)).toEqual(["task_created"]);
  });

  it("tracks a multi-repo task, its version arm and merge risk", async () => {
    await create();
    const api = { host: "github" as const, owner: "acme", name: "api" };
    await ledger.append("task_1", "branch_set", { branch: "factory/task_1" });
    await ledger.append("task_1", "scope_planned", { repos: [repo, api], reason: "issue names acme/api" });
    await ledger.append("task_1", "version_routed", { version: "fv_candidate", arm: "candidate", share: 0.1 });
    await ledger.append("task_1", "pr_opened", { number: 5, url: "https://x/app/5", headSha: "a1" });
    await ledger.append("task_1", "pr_opened", { number: 9, url: "https://x/api/9", headSha: "b1", repo: api });
    await ledger.append("task_1", "pushed", { sha: "b2", byFactory: true, repo: api });
    const r = (await ledger.append("task_1", "merge_risk", { level: "medium", reasons: ["touches drizzle/1.sql"], headSha: "a1" })).record;
    expect(r.pr?.number).toBe(5);
    expect(r.repos?.map((x) => [x.repo.name, x.branch, x.pr?.number, x.pr?.headSha])).toEqual([
      ["app", "factory/task_1", 5, "a1"],
      ["api", "factory/task_1", 9, "b2"],
    ]);
    expect([r.factoryVersion, r.versionArm, r.risk?.level]).toEqual(["fv_candidate", "candidate", "medium"]);
    expect((await ledger.findByPr(api, 9))?.id).toBe("task_1");
    expect((await ledger.findByHeadSha(api, "b2"))?.id).toBe("task_1");
  });

  it("projects events into the record and dedupes deliveries", async () => {
    await create();
    await ledger.setStatus("task_1", "working");
    await ledger.append("task_1", "session_started", { sessionId: "s-1" });
    await ledger.append("task_1", "turn_finished", {
      reason: "intake",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.25 },
    });
    await ledger.append("task_1", "pr_opened", { number: 3, url: "https://x/pull/3", headSha: "abc" });
    await ledger.append("task_1", "pushed", { sha: "def" });
    const c = { author: "rev", isBot: false, on: "pr" as const };
    expect((await ledger.append("task_1", "comment_received", c, { dedupeKey: "gh:1" })).appended).toBe(true);
    expect((await ledger.append("task_1", "comment_received", c, { dedupeKey: "gh:1" })).appended).toBe(false);
    await ledger.append("task_1", "review_round_started", { comments: 1 });

    const r = (await ledger.getTask("task_1"))!;
    expect(r.status).toBe("working");
    expect(r.harnessSessionId).toBe("s-1");
    expect(r.usage.costUsd).toBe(0.25);
    expect(r.pr).toEqual({ number: 3, url: "https://x/pull/3", headSha: "def" });
    expect(r.people).toEqual({ comments: 1, reviewRounds: 1 });
    expect((await ledger.findByPr(repo, 3))?.id).toBe("task_1");
    expect((await ledger.findByHeadSha(repo, "def"))?.id).toBe("task_1");
    expect((await ledger.events("task_1")).map((e) => e.type)).toContain("status_changed");
    expect(await ledger.listTasks({ status: "working" })).toHaveLength(1);
  });
});

describe("people, labels and world checks", () => {
  it("keeps who asked and the labels, and turns a world check into a score", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const l = new Ledger(drizzle(new PGlite()));
    await l.migrate();
    const id = "task_w1" as TaskId;
    await l.createTask({ id, factoryVersion: "fv", source: { kind: "github_issue", repo: { host: "github", owner: "o", name: "r" }, issueNumber: 1, url: null }, title: "t", ask: "a", harness: { name: "h", model: "m" }, requestedBy: "dana", labels: ["factory", "ui"] });
    const w = { world: "payments-30d", headSha: "abc", simDays: 30, status: "failed" as const, startedAt: "2026-11-13T00:00:00Z", finishedAt: "2026-11-13T00:03:00Z", invariants: [{ name: "money conserved", ok: false, detail: "2 refunds paid twice" }, { name: "no 5xx spike", ok: true, detail: "" }], metrics: [], reportUrl: null };
    const { record } = await l.append(id, "world_check", w);
    expect(record.requestedBy).toBe("dana");
    expect(record.labels).toEqual(["factory", "ui"]);
    expect(record.worldChecks).toHaveLength(1);
    expect(record.scores.find((s) => s.scorer === "checks.world")).toMatchObject({ value: 0, label: "failed", reason: "payments-30d, 30 simulated days: money conserved" });
  });
});

describe("app store", () => {
  it("saves views and keeps rollout history", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { AppStore } = await import("./app-store.js");
    const s = new AppStore(drizzle(new PGlite()));
    await s.migrate();
    const v = await s.saveView({ name: "a", path: "/insights", owner: "dana", share: "me", team: "core" });
    expect(v.team).toBeNull();
    const renamed = await s.saveView({ id: v.id, name: "b", path: "/insights?by=repo", owner: "dana", share: "team", team: "core" });
    expect(renamed.id).toBe(v.id);
    expect((await s.listViews({ login: "li", teams: ["core"] })).map((x) => x.name)).toEqual(["b"]);
    expect(await s.listViews({ login: "li", teams: [] })).toEqual([]);
    await s.setRollout({ factory: "default", live: "fv_1", candidate: "fv_2", share: 0.1, updatedBy: "omar", note: null });
    await s.setRollout({ factory: "default", live: "fv_2", candidate: null, share: 0, updatedBy: "omar", note: "promoted" });
    const r = await s.rollout("default");
    expect(r!.state.live).toBe("fv_2");
    expect(r!.history.map((h) => h.candidate)).toEqual(["fv_2"]);
  });
});
