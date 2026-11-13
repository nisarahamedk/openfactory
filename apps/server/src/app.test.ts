import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Ledger } from "@openfactory/ledger";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { orgDeps } from "./test-org.js";
import { createApp, fileEvidenceStore } from "./app.js";
import { loadConfig } from "./config.js";

it("serves tasks, signals and evidence behind the API token", async () => {
  const ledger = new Ledger(drizzle(new PGlite()));
  await ledger.migrate();
  await ledger.createTask({
    id: "task_a1",
    factoryVersion: "fv",
    source: { kind: "github_issue", repo: { host: "github", owner: "o", name: "r" }, issueNumber: 1, url: null },
    title: "t",
    ask: "a",
    harness: { name: "h", model: "m" },
  });
  const evidence = fileEvidenceStore(mkdtempSync(join(tmpdir(), "ev-")), "https://f.example");
  const got: unknown[] = [];
  const app = createApp({ ...(await orgDeps()), ledger, onSignal: async (s) => got.push(s), evidence, apiToken: "tok", webhook: null, bench: null, factory: async () => { throw new Error("unused"); }, cancel: async () => null, retry: async () => null, health: async () => ({ at: "t", ok: true, checks: [] }), publicUrl: null, log: () => {} });
  const auth = { authorization: "Bearer tok" };

  expect((await app.request("/v1/tasks")).status).toBe(401);
  const list = await (await app.request("/v1/tasks", { headers: auth })).json();
  expect(list.tasks[0].id).toBe("task_a1");
  expect((await app.request("/v1/tasks/task_a1/events", { headers: auth })).status).toBe(200);
  expect((await app.request("/v1/tasks/task_zz", { headers: auth })).status).toBe(404);

  const sig = { id: "x", repo: { host: "github", owner: "o", name: "r" }, at: "2026-01-01T00:00:00Z", actor: { login: "n", isBot: false }, type: "issue_comment", issueNumber: 1, body: "hi" };
  expect((await app.request("/v1/signals", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(sig) })).status).toBe(202);
  expect(got).toHaveLength(1);

  const egress = { entries: [{ taskId: "task_a1", host: "evil.example", allowed: false, count: 3, from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:01:00Z" }] };
  const post = () => app.request("/v1/egress", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(egress) });
  expect(await (await post()).json()).toEqual({ recorded: 1 });
  await post(); // a repeated report is recorded once
  expect((await ledger.events("task_a1")).filter((e) => e.type === "egress")).toHaveLength(1);

  const { url } = await evidence.put("task_a1", "abc-shot.png", new Uint8Array([1, 2, 3]), "image/png");
  expect(url).toBe("https://f.example/evidence/task_a1/abc-shot.png");
  const res = await app.request("/evidence/task_a1/abc-shot.png");
  expect(res.headers.get("content-type")).toBe("image/png");
  expect((await app.request("/evidence/task_a1/..%2Fx")).status).toBe(404);
  await evidence.put("task_a1", "transcript-1.jsonl", new Uint8Array([123, 125]), "application/x-ndjson");
  expect((await app.request("/evidence/task_a1/transcript-1.jsonl")).status).toBe(401);
  const tr = await app.request("/evidence/task_a1/transcript-1.jsonl", { headers: { authorization: "Bearer tok" } });
  expect(tr.status).toBe(200);
  expect(tr.headers.get("cache-control")).toBe("private, no-store");
});

it("parses config", () => {
  const c = loadConfig({ PUBLIC_URL: "https://f.example", DATABASE_URL: "postgres://x", FACTORY_REPOS: "a/b, c/d", GITHUB_TOKEN: "t" });
  expect(c.repos.map((r) => r.name)).toEqual(["b", "d"]);
  expect(c.SIGNALS).toBe("poll");
});

it("teams, factories, rollouts, saved views and messages", async () => {
  const ledger = new Ledger(drizzle(new PGlite()));
  await ledger.migrate();
  const evidence = fileEvidenceStore(mkdtempSync(join(tmpdir(), "ev-")), "https://f.example");
  const sent: string[] = [];
  const deps = await orgDeps(async (_id, author, text) => {
    sent.push(`${author}: ${text}`);
    return null;
  });
  const app = createApp({ ...deps, ledger, onSignal: async () => null, evidence, apiToken: undefined, webhook: null, bench: null, factory: async () => { throw new Error("unused"); }, cancel: async () => null, retry: async () => null, health: async () => ({ at: "t", ok: true, checks: [] }), publicUrl: null, log: () => {} });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  expect((await (await app.request("/v1/teams")).json()).teams.map((t: { slug: string }) => t.slug)).toEqual(["core", "payments"]);
  const f = await (await app.request("/v1/factories")).json();
  expect(f.factories.map((x: { slug: string; teams: string[] }) => `${x.slug}:${x.teams.join(",")}`)).toEqual(["default:core", "payments:payments"]);

  expect((await post("/v1/rollout/payments", { live: "fv_1", candidate: "fv_2", share: 0.1, by: "omar" })).status).toBe(200);
  expect((await post("/v1/rollout/payments", { live: "fv_1", candidate: null, share: 0.5, by: "omar" })).status).toBe(400);
  expect((await post("/v1/rollout/nope", { live: null, candidate: null, share: 0, by: "omar" })).status).toBe(404);
  await post("/v1/rollout/payments", { live: "fv_1", candidate: null, share: 0, by: "omar", note: "rolled back" });
  const r = await (await app.request("/v1/rollout/payments")).json();
  expect(r.rollout.candidate).toBeNull();
  expect(r.history[0].candidate).toBe("fv_2");

  const mine = await (await post("/v1/views", { name: "Mine", path: "/tasks?scope=person:dana", owner: "dana", share: "me" })).json();
  await post("/v1/views", { name: "Core's", path: "/insights?scope=team:core", owner: "dana", share: "team", team: "core" });
  await post("/v1/views", { name: "Org", path: "/insights", owner: "omar", share: "org" });
  expect((await post("/v1/views", { name: "x", path: "/insights", owner: "dana", share: "team" })).status).toBe(400);
  const names = async (viewer: string) => (await (await app.request(`/v1/views?viewer=${viewer}`)).json()).views.map((v: { name: string }) => v.name).sort();
  expect(await names("dana")).toEqual(["Core's", "Mine", "Org"]);
  expect(await names("li")).toEqual(["Core's", "Org"]);
  expect(await names("omar")).toEqual(["Org"]);
  expect((await (await post(`/v1/views/${mine.view.id}/delete`, { by: "li" })).json()).deleted).toBe(false);
  expect((await (await post(`/v1/views/${mine.view.id}/delete`, { by: "dana" })).json()).deleted).toBe(true);

  expect((await post("/v1/tasks/task_zz/messages", { author: "dana", text: "hi" })).status).toBe(404);
  expect(sent).toEqual(["dana: hi"]);
});

it("asks for a new task", async () => {
  const ledger = new Ledger(drizzle(new PGlite()));
  await ledger.migrate();
  const app = createApp({ ...(await orgDeps()), ledger, onSignal: async () => null, evidence: fileEvidenceStore(mkdtempSync(join(tmpdir(), "ev-")), "https://f.example"), apiToken: undefined, webhook: null, bench: null, factory: async () => { throw new Error("unused"); }, cancel: async () => null, retry: async () => null, health: async () => ({ at: "t", ok: true, checks: [] }), publicUrl: null, log: () => {} });
  const post = (body: unknown) => app.request("/v1/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await (await post({ ask: "Add CSV export", requestedBy: "dana" })).json()).issueNumber).toBe(9);
  const bad = await post({ ask: "x y z", repo: "o/none", requestedBy: "dana" });
  expect(bad.status).toBe(400);
  expect((await bad.json()).message).toBe("not a factory repo");
});
