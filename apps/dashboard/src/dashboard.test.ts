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
function fakeServer(tasks: TaskRecord[], events: Record<string, LedgerEvent[]> = {}, health: unknown = { at: "t", ok: true, checks: [] }) {
  const posted: string[] = [];
  const cancelled: Array<{ id: string; body: unknown }> = [];
  const retried: Array<{ id: string; body: unknown }> = [];
  const s = new Hono();
  s.get("/v1/health", (c) => c.json({ health }));
  s.post("/v1/tasks/:id/retry", async (c) => {
    retried.push({ id: c.req.param("id"), body: await c.req.json() });
    return c.json({ task: tasks.find((y) => y.id === c.req.param("id"))! });
  });
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
  const teams = [
    { slug: "core", name: "Core", source: "config", members: [{ login: "dana", name: null, role: "maintainer" }, { login: "li", name: null, role: "member" }], repos: ["acme/app"], factory: "default" },
    { slug: "payments", name: "Payments", source: "config", members: [{ login: "omar", name: null, role: "member" }], repos: ["acme/pay"], factory: "payments" },
  ];
  s.get("/v1/teams", (c) => c.json({ teams }));
  const views: Array<Record<string, unknown>> = [];
  const rollouts: Record<string, Record<string, unknown>> = {};
  s.get("/v1/factories", (c) => c.json({
    factories: [
      { slug: "default", extends: null, description: "Org default", scorers: [], benchmarks: [], world: null, mergeRisk: null, teams: ["core"] },
      { slug: "payments", extends: "default", description: null, scorers: ["ledger-balances"], benchmarks: ["payments-core"], world: "payments-30d", mergeRisk: { riskyPaths: ["src/money/"] }, teams: ["payments"] },
    ],
    rollouts: Object.values(rollouts),
  }));
  s.get("/v1/rollout/:f", (c) => c.json({ rollout: rollouts[c.req.param("f")] ?? null, history: [] }));
  s.post("/v1/rollout/:f", async (c) => {
    const b = await c.req.json();
    const r = { factory: c.req.param("f"), live: b.live, candidate: b.candidate, share: b.share, updatedBy: b.by, updatedAt: "2026-11-13T00:00:00Z", note: b.note ?? null };
    rollouts[c.req.param("f")] = r;
    return c.json({ rollout: r });
  });
  s.get("/v1/views", (c) => c.json({ views: views.filter((v) => v.owner === c.req.query("viewer") || v.share === "org") }));
  s.get("/v1/views/:id", (c) => { const v = views.find((x) => x.id === c.req.param("id")); return v ? c.json({ view: v }) : c.json({ message: "no" }, 404); });
  s.post("/v1/views", async (c) => {
    const b = await c.req.json();
    const v = { id: `view_${views.length + 1}`, createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z", ...b, team: b.share === "team" ? b.team : null };
    views.push(v);
    return c.json({ view: v });
  });
  s.post("/v1/tasks/:id/messages", async (c) => {
    posted.push(`msg:${c.req.param("id")}:${(await c.req.json()).text}`);
    return c.json({ task: tasks.find((y) => y.id === c.req.param("id")), url: "https://github.com/acme/app/pull/2#c" });
  });
  s.post("/v1/tasks", async (c) => {
    const b = await c.req.json();
    posted.push(`new:${b.requestedBy}:${b.repo}:${b.ask}`);
    return c.json({ issueUrl: "https://github.com/acme/app/issues/9", repo: b.repo ?? "acme/app", issueNumber: 9 }, 202);
  });
  s.get("/v1/bench/tasks", (c) => c.json({ tasks: [] }));
  s.get("/v1/bench/runs", (c) => c.json({ runs: [] }));
  const api = new FactoryApi({ baseUrl: "http://factory.test", token: null, fetch: (i, init) => Promise.resolve(s.fetch(new Request(i, init))) });
  return { api, posted, cancelled, retried };
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
    const res = await app.request("/tasks?days=0", { headers: { authorization: `Basic ${btoa("factory:pw")}` } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Task &lt;b&gt;task_a&lt;/b&gt;");
    expect(html).toContain("1 of 1 tasks in scope");
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
    expect((await app.request("/versions")).headers.get("location")).toBe("/factories/default");
    expect(await (await app.request("/factories/default")).text()).toContain("fv_1");
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
    expect((await app.request("/activity")).headers.get("location")).toBe("/");
    const home = await (await app.request("/")).text();
    expect(home).toContain("Review the PR");
    expect(home).toContain("Agents working <span class=\"n\">1</span>");
    expect(home).toContain('http-equiv="refresh"');
    const open = await (await app.request("/tasks?state=open&days=0")).text();
    expect(open).toContain("Busy");
    expect(open).not.toContain("Task &lt;b&gt;task_a");
    const q = await (await app.request("/tasks?q=needs&days=0")).text();
    expect(q).toContain("1 of 3 tasks in scope");
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
    expect((await app.request("/metrics?days=7")).headers.get("location")).toBe("/insights");
    const html = await (await app.request("/overview?days=7")).text();
    expect(html).toContain("Autonomy");
    expect(html).toContain("1 of 1 merged PRs had no human commit");
    expect(html).toContain("1h 0m"); // kickoff → PR
    expect(html).toContain("2h 0m"); // PR → first review
    expect(html).toContain("+30 −5");
    expect(html).toContain("Cost by PR size");
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
    expect(page).toContain("Did it"); // the agent's turn summary is in the conversation
  });

  it("task banners follow the current state: an old stop disappears once the task runs again", async () => {
    const ev = (type: string, at: string, data: Record<string, unknown>): LedgerEvent => ({ taskId: "task_r", at, type, data });
    const { api } = fakeServer([t("task_r", { status: "awaiting_review" })], {
      task_r: [
        ev("cancelled", "2026-11-13T00:01:00Z", { by: "lead", reason: "duplicate of #130" }),
        ev("status_changed", "2026-11-13T00:01:00Z", { from: "working", to: "failed", reason: "cancelled" }),
        ev("error", "2026-11-13T00:02:00Z", { stage: "review gate", message: "No evidence attached." }),
        ev("status_changed", "2026-11-13T00:03:00Z", { from: "failed", to: "iterating" }),
        ev("status_changed", "2026-11-13T00:09:00Z", { from: "iterating", to: "awaiting_review" }),
      ],
    });
    const page = await (await createDashboard(api, { password: null, models: ["a", "b"] }).request("/tasks/task_r")).text();
    expect(page).not.toContain("Stopped by lead");
    expect(page).not.toContain("Last error.");
    expect(page).not.toContain(`class="alert bad"`);
    expect(page).not.toContain(">Retry<");
  });

  it("a failed task says what kind of failure it was and what to do, and Retry asks the server", async () => {
    const ev = (type: string, at: string, data: Record<string, unknown>): LedgerEvent => ({ taskId: "task_f", at, type, data });
    const { api, retried } = fakeServer([t("task_f", { status: "failed" })], {
      task_f: [
        ev("error", "2026-11-13T00:02:00Z", { stage: "agent turn", message: "There's an issue with the selected model (claude-sonnet).", kind: "setup", fix: "Add claude-sonnet to the gateway key's models." }),
        ev("status_changed", "2026-11-13T00:02:00Z", { from: "working", to: "failed", reason: "agent turn" }),
      ],
    });
    const app = createDashboard(api, { password: null, models: ["a", "b"] });
    const page = await (await app.request("/tasks/task_f")).text();
    expect(page).toContain("Stopped by a setup problem.");
    expect(page).toContain("Add claude-sonnet to the gateway key&#39;s models.");
    expect(page).toContain("/tasks/task_f/retry");
    const inbox = await (await app.request("/")).text();
    expect(inbox).toContain("Stopped by a setup problem while agent turn. Fix the setup, then retry.");
    const res = await app.request("/tasks/task_f/retry", { method: "POST", body: new URLSearchParams({}) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/tasks/task_f?msg=Retrying");
    expect(retried).toEqual([{ id: "task_f", body: { by: "dashboard" } }]);
  });

  it("every page warns while a start-up check fails", async () => {
    const { api } = fakeServer([], {}, { at: "t", ok: false, checks: [{ name: "model gateway", ok: false, detail: "unreachable or refused the key: status 401", fix: "Check MODEL_PROXY_KEY." }] });
    const page = await (await createDashboard(api, { password: null, models: ["a", "b"] }).request("/tasks")).text();
    expect(page).toContain("isn&#39;t set up to finish tasks");
    expect(page).toContain("Check MODEL_PROXY_KEY.");
  });

  it("factory pages show agents, prompts, providers and rules; the font is served", async () => {
    const { api } = fakeServer([]);
    const app = createDashboard(api, { password: null, models: ["a", "b"], factoryName: "acme" });
    expect((await app.request("/factory")).headers.get("location")).toBe("/factories/default");
    const agents = await (await app.request("/agents")).text();
    expect(agents).toContain("implementation");
    expect(agents).toContain("claude-code");
    expect(agents).toContain("fv_1"); // sidebar version
    expect(await (await app.request("/agents/implementation")).text()).toContain("You are &lt;the&gt; agent");
    expect(await (await app.request("/agents/implementation?prompt=review")).text()).toContain(">r</pre>");
    expect((await app.request("/agents/nope")).status).toBe(404);
    expect(await (await app.request("/apps")).text()).toContain("s3");
    expect(await (await app.request("/automations")).text()).toContain("factory.yaml");
    expect((await app.request("/secrets")).status).toBe(200);
    expect((await app.request("/environments")).status).toBe(200);
    const font = await app.request("/assets/mona-sans.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(10_000);
  });

  const ev = (id: string, type: string, at: string, data: Record<string, unknown>): LedgerEvent => ({ taskId: id, at, type, data });
  const cookie = { cookie: "of_user=dana" };

  it("scopes every page to org, team or person, and the inbox defaults to the viewer", async () => {
    const { api } = fakeServer([
      t("task_d", { requestedBy: "dana", title: "Dana's review", status: "awaiting_review" }),
      t("task_o", { requestedBy: "omar", title: "Omar's review", status: "awaiting_review", source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "pay" }, issueNumber: 3, url: null } }),
    ]);
    const app = createDashboard(api, { password: null, models: ["a", "b"], now: () => "2026-11-13T12:00:00Z" });
    const signin = await app.request("/signin", { method: "POST", body: new URLSearchParams({ login: "dana", back: "/" }) });
    expect(signin.headers.get("set-cookie")).toContain("of_user=dana");
    const mine = await (await app.request("/", { headers: cookie })).text();
    expect(mine).toContain("Dana&#39;s review");
    expect(mine).not.toContain("Omar&#39;s review");
    expect(mine).toContain("Signed in as");
    const org = await (await app.request("/?scope=org", { headers: cookie })).text();
    expect(org).toContain("Omar&#39;s review");
    const team = await (await app.request("/tasks?scope=team:payments&days=0", { headers: cookie })).text();
    expect(team).toContain("Omar&#39;s review");
    expect(team).not.toContain("Dana&#39;s review");
    expect(team).toContain("Payments"); // breadcrumb
    expect((await (await app.request("/teams")).text())).toContain("Payments");
    const tp = await (await app.request("/teams/payments")).text();
    expect(tp).toContain("payments-30d");
    expect(tp).toContain("omar");
    expect(await (await app.request("/people/dana")).text()).toContain("Dana&#39;s review");
  });

  it("insights measures came-back by kind and every number opens its tasks; views save", async () => {
    const { api } = fakeServer([
      t("task_r", { title: "Fix refund rounding", outcomes: [{ kind: "merged", source: "github", detail: "merge abc1234", at: "2026-11-01T00:00:00Z", arrivedAt: "2026-11-01T00:00:00Z" }, { kind: "reverted", source: "github", detail: "reverted by PR #9", at: "2026-11-03T00:00:00Z", arrivedAt: "2026-11-03T00:00:00Z" }] }),
      t("task_ok", { title: "Add the usage page" }),
    ]);
    const app = createDashboard(api, { password: null, models: ["a", "b"], now: () => "2026-11-13T12:00:00Z" });
    const html = await (await app.request("/insights?scope=org&days=30&measure=came_back&by=kind", { headers: cookie })).text();
    expect(html).toContain("Came back after merge, by kind of task");
    expect(html).toContain("50%");
    expect(html).toContain("/tasks?scope=org&amp;days=30&amp;kind=Bug+fixes&amp;state=came_back");
    const back = await (await app.request("/tasks?scope=org&days=30&kind=Bug+fixes&state=came_back")).text();
    expect(back).toContain("Fix refund rounding");
    expect(back).not.toContain("Add the usage page");
    const saved = await app.request("/views", { method: "POST", headers: cookie, body: new URLSearchParams({ name: "What came back", path: "/insights?scope=org&measure=came_back&by=kind", share: "team:core" }) });
    expect(decodeURIComponent(saved.headers.get("location") ?? "")).toContain('Saved "What came back" for the core team.');
    expect((await app.request("/views/view_1")).headers.get("location")).toBe("/insights?scope=org&measure=came_back&by=kind&view=view_1");
  });

  it("task page has the conversation, a review panel with risk, test users and the world check, and sends messages", async () => {
    const { api, posted } = fakeServer([
      t("task_v", {
        status: "awaiting_review",
        requestedBy: "dana",
        pr: { number: 7, url: "https://github.com/acme/app/pull/7", headSha: "h2" },
        risk: { level: "medium", reasons: ["Touches billing UI."], headSha: "h2" },
        evidence: [{ kind: "test-user", title: "Free plan, 85% used", url: "https://env/login?u=1", commitSha: "h2", environment: "devspace:task-v", createdAt: "2026-11-13T00:00:00Z", testUser: { role: "free user", state: "Free plan, 85% used", loginUrl: "https://env/login?u=1" } }],
        worldChecks: [{ world: "core-30d", headSha: "h2", simDays: 30, status: "passed", startedAt: "2026-11-13T00:00:00Z", finishedAt: "2026-11-13T00:03:00Z", invariants: [], metrics: [], reportUrl: null }],
      }),
    ], { task_v: [ev("task_v", "message_received", "2026-11-13T01:00:00Z", { author: "li", text: "Use the design-system bar", url: null })] });
    const app = createDashboard(api, { password: null, models: ["a", "b"], now: () => "2026-11-13T12:00:00Z" });
    const page = await (await app.request("/tasks/task_v", { headers: cookie })).text();
    expect(page).toContain("Waiting for your review");
    expect(page).toContain("risk medium");
    expect(page).toContain("Open as this user");
    expect(page).toContain("30 days in core-30d");
    expect(page).toContain("Use the design-system bar");
    const sent = await app.request("/tasks/task_v/messages", { method: "POST", headers: cookie, body: new URLSearchParams({ text: "Rename the button" }) });
    expect(sent.status).toBe(303);
    expect(posted).toContain("msg:task_v:Rename the button");
    const created = await app.request("/tasks/new", { method: "POST", headers: cookie, body: new URLSearchParams({ ask: "Add CSV export", repo: "" }) });
    expect(decodeURIComponent(created.headers.get("location") ?? "")).toContain("acme/app#9");
    expect(posted).toContain("new:dana:null:Add CSV export");
  });

  it("factories list team factories, and a trial, promotion and rollback go through the rollout API", async () => {
    const { api } = fakeServer([t("task_a"), t("task_b", { factoryVersion: "fv_0", createdAt: "2026-11-01T00:00:00Z" })]);
    const app = createDashboard(api, { password: null, models: ["a", "b"], now: () => "2026-11-13T12:00:00Z" });
    const list = await (await app.request("/factories")).text();
    expect(list).toContain("payments");
    expect(list).toContain("world payments-30d");
    const anon = await app.request("/factories/default/rollout", { method: "POST", body: new URLSearchParams({ live: "fv_1", candidate: "fv_2", share: "0.1" }) });
    expect(anon.headers.get("location")).toContain("/signin");
    const trial = await app.request("/factories/default/rollout", { method: "POST", headers: cookie, body: new URLSearchParams({ live: "fv_1", candidate: "fv_2", share: "0.1", note: "trial" }) });
    expect(decodeURIComponent(trial.headers.get("location") ?? "")).toContain("fv_2 now gets 10% of new tasks.");
    const page = await (await app.request("/factories/default", { headers: cookie })).text();
    expect(page).toContain("Promote fv_2");
    expect(page).toContain("Roll back to fv_0");
  });
});
