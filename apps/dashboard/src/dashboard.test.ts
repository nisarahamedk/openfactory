import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { LedgerEvent, TaskRecord } from "@openfactory/contracts";
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
function fakeServer(tasks: TaskRecord[], events: Record<string, LedgerEvent[]> = {}) {
  const posted: string[] = [];
  const cancelled: Array<{ id: string; body: unknown }> = [];
  const s = new Hono();
  s.get("/v1/factory", (c) =>
    c.json({
      factory: {
        version: "fv_1",
        providersFrom: "factory.yaml",
        providers: { agent: { name: "acp", options: {} }, evidence: { name: "s3", options: { bucket: "ev" } } },
        agent: { name: "claude-code", model: "sonnet" },
        foreman: { model: "haiku" },
        rules: { label: "factory", maxTaskUsd: 5, maxReviewRounds: 3, maxNudges: 2 },
        prompts: { system: "You are <the> agent", intake: "i", review: "r", foreman: "f" },
      },
    }),
  );
  s.post("/v1/tasks/:id/cancel", async (c) => {
    cancelled.push({ id: c.req.param("id"), body: await c.req.json() });
    return c.json({ task: { ...tasks.find((y) => y.id === c.req.param("id"))!, status: "failed" } });
  });
  s.get("/evidence/:id/:key", (c) =>
    c.req.param("key") === "transcript-1.jsonl"
      ? c.text([{ at: "2026-11-13T00:01:00Z", kind: "prompt", text: "do it" }, { at: "2026-11-13T00:01:01Z", kind: "message", text: "Hello <script>" }, { at: "2026-11-13T00:01:02Z", kind: "tool_call", title: "pnpm test", status: "failed" }].map((l) => JSON.stringify(l)).join("\n"))
      : c.text("nope", 404),
  );
  s.get("/v1/tasks", (c) => c.json({ tasks }));
  s.get("/v1/tasks/:id", (c) => {
    const x = tasks.find((y) => y.id === c.req.param("id"));
    return x === undefined ? c.json({ message: "not found" }, 404) : c.json(x);
  });
  s.get("/v1/tasks/:id/events", (c) => c.json(events[c.req.param("id")] ?? [{ taskId: c.req.param("id"), at: "2026-11-13T00:01:00Z", type: "status_changed", data: { from: "received", to: "working" } }]));
  s.post("/v1/tasks/:id/benchmark", (c) => {
    posted.push(c.req.param("id"));
    if (c.req.param("id") === "task_open") return c.json({ code: "TASK_NOT_MERGED", message: "task is working" }, 409);
    return c.json({ task: { id: "bench_x", sourceTaskId: c.req.param("id"), repo: { host: "github", owner: "acme", name: "app" }, startCommit: "abc", ask: "a", check: { kind: "command", command: ["true"], files: {} }, createdAt: "2026-11-13T00:00:00Z" } }, 201);
  });
  s.get("/v1/bench/tasks", (c) => c.json({ tasks: [] }));
  s.get("/v1/bench/runs", (c) => c.json({ runs: [] }));
  const api = new FactoryApi({ baseUrl: "http://factory.test", token: null, fetch: (i, init) => Promise.resolve(s.fetch(new Request(i, init))) });
  return { api, posted, cancelled };
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
    const res = await app.request("/runs", { headers: { authorization: `Basic ${btoa("factory:pw")}` } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Task &lt;b&gt;task_a&lt;/b&gt;");
    expect(html).toContain("1 of 1 runs");
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

  it("home lists what waits on a person, and runs filter by status and search", async () => {
    const { api } = fakeServer([
      t("task_a"),
      t("task_rev", { status: "awaiting_review", title: "Needs review", pr: { number: 7, url: "https://github.com/acme/app/pull/7", headSha: "h1" } }),
      t("task_w", { status: "working", title: "Busy", pr: null }),
    ]);
    const app = createDashboard(api, { password: null, models: ["a", "b"], now: () => "2026-11-13T12:00:00Z" });
    const home = await (await app.request("/")).text();
    expect(home).toContain("PR review");
    expect(home).toContain("PR #7 is waiting for review.");
    expect(home).toContain("Running now (1)");
    expect(home).toContain('http-equiv="refresh"');
    const open = await (await app.request("/runs?status=open")).text();
    expect(open).toContain("Busy");
    expect(open).not.toContain("task_a</div>");
    const q = await (await app.request("/runs?q=needs")).text();
    expect(q).toContain("1 of 3 runs");
  });

  it("metrics page renders autonomy, cycle time, cost by size and outcomes", async () => {
    const ev = (type: string, at: string, data: Record<string, unknown>): LedgerEvent => ({ taskId: "task_a", at, type, data });
    const { api } = fakeServer([t("task_a", { createdAt: "2026-11-12T00:00:00Z" })], {
      task_a: [
        ev("pr_opened", "2026-11-12T01:00:00Z", { number: 2 }),
        ev("pr_stats", "2026-11-12T01:00:00Z", { headSha: "h", additions: 30, deletions: 5, changedFiles: 3 }),
        ev("comment_received", "2026-11-12T03:00:00Z", { author: "dana", isBot: false, on: "pr" }),
        ev("status_changed", "2026-11-12T04:00:00Z", { from: "awaiting_review", to: "merged" }),
      ],
    });
    const app = createDashboard(api, { password: null, models: ["a", "b"], now: () => "2026-11-13T12:00:00Z" });
    const html = await (await app.request("/metrics?days=7")).text();
    expect(html).toContain("autonomy: merged with no human commit");
    expect(html).toContain("1h 0m"); // kickoff → PR
    expect(html).toContain("2h 0m"); // PR → first review
    expect(html).toContain("+30 −5");
    expect(html).toContain("Cost per PR by size");
    expect(html).toContain("<svg");
  });

  it("task page shows turns with a transcript link, renders the session escaped, and stops a task", async () => {
    const ev = (type: string, at: string, data: Record<string, unknown>): LedgerEvent => ({ taskId: "task_w", at, type, data });
    const { api, cancelled } = fakeServer([t("task_w", { status: "working" })], {
      task_w: [
        ev("turn_started", "2026-11-13T00:01:00Z", { reason: "intake" }),
        ev("turn_finished", "2026-11-13T00:05:00Z", { reason: "intake", usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.42 }, stopReason: "end_turn", summary: "Did it" }),
        ev("transcript_saved", "2026-11-13T00:05:00Z", { turn: 1, key: "transcript-1.jsonl", url: "x", lines: 3 }),
        ev("pushed", "2026-11-13T00:06:00Z", { sha: "abcdef0", byFactory: false }),
        ev("egress", "2026-11-13T00:06:00Z", { host: "evil.example", allowed: false, count: 2, from: "a", to: "b" }),
      ],
    });
    const app = createDashboard(api, { password: null, models: ["a", "b"] });
    const page = await (await app.request("/tasks/task_w")).text();
    expect(page).toContain("$0.42");
    expect(page).toContain("/tasks/task_w/transcripts/transcript-1.jsonl");
    expect(page).toContain("evil.example");
    expect(page).toContain("abcdef0 by a person");
    expect(page).toContain("Stop task");
    const session = await (await app.request("/tasks/task_w/transcripts/transcript-1.jsonl")).text();
    expect(session).toContain("Hello &lt;script&gt;");
    expect(session).toContain("pnpm test");
    expect((await app.request("/tasks/task_w/transcripts/..%2Fsecrets")).status).toBe(404);
    const stop = await app.request("/tasks/task_w/cancel", { method: "POST", body: new URLSearchParams({ reason: "wrong ask" }) });
    expect(stop.status).toBe(303);
    expect(cancelled).toEqual([{ id: "task_w", body: { by: "dashboard", reason: "wrong ask" } }]);
  });

  it("factory page shows providers, rules and prompts", async () => {
    const { api } = fakeServer([]);
    const html = await (await createDashboard(api, { password: null, models: ["a", "b"] }).request("/factory")).text();
    expect(html).toContain("factory.yaml");
    expect(html).toContain("s3");
    expect(html).toContain("You are &lt;the&gt; agent");
  });
});
