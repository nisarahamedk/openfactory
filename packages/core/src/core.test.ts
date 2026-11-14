import { describe, expect, it } from "vitest";
import type { Actor } from "./domain/actor.js";
import { Failure, type ErrorCode } from "./domain/errors.js";
import { capabilities, createCore } from "./application/core.js";
import { MemoryDefinitions, memoryDeps, taskRecord } from "./testing/memory.js";

const key: Actor = { principal: { kind: "apiKey", keyId: "factory-api" }, via: null, agent: null, requestId: "req_1" };
const user = (login: string, agent = false): Actor => ({ principal: { kind: "user", login }, via: { kind: "apiKey", keyId: "factory-api" }, agent: agent ? { client: "claude-code" } : null, requestId: "req_2" });

async function code(p: Promise<unknown>): Promise<ErrorCode | "ok"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof Failure) return e.error.code;
    throw e;
  }
}

async function withPeople() {
  const m = memoryDeps();
  for (const [login, role] of [["vic", "viewer"], ["erin", "engineer"], ["ada", "admin"]] as const)
    await m.org.putPerson({ login, name: null, email: null, persona: "engineer", role, identities: {}, status: "joined", invitedBy: null, invitedAt: "t", joinedAt: "t" });
  m.tasks.put(taskRecord({ id: "task_a1" }));
  return m;
}

describe("authorization matrix", () => {
  it("each role reaches exactly the operations at or below it", async () => {
    const m = await withPeople();
    const core = createCore(m.deps);
    expect(await code(core.execute("listTasks", user("vic"), {}))).toBe("ok");
    expect(await code(core.execute("cancelTask", user("vic"), { id: "task_a1" }))).toBe("FORBIDDEN");
    expect(await code(core.execute("cancelTask", user("erin"), { id: "task_a1" }))).toBe("ok");
    expect(await code(core.execute("setOrg", user("erin"), { name: "Acme" }))).toBe("FORBIDDEN");
    expect(await code(core.execute("setOrg", user("ada"), { name: "Acme" }))).toBe("ok");
    // Unknown people in a set-up org are viewers.
    expect(await code(core.execute("cancelTask", user("stranger"), { id: "task_a1" }))).toBe("FORBIDDEN");
  });

  it("before anyone is set up, the operator runs everything", async () => {
    const m = memoryDeps();
    const core = createCore(m.deps);
    expect(await core.roleOf(user("first"))).toBe("admin");
    expect(await code(core.execute("setOrg", user("first"), { name: "Acme" }))).toBe("ok");
    // Naming the org made them its admin; a newcomer is now a viewer.
    expect(await core.roleOf(user("first"))).toBe("admin");
    expect(await core.roleOf(user("second"))).toBe("viewer");
  });

  it("agents never run irreversible operations, even for an admin", async () => {
    const m = await withPeople();
    const core = createCore(m.deps);
    const v = await core.execute("saveView", user("ada"), { name: "Mine", path: "/tasks", share: "me", team: null });
    expect(await code(core.execute("deleteView", user("ada", true), { id: v.view.id }))).toBe("FORBIDDEN");
    expect(await code(core.execute("cancelTask", user("ada", true), { id: "task_a1" }))).toBe("ok");
    expect(await code(core.execute("deleteView", user("ada"), { id: v.view.id }))).toBe("ok");
  });

  it("every capability names a role and a risk tier", () => {
    for (const [name, c] of Object.entries(capabilities)) {
      expect(["viewer", "engineer", "admin"], name).toContain(c.audience);
      expect(["read", "reversible", "irreversible", "external"], name).toContain(c.risk);
      // Reads are open to viewers; nothing that changes state is.
      if (c.risk !== "read" && name !== "saveView" && name !== "deleteView" && name !== "joinOrg") expect(c.audience, name).not.toBe("viewer");
    }
  });
});

describe("who acts comes from the credentials", () => {
  it("a person's own call is theirs, whatever the body says", async () => {
    const m = await withPeople();
    const core = createCore(m.deps);
    await core.execute("cancelTask", user("erin"), { id: "task_a1", by: "ada" });
    expect(m.runner.calls).toEqual(["cancel task_a1 by erin"]);
    const v = await core.execute("saveView", user("erin"), { name: "x", path: "/", share: "me", team: null, owner: "ada" });
    expect(v.view.owner).toBe("erin");
  });

  it("an integration key may name the person it relays", async () => {
    const m = memoryDeps();
    const core = createCore(m.deps);
    const out = await core.execute("createTask", key, { ask: "Add CSV export\nwith headers", repo: null, requestedBy: "dana" });
    expect(out).toEqual({ issueUrl: "https://github.example/acme/app/issues/100", repo: "acme/app", issueNumber: 100 });
    expect(m.codeHost.issues[0]?.title).toBe("Add CSV export");
    expect(m.codeHost.issues[0]?.body).toContain("Asked by @dana in the factory app");
    expect(m.runner.signals[0]).toMatchObject({ type: "issue_labeled", issueNumber: 100, actor: { login: "dana" } });
  });
});

