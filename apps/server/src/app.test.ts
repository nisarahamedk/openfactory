import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fake } from "@openfactory/cloudevents";
import { contract } from "@openfactory/contract";
import { capabilities } from "@openfactory/core";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { toolName } from "./entrypoints/mcp.js";
import { testServer } from "./test-server.js";

const SHA = "b".repeat(40);
const task = (id: string, issueNumber = 1, owner = "o", name = "r") => ({
  id,
  factoryVersion: "fv",
  source: { kind: "github_issue" as const, repo: { host: "github" as const, owner, name }, issueNumber, url: null },
  title: "Add CSV export",
  ask: "a",
  harness: { name: "h", model: "m" },
});

/**
 * Every /v1 path the factory served before the contract moved to oRPC. Clients (the app, org-sim, scripts) use
 * these, so a change here is a breaking change (contracts are additive: the-stack §3.2).
 */
const SERVED_BEFORE = [
  "get /tasks", "get /tasks/{id}", "get /tasks/{id}/events", "post /tasks", "post /tasks/{id}/cancel", "post /tasks/{id}/retry", "post /tasks/{id}/approve",
  "post /tasks/{id}/messages", "get /health", "get /factory", "get /factories", "get /rollout/{factory}", "post /rollout/{factory}", "get /teams", "post /signals",
  "post /egress", "post /tasks/{id}/benchmark", "get /bench/tasks", "post /bench/runs", "get /bench/runs", "get /bench/runs/{id}", "get /views", "get /views/{id}",
  "post /views", "post /views/{id}/delete", "get /org", "post /org", "post /org/repos", "post /org/people", "post /org/people/{login}/join", "post /org/teams",
  "post /org/factories", "post /org/sources", "get /events",
];

describe("the contract", () => {
  it("keeps every path clients already use, and adds only new ones", () => {
    const served = Object.values(contract).map((p) => `${p["~orpc"].route.method?.toLowerCase()} ${p["~orpc"].route.path}`);
    expect(served.filter((r) => !SERVED_BEFORE.includes(r))).toEqual(["get /audit"]);
    expect(SERVED_BEFORE.filter((r) => !served.includes(r))).toEqual([]);
  });

  it("serves a valid OpenAPI 3.1 document behind the token, with every operation and the CloudEvents intake", async () => {
    const s = await testServer({ apiToken: "tok" });
    expect((await s.app.request("/v1/openapi.json")).status).toBe(401);
    const doc = await (await s.get("/v1/openapi.json")).json();
    const result = await new Validator().validate(doc);
    expect(result.errors ?? []).toEqual([]);
    const ops = Object.values(doc.paths as Record<string, Record<string, { operationId: string }>>).flatMap((p) => Object.values(p).map((o) => o.operationId));
    expect(ops.sort()).toEqual([...Object.keys(contract), "postEvents"].sort());
  });
});

