import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@openfactory/contracts";
import { createDxFakeApp, DxFakeOutcomeSource, DxFakeSink, DxStore } from "./index.js";

const TOKEN = "test-token-0123456789";

function setup() {
  const store = new DxStore(null);
  const app = createDxFakeApp(store, TOKEN);
  const fetchVia: typeof fetch = (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
  const cfg = { baseUrl: "http://dx.test", token: TOKEN, fetch: fetchVia };
  const call = (path: string, body: unknown, token = TOKEN) =>
    app.fetch(
      new Request(`http://dx.test${path}`, {
        method: body === null ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === null ? null : JSON.stringify(body),
      }),
    );
  return { store, cfg, call };
}

const rec = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  factoryVersion: "fv_a",
  source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 3, url: null },
  title: "t",
  ask: "a",
  status: "merged",
  harness: { name: "claude-code", model: "sonnet" },
  harnessSessionId: null,
  environment: null,
  workspace: null,
  branch: null,
  pr: { number: 12, url: "https://github.com/acme/app/pull/12", headSha: "abc" },
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
  people: { comments: 1, reviewRounds: 1 },
  evidence: [],
  scores: [
    { scorer: "facts.ci_first_pass", scorerVersion: "1", value: 1, label: "pass", reason: "", at: "2026-11-13T00:00:00Z" },
  ],
  outcomes: [],
  createdAt: "2026-11-13T00:00:00Z",
  updatedAt: "2026-11-13T01:00:00Z",
  ...over,
});

describe("fake DX", () => {
  it("rejects calls without the token", async () => {
    const { call } = setup();
    expect((await call("/api/customTables.list", null, "nope")).status).toBe(401);
  });

  it("sink upserts one row per task; a second write updates instead of duplicating", async () => {
    const { cfg, call } = setup();
    const sink = new DxFakeSink(cfg);
    await sink.writeTasks([rec("task_a", { status: "awaiting_review" }), rec("task_b")]);
    await sink.writeTasks([rec("task_a")]);
    const res = await call("/api/sql", {
      sql: "SELECT task_id, status, ci_first_pass FROM custom.factory_tasks WHERE repo = $1 ORDER BY task_id",
      params: ["acme/app"],
    });
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([
      { task_id: "task_a", status: "merged", ci_first_pass: true },
      { task_id: "task_b", status: "merged", ci_first_pass: true },
    ]);
  });

  it("unsupported SQL is a clear 400, not a silent no-op", async () => {
    const { call } = setup();
    const res = await call("/api/sql", { sql: "DELETE FROM custom.factory_tasks", params: [] });
    expect(res.status).toBe(400);
    const res2 = await call("/api/sql", { sql: "SELECT * FROM custom.nothing", params: [] });
    expect(res2.status).toBe(404);
  });

  it("incidents linked to a task's PR come back as late outcomes, once", async () => {
    const { cfg, call } = setup();
    await call("/api/incidents.upsert", {
      id: "inc_1", title: "checkout 500s", severity: "sev2", startedAt: "2026-11-14T00:00:00Z", resolvedAt: null,
      linkedPrs: ["acme/app#12"],
    });
    await call("/api/incidents.upsert", {
      id: "inc_2", title: "other", severity: "sev3", startedAt: "2026-11-14T00:00:00Z", resolvedAt: null, linkedPrs: ["acme/app#99"],
    });
    const src = new DxFakeOutcomeSource(cfg);
    const outs = await src.outcomesFor(rec("task_a"), "2026-11-15T00:00:00Z");
    expect(outs.map((o) => o.kind)).toEqual(["incident_linked"]);
    expect(await src.outcomesFor(rec("task_a", { outcomes: outs }), "2026-11-15T00:00:00Z")).toEqual([]);
  });

  it("attributes incidents and deploys to a task by its merge sha", async () => {
    const { cfg, call } = setup();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const merged = { kind: "merged" as const, source: "github", detail: `merge ${sha}`, at: "2026-11-13T10:00:00Z", arrivedAt: "2026-11-13T10:00:00Z" };
    await call("/api/incidents.upsert", {
      id: "inc_9", title: "latency", severity: "sev2", startedAt: "2026-11-14T00:00:00Z", resolvedAt: null, linkedPrs: [], commitShas: [sha.slice(0, 7)],
    });
    for (const [id, env, at, success] of [["d1", "staging", "2026-11-13T11:00:00Z", true], ["d2", "production", "2026-11-13T12:00:00Z", false], ["d3", "production", "2026-11-13T13:00:00Z", true], ["d4", "production", "2026-11-13T14:00:00Z", true]] as const) {
      await call("/api/deployments.create", { id, service: "web", environment: env, commitSha: sha, repo: "acme/app", deployedAt: at, success });
    }
    await call("/api/deployments.create", { id: "d5", service: "web", environment: "production", commitSha: "fff0000", repo: "acme/app", deployedAt: "2026-11-13T15:00:00Z", success: true });
    const src = new DxFakeOutcomeSource(cfg);
    const found = await src.poll([{ record: rec("task_a", { outcomes: [merged] }), mergeSha: sha, mergedAt: merged.at }], "2026-11-15T00:00:00Z");
    expect(found.map((f) => [f.ref, f.outcome.kind, f.outcome.at])).toEqual([
      ["incident:inc_9", "incident_linked", "2026-11-14T00:00:00Z"],
      ["deploy:staging", "deployed", "2026-11-13T11:00:00Z"],
      ["deploy:production", "deployed", "2026-11-13T13:00:00Z"],
    ]);
  });
});
