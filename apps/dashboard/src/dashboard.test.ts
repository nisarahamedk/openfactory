import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { TaskRecord } from "@openfactory/contracts";
import { FactoryApi } from "@openfactory/client";
import { createDashboard } from "./app.js";
import { rollup } from "./stats.js";

const t = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  factoryVersion: "fv_1",
  source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 1, url: "https://github.com/acme/app/issues/1" },
  title: `Task <b>${id}</b>`,
  ask: "do it",
  status: "merged",
  harness: { name: "claude-code", model: "sonnet" },
  harnessSessionId: null,
  environment: null,
  workspace: null,
  branch: null,
  pr: { number: 2, url: "https://github.com/acme/app/pull/2", headSha: null },
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 2 },
  people: { comments: 0, reviewRounds: 1 },
  evidence: [],
  scores: [{ scorer: "facts.ci_first_pass", scorerVersion: "1", value: 1, label: "pass", reason: "", at: "2026-11-13T00:00:00Z" }],
  outcomes: [],
  createdAt: "2026-11-13T00:00:00Z",
  updatedAt: "2026-11-13T00:00:00Z",
  ...over,
});

/** A stand-in factory server with the /v1 shapes the dashboard reads. */
function fakeServer(tasks: TaskRecord[]) {
  const posted: string[] = [];
  const s = new Hono();
  s.get("/v1/tasks", (c) => c.json({ tasks }));
  s.get("/v1/tasks/:id", (c) => {
    const x = tasks.find((y) => y.id === c.req.param("id"));
    return x === undefined ? c.json({ message: "not found" }, 404) : c.json(x);
  });
  s.get("/v1/tasks/:id/events", (c) => c.json([{ taskId: c.req.param("id"), at: "2026-11-13T00:01:00Z", type: "status_changed", data: { from: "received", to: "working" } }]));
  s.post("/v1/tasks/:id/benchmark", (c) => {
    posted.push(c.req.param("id"));
    if (c.req.param("id") === "task_open") return c.json({ code: "TASK_NOT_MERGED", message: "task is working" }, 409);
    return c.json({ task: { id: "bench_x", sourceTaskId: c.req.param("id"), repo: { host: "github", owner: "acme", name: "app" }, startCommit: "abc", ask: "a", check: { kind: "command", command: ["true"], files: {} }, createdAt: "2026-11-13T00:00:00Z" } }, 201);
  });
  s.get("/v1/bench/tasks", (c) => c.json({ tasks: [] }));
  s.get("/v1/bench/runs", (c) => c.json({ runs: [] }));
  const api = new FactoryApi({ baseUrl: "http://factory.test", token: null, fetch: (i, init) => Promise.resolve(s.fetch(new Request(i, init))) });
  return { api, posted };
}

describe("dashboard", () => {
  it("rollup divides spend by merged changes only", () => {
    const r = rollup([t("task_a"), t("task_b", { status: "failed", pr: null })]);
    expect(r.totalCostUsd).toBe(4);
    expect(r.costPerMergedUsd).toBe(4);
    expect(r.meanReviewRounds).toBe(1);
  });

  it("renders tasks with escaped titles and requires the password", async () => {
    const { api } = fakeServer([t("task_a")]);
    const app = createDashboard(api, { password: "pw", models: ["a", "b"] });
    expect((await app.request("/")).status).toBe(401);
    const res = await app.request("/", { headers: { authorization: `Basic ${btoa("factory:pw")}` } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Task &lt;b&gt;task_a&lt;/b&gt;");
    expect(html).toContain("cost per merged change");
  });

  it("task page shows timeline; add-to-benchmark redirects with a message, including refusals", async () => {
    const { api, posted } = fakeServer([t("task_a"), t("task_open", { status: "working" })]);
    const app = createDashboard(api, { password: null, models: ["a", "b"] });
    expect(await (await app.request("/tasks/task_a")).text()).toContain("received → working");
    const ok = await app.request("/tasks/task_a/benchmark", { method: "POST" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toContain("Added%20bench_x");
    const refused = await app.request("/tasks/task_open/benchmark", { method: "POST" });
    expect(refused.headers.get("location")).toContain("task%20is%20working");
    expect(posted).toEqual(["task_a", "task_open"]);
    expect((await app.request("/tasks/nope")).status).toBe(404);
  });

  it("bench and versions pages render against an empty suite", async () => {
    const { api } = fakeServer([t("task_a")]);
    const app = createDashboard(api, { password: null, models: ["a", "b"] });
    expect(await (await app.request("/bench")).text()).toContain("Empty.");
    expect(await (await app.request("/versions")).text()).toContain("fv_1");
  });

  it("shows a readable error page when the server is down", async () => {
    const api = new FactoryApi({ baseUrl: "http://127.0.0.1:1", token: null });
    const res = await createDashboard(api, { password: null, models: ["a", "b"] }).request("/");
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("factory server unreachable");
  });
});
