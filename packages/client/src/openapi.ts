import { z } from "zod";
import { V1_ROUTES, type RouteSpec } from "./routes.js";

/** JSON Schema for a Zod schema, as OpenAPI 3.1 accepts it (custom/unknown parts become `{}`). */
function schemaOf(s: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const out = z.toJSONSchema(s, { target: "draft-2020-12", unrepresentable: "any", io });
  delete out.$schema;
  return out;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1] ?? "");
}

function operation(r: RouteSpec): Record<string, unknown> {
  const params: Array<Record<string, unknown>> = pathParams(r.path).map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: name === "id" && r.path.startsWith("/tasks") ? "Task id, e.g. task_k3x9a1 (from listTasks)" : "Id from the matching list operation",
  }));
  if (r.query !== undefined) {
    for (const [name, field] of Object.entries(r.query.shape)) {
      params.push({ name, in: "query", required: false, schema: schemaOf(field as z.ZodType, "input") });
    }
  }
  return {
    operationId: r.operationId,
    summary: r.summary,
    ...(params.length > 0 ? { parameters: params } : {}),
    ...(r.body !== undefined ? { requestBody: { required: true, content: { "application/json": { schema: schemaOf(r.body, "input") } } } } : {}),
    responses: Object.fromEntries(
      Object.entries(r.responses).map(([status, resp]) => [status, { description: resp.description, content: { "application/json": { schema: schemaOf(resp.schema, "output") } } }]),
    ),
    security: [{ bearer: [] }],
  };
}

/**
 * The OpenAPI 3.1 document for /v1, generated from the same Zod schemas the server
 * and clients parse with. Never hand-edited.
 */
export function buildOpenApi(opts: { serverUrl: string | null; version: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of V1_ROUTES) {
    const p = `/v1${r.path.replace(/:([A-Za-z_]+)/g, "{$1}")}`;
    paths[p] = { ...(paths[p] ?? {}), [r.method]: operation(r) };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "SlopwareFactory API",
      version: opts.version,
      description: "Tasks, their ledger records and events, signals, and benchmarks. Every route needs `Authorization: Bearer <FACTORY_API_TOKEN>`.",
    },
    ...(opts.serverUrl !== null ? { servers: [{ url: opts.serverUrl }] } : {}),
    paths,
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  };
}
