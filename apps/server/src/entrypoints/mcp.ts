/**
 * MCP: every capability the registry marks `mcp` becomes a tool, with the contract's input schema and summary
 * and annotations from its risk tier. Calls go straight to the core as the same actor model as REST, marked as
 * an agent, so an agent can never do more than its credentials allow and never runs an irreversible operation.
 *
 * Streamable HTTP, stateless: a fresh server and transport per request, JSON responses, no sessions to leak.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { contract, type OperationName } from "@openfactory/contract";
import { capabilities, Failure, type Actor, type Core, type InputOf } from "@openfactory/core";
import { TaskRecord } from "@openfactory/contracts";

const TaskList = z.object({ tasks: z.array(TaskRecord) });
const OneTask = z.object({ task: TaskRecord });

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

/** listTasks → list_tasks. */
export const toolName = (op: string) => op.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A short, model-friendly line for a task (the full record is in structuredContent). */
export function taskLine(t: TaskRecord): string {
  const pr = t.pr === null ? "no PR" : `PR #${t.pr.number}`;
  return `${t.id} [${t.status}] "${t.title}" · ${t.source.repo.owner}/${t.source.repo.name} · ${pr} · $${t.usage.costUsd.toFixed(2)} · ${t.people.reviewRounds} review round(s) · factory ${t.factoryVersion}`;
}

const MAX_TEXT = 20_000;

/** Text for the model: task lines where they help, else the JSON (structuredContent always has all of it). */
function summarize(op: OperationName, out: Record<string, unknown>): string {
  if (op === "listTasks") {
    const list = TaskList.safeParse(out);
    if (list.success) return list.data.tasks.length > 0 ? list.data.tasks.map(taskLine).join("\n") : "No tasks.";
  }
  if (op === "getTask") {
    const one = OneTask.safeParse(out);
    if (one.success) return taskLine(one.data.task);
  }
  const json = JSON.stringify(out, null, 1);
  return json.length > MAX_TEXT ? `${json.slice(0, MAX_TEXT)}\n… (truncated; the full result is in structuredContent)` : json;
}

const RISK_NOTE = {
  read: "Read-only.",
  reversible: "Changes state; can be undone.",
  irreversible: "Can't be undone, so agents can't run it; a person must.",
  external: "Acts outside the factory (posts on the code host or spends model money).",
} as const;

/** The input shape a tool advertises: the contract's input object, or none. */
function shapeOf(op: OperationName): z.ZodRawShape {
  const schema = contract[op]["~orpc"].inputSchema;
  return schema instanceof z.ZodObject ? schema.shape : {};
}

function register<K extends OperationName>(server: McpServer, core: Core, actor: Actor, op: K): void {
  const cap = capabilities[op];
  const route = contract[op]["~orpc"].route;
  const input = contract[op]["~orpc"].inputSchema;
  server.registerTool(
    toolName(op),
    {
      title: route.summary ?? op,
      description: `${route.summary ?? op}. ${RISK_NOTE[cap.risk]} Needs the ${cap.audience} role. (REST: ${route.method} /v1${route.path})`,
      inputSchema: shapeOf(op),
      annotations: { readOnlyHint: cap.risk === "read", destructiveHint: cap.risk === "irreversible", openWorldHint: cap.risk === "external" },
    },
    async (args: Record<string, unknown>): Promise<ToolResult> => {
      const parsed = input ? await input["~standard"].validate(args) : { value: args };
      if ("issues" in parsed && parsed.issues) return { content: [{ type: "text", text: `INVALID_REQUEST: ${parsed.issues.map((i) => i.message).join("; ")}` }], isError: true };
      try {
        // SAFETY: `parsed.value` is the output of this operation's own contract input schema, which is InputOf<K>
        // by definition; TypeScript can't follow that through the generic schema type.
        // Verified by: app.test.ts "MCP tools are generated from the registry and call the core".
        const out = await core.execute(op, actor, parsed.value as InputOf<K>);
        const data = z.record(z.string(), z.unknown()).parse(out);
        return { content: [{ type: "text", text: summarize(op, data) }], structuredContent: data };
      } catch (e) {
        if (e instanceof Failure) return { content: [{ type: "text", text: `${e.error.code}: ${e.error.message}` }], isError: true };
        throw e;
      }
    },
  );
}

/** The MCP handler for /mcp. */
export function createMcpHandler(core: Core, opts: { version: string }): (req: Request, actor: Actor) => Promise<Response> {
  const ops = Object.keys(contract).filter((k): k is OperationName => k in capabilities).filter((op) => capabilities[op].mcp);
  return async (req, actor) => {
    const server = new McpServer({ name: "openfactory", version: opts.version });
    for (const op of ops) register(server, core, actor, op);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  };
}