describe("REST", () => {
  it("serves tasks, signals, egress and evidence behind the API token, with typed errors", async () => {
    const s = await testServer({ apiToken: "tok" });
    await s.ledger.createTask(task("task_a1"));
    const denied = await s.app.request("/v1/tasks");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: "UNAUTHORIZED", retryable: false });

    expect((await (await s.get("/v1/tasks")).json()).tasks[0].id).toBe("task_a1");
    expect((await s.get("/v1/tasks/task_a1/events")).status).toBe(200);
    const missing = await s.app.request("/v1/tasks/task_zz", { headers: { authorization: "Bearer tok", traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: "TASK_NOT_FOUND", message: expect.stringContaining("task_zz"), details: { taskId: "task_zz" }, requestId: "a".repeat(32), retryable: false });
    const bad = await s.get("/v1/tasks?status=bogus");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "INVALID_REQUEST", details: { fields: [{ path: "status" }] } });
    expect((await s.get("/v1/nope")).status).toBe(404);

    const sig = { id: "x", repo: { host: "github", owner: "o", name: "r" }, at: "2026-01-01T00:00:00Z", actor: { login: "n", isBot: false }, type: "issue_comment", issueNumber: 1, body: "hi" };
    expect((await s.post("/v1/signals", sig)).status).toBe(202);
    expect(s.runner.signals).toHaveLength(1);

    const egress = { entries: [{ taskId: "task_a1", host: "evil.example", allowed: false, count: 3, from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:01:00Z" }] };
    expect(await (await s.post("/v1/egress", egress)).json()).toEqual({ recorded: 1 });
    await s.post("/v1/egress", egress); // a repeated report is recorded once
    expect((await s.ledger.events("task_a1")).filter((e) => e.type === "egress")).toHaveLength(1);

    const { url } = await s.evidence.put("task_a1", "abc-shot.png", new Uint8Array([1, 2, 3]), "image/png");
    expect(url).toBe("https://f.example/evidence/task_a1/abc-shot.png");
    expect((await s.app.request("/evidence/task_a1/abc-shot.png")).headers.get("content-type")).toBe("image/png");
    expect((await s.app.request("/evidence/task_a1/..%2Fx")).status).toBe(404);
    await s.evidence.put("task_a1", "transcript-1.jsonl", new Uint8Array([123, 125]), "application/x-ndjson");
    expect((await s.app.request("/evidence/task_a1/transcript-1.jsonl")).status).toBe(401);
    const tr = await s.app.request("/evidence/task_a1/transcript-1.jsonl", { headers: { authorization: "Bearer tok" } });
    expect(tr.status).toBe(200);
    expect(tr.headers.get("cache-control")).toBe("private, no-store");
  });

  it("the person comes from the trusted client's header, and their org role limits them", async () => {
    const s = await testServer();
    await s.ledger.createTask(task("task_a1"));
    await s.post("/v1/org", { name: "Acme" }, "pat");
    await s.post("/v1/org/people", { login: "vic", persona: "vp", role: "viewer" }, "pat");
    await s.post("/v1/org/people", { login: "erin", persona: "engineer" }, "pat");
    const refused = await s.post("/v1/tasks/task_a1/cancel", {}, "vic");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "FORBIDDEN", details: { operation: "cancelTask", reason: "role" } });
    // A body can't name someone else: the canceller is erin.
    expect((await s.post("/v1/tasks/task_a1/cancel", { by: "pat" }, "erin")).status).toBe(200);
    expect(s.runner.calls).toEqual(["cancel task_a1 by erin"]);
    const audit = await (await s.get("/v1/audit", "erin")).json();
    expect(audit.entries.map((e: { capability: string; actor: string; outcome: string }) => `${e.capability} ${e.actor} ${e.outcome}`)).toEqual([
      "cancelTask user:erin ok",
      "cancelTask user:vic FORBIDDEN",
      "invitePerson user:pat ok",
      "invitePerson user:pat ok",
      "setOrg user:pat ok",
    ]);
  });

  it("teams, factories, rollouts, saved views and messages", async () => {
    const s = await testServer();
    expect((await (await s.get("/v1/teams")).json()).teams.map((t: { slug: string }) => t.slug)).toEqual(["core", "payments"]);
    const f = await (await s.get("/v1/factories")).json();
    expect(f.factories.map((x: { slug: string; teams: string[] }) => `${x.slug}:${x.teams.join(",")}`)).toEqual(["default:core", "payments:payments"]);

    expect((await s.post("/v1/rollout/payments", { live: "fv_1", candidate: "fv_2", share: 0.1 }, "omar")).status).toBe(200);
    expect((await s.post("/v1/rollout/payments", { live: "fv_1", candidate: null, share: 0.5 }, "omar")).status).toBe(400);
    expect((await s.post("/v1/rollout/nope", { live: null, candidate: null, share: 0 }, "omar")).status).toBe(404);
    await s.post("/v1/rollout/payments", { live: "fv_1", candidate: null, share: 0, note: "rolled back" }, "omar");
    const r = await (await s.get("/v1/rollout/payments")).json();
    expect(r.rollout).toMatchObject({ candidate: null, updatedBy: "omar" });
    expect(r.history[0].candidate).toBe("fv_2");

    const mine = await (await s.post("/v1/views", { name: "Mine", path: "/tasks?scope=person:dana", share: "me" }, "dana")).json();
    await s.post("/v1/views", { name: "Core's", path: "/insights?scope=team:core", share: "team", team: "core" }, "dana");
    await s.post("/v1/views", { name: "Org", path: "/insights", share: "org" }, "omar");
    expect((await s.post("/v1/views", { name: "x", path: "/insights", share: "team" }, "dana")).status).toBe(400);
    const names = async (viewer: string) => (await (await s.get("/v1/views", viewer)).json()).views.map((v: { name: string }) => v.name).sort();
    expect(await names("dana")).toEqual(["Core's", "Mine", "Org"]);
    expect(await names("li")).toEqual(["Core's", "Org"]);
    expect(await names("omar")).toEqual(["Org"]);
    // The old ?viewer= and body `by` still work for integration keys.
    expect((await (await s.get("/v1/views?viewer=li")).json()).views).toHaveLength(2);
    expect((await (await s.post(`/v1/views/${mine.view.id}/delete`, {}, "li")).json()).deleted).toBe(false);
    expect((await (await s.post(`/v1/views/${mine.view.id}/delete`, {}, "dana")).json()).deleted).toBe(true);

    expect((await s.post("/v1/tasks/task_zz/messages", { text: "hi" }, "dana")).status).toBe(404);
    await s.ledger.createTask(task("task_m1", 4));
    const msg = await (await s.post("/v1/tasks/task_m1/messages", { text: "use the old header" }, "dana")).json();
    expect(msg.url).toMatch(/issues\/4/);
    expect(s.codeHost.comments[0]?.markdown).toBe("**@dana** wrote in the factory app:\n\nuse the old header");
    expect(s.runner.signals.at(-1)).toMatchObject({ type: "issue_comment", issueNumber: 4, body: "use the old header", actor: { login: "dana" } });
  });

  it("asks for a new task in the person's team repo, and refuses repos the factory doesn't work in", async () => {
    const s = await testServer();
    const ok = await s.post("/v1/tasks", { ask: "Add CSV export" }, "omar");
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ repo: "o/pay", issueNumber: 100 });
    expect(s.codeHost.issues[0]).toMatchObject({ title: "Add CSV export", labels: ["factory"] });
    const bad = await s.post("/v1/tasks", { ask: "x y z", repo: "o/none" }, "dana");
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("REPO_NOT_CONNECTED");
  });
});

