/**
 * Who is calling: built once per request from verified credentials (the-stack archetypes §3), never from the body.
 *
 *   Authorization: Bearer <FACTORY_API_TOKEN>   the factory's integration key (the app, scripts, Slack bridges, agents)
 *   X-Factory-Actor: <login>                    sent by a trusted client (the app) for the person it signed in
 *   traceparent / X-Request-Id                  becomes the request id every error carries
 *
 * The key is the trust boundary: only a holder of the key can name a person. Per-person keys and OAuth for MCP
 * clients are the next step (docs/architecture.md); they plug in here without touching the core.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Actor } from "@openfactory/core";

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{8,100}$/;

/** The request id: the W3C trace id when the caller sent one, else theirs, else a new one. */
export function requestIdOf(header: (name: string) => string | undefined): string {
  const tp = TRACEPARENT.exec(header("traceparent") ?? "");
  if (tp?.[1]) return tp[1];
  const given = header("x-request-id");
  if (given && REQUEST_ID.test(given)) return given;
  return randomBytes(16).toString("hex");
}

function tokenMatches(given: string | undefined, token: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The actor for a request, or null when the credentials are missing or wrong.
 * With no FACTORY_API_TOKEN configured (local development) every caller holds the "open" key.
 */
export function actorFrom(header: (name: string) => string | undefined, opts: { apiToken: string | undefined; agent: { client: string } | null }): Actor | null {
  if (opts.apiToken && !tokenMatches(header("authorization"), opts.apiToken)) return null;
  const keyId = opts.apiToken ? "factory-api" : "open";
  const requestId = requestIdOf(header);
  const person = header("x-factory-actor");
  if (person !== undefined && LOGIN.test(person))
    return { principal: { kind: "user", login: person }, via: { kind: "apiKey", keyId }, agent: opts.agent, requestId };
  return { principal: { kind: "apiKey", keyId }, via: null, agent: opts.agent, requestId };
}
