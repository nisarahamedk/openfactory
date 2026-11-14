import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { contract } from "./contract.js";
import { ApiError } from "./schemas.js";

/**
 * Paths served outside the contract, each with its reason (coding-standards §7: hand-written exceptions are listed).
 * POST /v1/events takes CloudEvents in binary mode (ce-* headers plus any body), which a JSON contract can't describe.
 */
const RAW_PATHS = {
  "/v1/events": {
    post: {
      operationId: "postEvents",
      summary: "CloudEvents 1.0 (structured, batch or binary mode) from connected tools: asks start tasks, merges and closes move PRs, deploys and incidents become outcomes",
      tags: ["inputs"],
      requestBody: { required: true, content: { "application/cloudevents+json": { schema: {} }, "application/cloudevents-batch+json": { schema: { type: "array" } }, "application/json": { schema: {} } } },
      responses: { "202": { description: "What each event did" }, "400": { description: "Not CloudEvents" } },
    },
  },
} as const;

/**
 * The OpenAPI 3.1 document for /v1, generated from the contract. Never hand-edited.
 */
export async function buildOpenApi(opts: { serverUrl: string | null; version: string }): Promise<Record<string, unknown>> {
  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
  const doc = await generator.generate(contract, {
    info: {
      title: "SlopwareFactory API",
      version: opts.version,
      description:
        "Everything the factory app can do, for any client: Slack and Jira integrations, agents (the same operations are MCP tools at /mcp), scripts. Every route needs `Authorization: Bearer <token>`. Errors carry code, message, details, requestId and retryable.",
    },
    ...(opts.serverUrl !== null ? { servers: [{ url: `${opts.serverUrl.replace(/\/$/, "")}/v1` }] } : {}),
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
    commonSchemas: { ApiError: { schema: ApiError } },
  });
  return { ...doc, paths: { ...doc.paths, ...RAW_PATHS } };
}