describe("org setup and CloudEvents", () => {
  it("walks setup: org, repo, sources, teams, factories, people, each step done once it exists", async () => {
    const s = await testServer();
    let org = (await (await s.get("/v1/org")).json()).org;
    expect(org.setup.filter((x: { done: boolean }) => x.done)).toHaveLength(0);
    await s.post("/v1/org", { name: "Acme", simulated: true }, "pat");
    await s.post("/v1/org/repos", { repo: "acme/app" }, "pat");
    await s.post("/v1/org/sources", { id: "slack", kind: "slack", name: "Acme Slack", ceSource: "https://acme.slack.com", uses: ["asks"], routes: { C_PAY: "payments" } }, "pat");
    await s.post("/v1/org/sources", { id: "ci", kind: "cdevents", name: "Deploys", ceSource: "https://ci.acme", uses: ["deploys", "outcomes"] }, "pat");
    expect((await s.post("/v1/org/teams", { slug: "payments", name: "Payments", repos: ["acme/app"], factory: "payments" }, "pat")).status).toBe(400); // factory first
    expect((await s.post("/v1/org/factories", { slug: "payments", description: "Money rules", scorers: ["ledger-balances"] }, "pat")).status).toBe(200);
    expect((await s.post("/v1/org/teams", { slug: "payments", name: "Payments", members: [{ login: "omar" }], repos: ["acme/app"], factory: "payments", scope: { paths: ["src/billing/**"], labels: ["billing"] } }, "pat")).status).toBe(200);
    const inv = await (await s.post("/v1/org/people", { login: "omar", email: "omar@acme.dev", persona: "engineer", identities: { slack: "U_OMAR" } }, "pat")).json();
    expect(inv.person).toMatchObject({ role: "engineer", status: "invited", invitedBy: "pat" });
    // Only omar (or an admin) marks omar joined.
    expect((await s.post("/v1/org/people/omar/join", {}, "someone")).status).toBe(403);
    expect((await s.post("/v1/org/people/omar/join", {}, "omar")).status).toBe(200);
    org = (await (await s.get("/v1/org")).json()).org;
    expect(org.org).toMatchObject({ name: "Acme", simulated: true });
    expect(org.people.map((p: { login: string; persona: string; status: string }) => [p.login, p.persona, p.status])).toEqual([
      ["omar", "engineer", "joined"],
      ["pat", "platform_director", "joined"],
    ]);
    expect(Object.fromEntries(org.setup.map((x: { key: string; done: boolean }) => [x.key, x.done]))).toEqual({ org: true, repo: true, sources: true, teams: true, factories: true, people: true, first_task: false });
    // An engineer can't change the org.
    expect((await s.post("/v1/org/repos", { repo: "acme/other" }, "omar")).status).toBe(403);
  });

  it("a Slack mention from a linked person asks in their channel's team repo; strangers get an error result", async () => {
    const s = await testServer({ teams: [] });
    await s.post("/v1/org/sources", { id: "slack", kind: "slack", name: "Acme Slack", ceSource: "https://acme.slack.com", uses: ["asks"], routes: { C_PAY: "payments" } });
    await s.post("/v1/org/teams", { slug: "payments", name: "Payments", repos: ["acme/pay"] });
    await s.post("/v1/org/people", { login: "omar", persona: "engineer", identities: { slack: "U_OMAR" } });
    const ev = fake.slackMention({ source: "https://acme.slack.com", user: "U_OMAR", channel: "C_PAY", channelName: "payments", text: "show VAT on invoices" });
    const r = await (await s.post("/v1/events", ev, null, { "content-type": "application/cloudevents+json" })).json();
    expect(r.results[0]).toMatchObject({ duplicate: false, result: { kind: "ask", url: "https://github.example/acme/pay/issues/100" } });
    expect(s.codeHost.issues[0]).toMatchObject({ repo: { owner: "acme", name: "pay" }, title: "show VAT on invoices" });
    expect(s.codeHost.issues[0]?.body).toMatch(/Asked by @omar in \[Slack #payments\]\(https:\/\/acme\.slack\.com\/archives\/C_PAY\//);
    expect(s.runner.signals[0]).toMatchObject({ type: "issue_labeled", actor: { login: "omar" } });
    // Same event again: CloudEvents source + id dedupe.
    expect((await (await s.post("/v1/events", ev)).json()).results[0].duplicate).toBe(true);
    const stranger = await (await s.post("/v1/events", fake.slackMention({ source: "https://acme.slack.com", user: "U_NOBODY", channel: "C_PAY", text: "do a thing" }))).json();
    expect(stranger.results[0].result).toMatchObject({ kind: "error" });
    expect(stranger.results[0].result.detail).toMatch(/Nobody in the org is linked to slack user U_NOBODY/);
    const log = await (await s.get("/v1/events")).json();
    expect(log.events.map((e: { result: { kind: string } }) => e.result.kind)).toEqual(["error", "ask"]);
    expect((await s.post("/v1/events", "not json", null, { "content-type": "application/cloudevents+json" })).status).toBe(400);
  });

  it("a CDEvents merge moves the factory PR; deploys and incidents become outcomes on the right task", async () => {
    const s = await testServer();
    const { record } = await s.ledger.createTask(task("task_t1", 3, "acme", "app"));
    await s.ledger.append(record.id, "pr_opened", { number: 12, url: "https://github.com/acme/app/pull/12", headSha: SHA });
    const m = await (await s.post("/v1/events", fake.changeMerged({ source: "https://ci.acme", repo: "acme/app", prNumber: 12 }))).json();
    expect(m.results[0].result).toMatchObject({ kind: "signal", taskId: "task_t1" });
    expect(s.runner.signals[0]).toMatchObject({ type: "pr_merged", prNumber: 12, mergeSha: SHA });
    await s.post("/v1/events", fake.serviceDeployed({ source: "https://ci.acme", service: "web", environment: "prod", repo: "acme/app", sha: SHA }));
    await s.post("/v1/events", fake.rootlyIncident({ title: "Checkout 500s", summary: "started after https://github.com/acme/app/pull/12", severity: "SEV2" }));
    await s.post("/v1/events", fake.changeReverted({ source: "https://ci.acme", repo: "acme/app", prNumber: 12, description: "reverted: broke checkout" }));
    expect(s.outcomes.map((o) => [o.taskId, o.outcome.kind])).toEqual([
      ["task_t1", "deployed"],
      ["task_t1", "incident_linked"],
      ["task_t1", "reverted"],
    ]);
    const none = await (await s.post("/v1/events", fake.serviceDeployed({ source: "https://ci.acme", service: "web", environment: "prod", repo: "acme/app", sha: "c".repeat(40) }))).json();
    expect(none.results[0].result.kind).toBe("ignored");
  });
});

describe("MCP", () => {
  it("MCP tools are generated from the registry and call the core", async () => {
    const s = await testServer({ apiToken: "tok" });
    await s.ledger.createTask(task("task_m1"));
    const fetchVia: typeof fetch = (input, init) => Promise.resolve(s.app.fetch(new Request(input, init)));

    const denied = new Client({ name: "t", version: "1" });
    await expect(denied.connect(new StreamableHTTPClientTransport(new URL("http://f.test/mcp"), { fetch: fetchVia }))).rejects.toThrow();

    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://f.test/mcp"), { fetch: fetchVia, requestInit: { headers: { authorization: "Bearer tok" } } }));
    const tools = (await client.listTools()).tools;
    const expected = Object.entries(capabilities).filter(([, c]) => c.mcp).map(([op]) => toolName(op)).sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
    // Every app action is a tool, except machine inputs and the app's own sign-in bookkeeping.
    expect(Object.entries(capabilities).filter(([, c]) => !c.mcp).map(([op]) => op).sort()).toEqual(["joinOrg", "postEgress", "postSignal"]);
    expect(tools.find((t) => t.name === "delete_view")?.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.find((t) => t.name === "create_task")?.annotations).toMatchObject({ openWorldHint: true });

    const list = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(JSON.stringify(list.content)).toContain("task_m1 [received]");
    const one = await client.callTool({ name: "get_task", arguments: { id: "task_m1" } });
    expect(JSON.stringify(one.structuredContent)).toContain("Add CSV export");
    const missing = await client.callTool({ name: "get_task", arguments: { id: "task_nope" } });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("TASK_NOT_FOUND");

    const created = await client.callTool({ name: "create_task", arguments: { ask: "Show VAT on invoices", requestedBy: "dana" } });
    expect(created.structuredContent).toMatchObject({ repo: "o/r", issueNumber: 100 });
    // Agents never run irreversible operations, even with the operator's key.
    const view = await client.callTool({ name: "save_view", arguments: { name: "Mine", path: "/tasks", share: "me", team: null } });
    const viewId = (view.structuredContent as { view: { id: string } }).view.id;
    const del = await client.callTool({ name: "delete_view", arguments: { id: viewId } });
    expect(del.isError).toBe(true);
    expect(JSON.stringify(del.content)).toContain("FORBIDDEN");
    const audit = await s.auditStore.list({ limit: 10, target: null });
    expect(audit.map((e) => `${e.capability} ${e.agent} ${e.outcome}`)).toEqual(["deleteView mcp FORBIDDEN", "saveView mcp ok", "createTask mcp ok", "getTask mcp TASK_NOT_FOUND"]);
    await client.close();
  });
});

it("parses config", () => {
  const c = loadConfig({ PUBLIC_URL: "https://f.example", DATABASE_URL: "postgres://x", FACTORY_REPOS: "a/b, c/d", GITHUB_TOKEN: "t" });
  expect(c.repos.map((r) => r.name)).toEqual(["b", "d"]);
  expect(c.SIGNALS).toBe("poll");
});
