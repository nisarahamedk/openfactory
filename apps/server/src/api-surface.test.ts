import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { V1_ROUTES } from "@openfactory/client";
import { createBenchRoutes, defaultCaptureOptions, FileBenchStore } from "@openfactory/bench";
import { Ledger } from "@openfactory/ledger";
import { Validator } from "@seriousme/openapi-schema-validator";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { createApp, fileEvidenceStore } from "./app.js";

async function setup() {
  const ledger = new Ledger(drizzle(new PGlite()));
  await ledger.migrate();
  await ledger.createTask({
    id: "task_m1",
    factoryVersion: "fv_1",
    source: { kind: "github_issue", repo: { host: "github", owner: "o", name: "r" }, issueNumber: 1, url: null },
    title: "Add CSV export",
    ask: "a",
    harness: { name: "h", model: "m" },
  });
  const bench = createBenchRoutes({
    ledger,
    prs: { mergedPullRequest: async () => { throw new Error("unused"); } },
    store: new FileBenchStore(mkdtempSync(join(tmpdir(), "bench-"))),
    captureOptions: defaultCaptureOptions,
    armFor: () => { throw new Error("unused"); },
    maxCostUsdPerRun: 1,
    now: () => new Date().toISOString(),
  });
  const app = createApp({
    ledger,
    onSignal: async () => null,
    evidence: fileEvidenceStore(mkdtempSync(join(tmpdir(), "ev-")), "https://f.example"),
    apiToken: "tok",
    webhook: null,
    bench,
    factory: async () => { throw new Error("unused"); },
    cancel: async () => null,
    publicUrl: "https://f.example",
    log: () => {},
  });
  return app;
}

it("V1_ROUTES (the OpenAPI source) matches the routes the server really serves", async () => {
  const app = await setup();
  const served = new Set(
    app.routes
      .filter((r) => r.path.startsWith("/v1/") && r.method !== "ALL")
      .map((r) => `${r.method.toLowerCase()} ${r.path.slice(3)}`),
  );
  const documented = new Set(V1_ROUTES.map((r) => `${r.method} ${r.path}`));
  expect([...served].sort()).toEqual([...documented].sort());
});

it("serves a valid OpenAPI 3.1 document behind the token", async () => {
  const app = await setup();
  expect((await app.request("/v1/openapi.json")).status).toBe(401);
  const doc = await (await app.request("/v1/openapi.json", { headers: { authorization: "Bearer tok" } })).json();
  const result = await new Validator().validate(doc);
  expect(result.errors ?? []).toEqual([]);
  expect(result.valid).toBe(true);
});

it("MCP over /mcp: needs the token, lists tools, and reads task status through /v1", async () => {
  const app = await setup();
  const fetchVia: typeof fetch = (input, init) => Promise.resolve(app.fetch(new Request(input, init)));

  const denied = new Client({ name: "t", version: "1" });
  await expect(denied.connect(new StreamableHTTPClientTransport(new URL("http://f.test/mcp"), { fetch: fetchVia }))).rejects.toThrow();

  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://f.test/mcp"), { fetch: fetchVia, requestInit: { headers: { authorization: "Bearer tok" } } }));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(tools).toEqual(["add_to_benchmark", "get_benchmark_run", "get_task", "get_task_events", "list_benchmark_runs", "list_tasks"]);

  const list = await client.callTool({ name: "list_tasks", arguments: {} });
  expect(JSON.stringify(list.content)).toContain("task_m1 [received]");
  const one = await client.callTool({ name: "get_task", arguments: { task_id: "task_m1" } });
  expect(JSON.stringify(one.structuredContent)).toContain("Add CSV export");
  const refused = await client.callTool({ name: "add_to_benchmark", arguments: { task_id: "task_m1" } });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain("409");
  const missing = await client.callTool({ name: "get_task", arguments: { task_id: "task_nope" } });
  expect(missing.isError).toBe(true);
  await client.close();
});
