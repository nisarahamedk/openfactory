import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { TaskId, TaskStatus, type TaskRecord } from "@openfactory/contracts";
import { FactoryApiError, type FactoryApi } from "@openfactory/client";

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(text: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: data };
}

/** Expected API failures become tool errors the model can read; anything else is a defect and throws. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof FactoryApiError) return { content: [{ type: "text", text: `Factory API error (${err.status}): ${err.message}` }], isError: true };
    throw err;
  }
}

/** A short, model-friendly view of a task (the full record is in structuredContent of get_task). */
export function taskLine(t: TaskRecord): string {
  const pr = t.pr === null ? "no PR" : `PR #${t.pr.number}`;
  return `${t.id} [${t.status}] "${t.title}" · ${t.source.repo.owner}/${t.source.repo.name} · ${pr} · $${t.usage.costUsd.toFixed(2)} · ${t.people.reviewRounds} review round(s) · factory ${t.factoryVersion}`;
}

/**
 * The factory's own MCP server. Every tool goes through the /v1 API client, so it has
 * exactly the access of the API token it was built with.
 *   list_tasks, get_task, get_task_events, add_to_benchmark, list_benchmark_runs, get_benchmark_run
 */
export function createFactoryMcpServer(api: FactoryApi, opts: { version: string }): McpServer {
  const server = new McpServer({ name: "openfactory", version: opts.version });

  server.registerTool(
    "list_tasks",
    {
      title: "List factory tasks",
      description: "List the factory's tasks, newest first, optionally only those in one status.",
      inputSchema: { status: TaskStatus.optional().describe("Only tasks in this status"), limit: z.number().int().min(1).max(200).optional().describe("Default 50") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, limit }) =>
      guard(async () => {
        const tasks = await api.listTasks({ ...(status !== undefined ? { status } : {}), limit: limit ?? 50 });
        const text = tasks.length === 0 ? "No tasks." : tasks.map(taskLine).join("\n");
        return ok(text, { tasks: tasks.map((t) => ({ id: t.id, status: t.status, title: t.title, pr: t.pr, costUsd: t.usage.costUsd, factoryVersion: t.factoryVersion })) });
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Task status",
      description: "Status of one task: where it is, its PR, cost, review rounds, scores, evidence and outcomes after the merge.",
      inputSchema: { task_id: TaskId.describe("e.g. task_k3x9a1, from list_tasks") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ task_id }) =>
      guard(async () => {
        const t = await api.getTask(task_id);
        if (t === null) return { content: [{ type: "text", text: `No task ${task_id}.` }], isError: true };
        const scores = t.scores.map((s) => `  ${s.scorer}: ${s.label ?? s.value} (${s.reason})`).join("\n");
        const evidence = t.evidence.map((e) => `  ${e.kind}: ${e.title} ${e.url} @ ${e.commitSha.slice(0, 7)} in ${e.environment}`).join("\n");
        const outcomes = t.outcomes.map((o) => `  ${o.kind}: ${o.detail}`).join("\n");
        const text = [taskLine(t), t.pr ? `PR: ${t.pr.url}` : null, scores && `Scores:\n${scores}`, evidence && `Evidence:\n${evidence}`, outcomes && `After merge:\n${outcomes}`]
          .filter((x): x is string => typeof x === "string" && x.length > 0)
          .join("\n");
        return ok(text, { task: t });
      }),
  );

  server.registerTool(
    "get_task_events",
    {
      title: "Task timeline",
      description: "The task's event log (status changes, agent turns, CI results, comments), oldest first.",
      inputSchema: { task_id: TaskId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ task_id }) =>
      guard(async () => {
        const events = await api.events(task_id);
        return ok(events.map((e) => `${e.at} ${e.type} ${JSON.stringify(e.data)}`).join("\n") || "No events.", { events });
      }),
  );

  server.registerTool(
    "add_to_benchmark",
    {
      title: "Add a task to the benchmark",
      description: "Save a merged task as a benchmark task (start commit + the merged PR's tests as a hidden check), so factory versions can be compared on it.",
      inputSchema: { task_id: TaskId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ task_id }) =>
      guard(async () => {
        const b = await api.addToBenchmark(task_id);
        return ok(`Added ${b.id} (start ${b.startCommit.slice(0, 7)}, check: ${b.check.kind}, ${Object.keys(b.check.files).length} hidden file(s)).`, { benchmarkTask: b });
      }),
  );

  server.registerTool(
    "list_benchmark_runs",
    {
      title: "Benchmark runs",
      description: "A-vs-B benchmark runs, newest first, with their verdict when finished.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const runs = await api.benchRuns();
        const text = runs.length === 0 ? "No runs." : runs.map((r) => `${r.id} [${r.status}] ${r.arms[0].model} vs ${r.arms[1].model} · ${r.results.length} attempts · $${r.spentUsd.toFixed(2)}${r.report ? ` · ${r.report.summary}` : ""}`).join("\n");
        return ok(text, { runs: runs.map((r) => ({ id: r.id, status: r.status, arms: r.arms, spentUsd: r.spentUsd, verdict: r.report?.verdict ?? null })) });
      }),
  );

  server.registerTool(
    "get_benchmark_run",
    {
      title: "Benchmark run",
      description: "One A-vs-B run with every attempt and the report.",
      inputSchema: { run_id: z.string().regex(/^run_[a-z0-9]+$/) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ run_id }) =>
      guard(async () => {
        const r = await api.benchRun(run_id);
        return ok(r.report?.summary ?? `Run ${r.id} is ${r.status} (${r.results.length} attempts so far).`, { run: r });
      }),
  );

  return server;
}

/**
 * Streamable HTTP handler for mounting in any fetch-style server (Hono: `app.all("/mcp", c => handle(c.req.raw))`).
 * Stateless: a fresh server and transport per request, JSON responses, no sessions to leak.
 */
export function createMcpHttpHandler(api: FactoryApi, opts: { version: string }): (req: Request) => Promise<Response> {
  return async (req) => {
    const server = createFactoryMcpServer(api, opts);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  };
}