describe("audit", () => {
  it("records every write and refusal with the actor, but not reads", async () => {
    const m = await withPeople();
    const core = createCore(m.deps);
    await core.execute("listTasks", user("erin"), {});
    await core.execute("cancelTask", user("erin", true), { id: "task_a1" });
    await code(core.execute("setOrg", user("erin"), { name: "x" }));
    await code(core.execute("getTask", user("erin"), { id: "task_zz" }));
    expect(m.audit.entries.map((e) => `${e.capability} ${e.actor} ${e.agent ?? "-"} ${e.target ?? "-"} ${e.outcome}`)).toEqual([
      "getTask user:erin - task_zz TASK_NOT_FOUND",
      "setOrg user:erin - - FORBIDDEN",
      "cancelTask user:erin claude-code task_a1 ok",
    ]);
    expect(m.audit.entries[2]?.via).toBe("key:factory-api");
  });
});

describe("task rules", () => {
  it("approves only a PR in review, posting on the PR first", async () => {
    const m = await withPeople();
    const core = createCore(m.deps);
    expect(await code(core.execute("approveTask", user("erin"), { id: "task_a1" }))).toBe("TASK_NOT_REVIEWABLE");
    m.tasks.put(taskRecord({ id: "task_b2", status: "awaiting_review", pr: { number: 7, url: "u", headSha: "abcdef1234" } }));
    await core.execute("approveTask", user("erin"), { id: "task_b2", note: "LGTM" });
    expect(m.codeHost.comments[0]?.markdown).toBe("**@erin** approved `abcdef1` in the factory app.\n\nLGTM");
    expect(m.runner.signals[0]).toMatchObject({ type: "pr_approved", prNumber: 7, via: "app" });
  });

  it("refuses repos the factory doesn't work in", async () => {
    const core = createCore(memoryDeps().deps);
    expect(await code(core.execute("createTask", key, { ask: "do it", repo: "other/repo", requestedBy: "dana" }))).toBe("REPO_NOT_CONNECTED");
  });

  it("rollouts: a share needs a candidate; unknown factories are not found", async () => {
    const core = createCore(memoryDeps().deps);
    expect(await code(core.execute("setRollout", key, { factory: "default", live: "fv_1", candidate: null, share: 0.5, note: null }))).toBe("INVALID_REQUEST");
    expect(await code(core.execute("setRollout", key, { factory: "nope", live: null, candidate: null, share: 0, note: null }))).toBe("FACTORY_NOT_FOUND");
    const r = await core.execute("setRollout", key, { factory: "default", live: "fv_1", candidate: "fv_2", share: 0.1, note: null });
    expect(r.rollout).toMatchObject({ live: "fv_1", candidate: "fv_2", share: 0.1, updatedBy: "api" });
  });

  it("factories as code: with a definitions repo, saving a factory proposes a PR and changes nothing yet", async () => {
    const definitions = new MemoryDefinitions();
    const m = memoryDeps({ definitions });
    const core = createCore(m.deps);
    const input = { slug: "payments", extends: "default", description: "Money rules", scorers: ["ledger-balances"], benchmarks: [], world: null, mergeRisk: null };
    const r = await core.execute("saveFactory", user("ada"), input);
    expect(r.proposal).toEqual({ number: 1, url: "https://github.com/acme/factory/pull/1" });
    expect(definitions.proposed[0]).toMatchObject({ by: "ada", def: { slug: "payments", scorers: ["ledger-balances"] } });
    expect(await m.org.factories()).toEqual([]);
    definitions.down = true;
    const failed = await core.execute("saveFactory", user("ada"), input).catch((e: unknown) => e);
    expect(failed instanceof Failure && failed.error).toMatchObject({ code: "CODE_HOST_UNAVAILABLE", repo: "acme/factory" });
    // Without a definitions repo it's saved straight away.
    const direct = createCore(memoryDeps().deps);
    expect((await direct.execute("saveFactory", user("ada"), input)).proposal).toBeNull();
  });

  it("egress: unknown tasks are skipped and a repeated window counts once", async () => {
    const m = await withPeople();
    const core = createCore(m.deps);
    const entry = { taskId: "task_a1", host: "evil.example", allowed: false, count: 3, from: "a", to: "b" };
    expect(await core.execute("postEgress", key, { entries: [entry, { ...entry, taskId: "task_zz" }, { ...entry, taskId: "not a task" }] })).toEqual({ recorded: 1 });
    expect(await core.execute("postEgress", key, { entries: [entry] })).toEqual({ recorded: 0 });
  });
});
