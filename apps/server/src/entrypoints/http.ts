/**
 * The factory server's HTTP surface. Every route is a thin adapter: build the actor from the credentials,
 * parse the input, call the core, translate the result.
 *
 *   GET  /healthz                    liveness
 *   /v1/*                            the API contract (packages/contract), served by rest.ts; OpenAPI at /v1/openapi.json
 *   POST /v1/events                  CloudEvents 1.0 from connected tools (structured, batch or binary mode)
 *   POST /mcp                        MCP (Streamable HTTP): the same operations as tools, from the same registry
 *   POST /webhooks/github            GitHub webhooks (optional; polling is the default). Signal plumbing for the job runner
 *   GET  /evidence/:taskId/:file     evidence copied out of sandboxes, linked from PRs
 */
import { buildOpenApi } from "@openfactory/contract";
import { CloudEventsError, parseCloudEvents } from "@openfactory/cloudevents";
import type { Signal } from "@openfactory/contracts";
import type { Core } from "@openfactory/core";
import { Hono } from "hono";
import type { fileEvidenceStore } from "../adapters/evidence.js";
import { actorFrom, requestIdOf } from "./actor.js";
import { createMcpHandler } from "./mcp.js";
import { createRestHandler } from "./rest.js";

export type HttpDeps = {
  core: Core;
  apiToken: string | undefined;
  /** Public base URL, used in the OpenAPI document's `servers`. */
  publicUrl: string | null;
  version: string;
  evidence: ReturnType<typeof fileEvidenceStore>;
  /** Verify and parse a GitHub webhook delivery; null when webhooks are off. */
  webhook: ((headers: { event: string | null; delivery: string | null; signature: string | null }, body: string) => Promise<Signal | null>) | null;
  /** Where webhook signals go (the job runner's queue), like the poller's. */
  onSignal: (s: Signal) => Promise<unknown>;
  log: (m: string, f?: object) => void;
};

const unauthorized = (requestId: string) => ({ code: "UNAUTHORIZED", message: "Send Authorization: Bearer <FACTORY_API_TOKEN> and try again.", details: null, requestId, retryable: false });

export function createApp(d: HttpDeps): Hono {
  const app = new Hono();
  const rest = createRestHandler(d.core, d.log);
  const mcp = createMcpHandler(d.core, { version: d.version });
  const openapi = buildOpenApi({ serverUrl: d.publicUrl, version: d.version });

  // The one top-level handler for defects (docs/errors.md): expected errors are translated where they happen.
  app.onError((err, c) => {
    const requestId = requestIdOf((n) => c.req.header(n));
    d.log("defect", { path: c.req.path, requestId, error: err.stack ?? String(err) });
    return c.json({ code: "INTERNAL", message: `The factory failed to handle this request. Quote request ${requestId} when you report it.`, details: null, requestId, retryable: false }, 500);
  });
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/v1/openapi.json", async (c) => {
    if (!actorFrom((n) => c.req.header(n), { apiToken: d.apiToken, agent: null })) return c.json(unauthorized(requestIdOf((n) => c.req.header(n))), 401);
    return c.json(await openapi);
  });

  // CloudEvents in binary mode carry their attributes in ce-* headers, which a JSON contract can't describe.
  app.post("/v1/events", async (c) => {
    const actor = actorFrom((n) => c.req.header(n), { apiToken: d.apiToken, agent: null });
    if (!actor) return c.json(unauthorized(requestIdOf((n) => c.req.header(n))), 401);
    let events;
    try {
      events = parseCloudEvents((n) => c.req.header(n), await c.req.text());
    } catch (e) {
      if (e instanceof CloudEventsError) return c.json({ code: "INVALID_REQUEST", message: `${e.message}. Send CloudEvents 1.0 (structured, batch or binary mode).`, details: null, requestId: actor.requestId, retryable: false }, 400);
      throw e;
    }
    return c.json({ results: await d.core.ingest(actor, events) }, 202);
  });

  app.all("/v1/*", async (c) => {
    const actor = actorFrom((n) => c.req.header(n), { apiToken: d.apiToken, agent: null });
    if (!actor) return c.json(unauthorized(requestIdOf((n) => c.req.header(n))), 401);
    const res = await rest(c.req.raw, actor);
    if (res) {
      res.headers.set("x-request-id", actor.requestId);
      return res;
    }
    return c.json({ code: "ROUTE_NOT_FOUND", message: `No API operation at ${c.req.method} ${c.req.path}. /v1/openapi.json lists every operation.`, details: null, requestId: actor.requestId, retryable: false }, 404);
  });

  app.all("/mcp", async (c) => {
    const actor = actorFrom((n) => c.req.header(n), { apiToken: d.apiToken, agent: { client: "mcp" } });
    if (!actor) return c.json(unauthorized(requestIdOf((n) => c.req.header(n))), 401);
    return mcp(c.req.raw, actor);
  });

  if (d.webhook) {
    const parse = d.webhook;
    app.post("/webhooks/github", async (c) => {
      const body = await c.req.text();
      let s: Signal | null;
      try {
        s = await parse({ event: c.req.header("x-github-event") ?? null, delivery: c.req.header("x-github-delivery") ?? null, signature: c.req.header("x-hub-signature-256") ?? null }, body);
      } catch {
        return c.json({ code: "UNAUTHORIZED", message: "The webhook signature doesn't match GITHUB_WEBHOOK_SECRET.", details: null, requestId: requestIdOf((n) => c.req.header(n)), retryable: false }, 401);
      }
      if (s) void d.onSignal(s).catch((e) => d.log("webhook signal failed", { error: String(e) }));
      return c.json({ accepted: Boolean(s) }, 202);
    });
  }

  // Screenshots and test output are public so they render in PRs. Transcripts hold the agent's whole session
  // (code, prompts, tool output), so they need the API token.
  app.get("/evidence/:taskId/:file", async (c) => {
    const name = decodeURIComponent(c.req.param("file"));
    const isPrivate = name.startsWith("transcript-");
    if (isPrivate && !actorFrom((n) => c.req.header(n), { apiToken: d.apiToken, agent: null })) return c.json(unauthorized(requestIdOf((n) => c.req.header(n))), 401);
    const f = await d.evidence.read(c.req.param("taskId"), name);
    if (!f) return c.notFound();
    const cache = isPrivate ? "private, no-store" : "public, max-age=86400";
    return new Response(new Uint8Array(f.bytes), { headers: { "content-type": f.type, "cache-control": cache, "x-content-type-options": "nosniff" } });
  });
  return app;
}
