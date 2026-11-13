import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { beforeEach, describe, expect, it } from "vitest";
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
