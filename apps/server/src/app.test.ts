import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Ledger } from "@openfactory/ledger";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
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
  const app = createApp({ ledger, onSignal: async (s) => got.push(s), evidence, apiToken: "tok", webhook: null, bench: null, factory: async () => { throw new Error("unused"); }, cancel: async () => null, publicUrl: null, log: () => {} });
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
