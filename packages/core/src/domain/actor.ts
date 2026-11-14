import type { OrgRole } from "@openfactory/contracts";

/**
 * Who is acting (the-stack archetypes §3, trimmed to what a self-hosted factory has today).
 * Built once per request by an entrypoint from verified credentials, never from input.
 *
 * - `user`: a person. Today a person reaches the API through a trusted client (the factory app) that holds
 *   an integration key and names the person it verified; `via` records that key.
 * - `apiKey`: an integration acting for itself (a script, a Slack bridge, an agent with the operator token).
 * - `system`: the factory's own jobs and inbound adapters (CloudEvents, webhooks, timers).
 */
export type Principal = { kind: "user"; login: string } | { kind: "apiKey"; keyId: string } | { kind: "system"; source: string };

/** One request's actor. */
export type Actor = {
  principal: Principal;
  /** The credential a person acted through, when the person was named by a trusted client. */
  via: { kind: "apiKey"; keyId: string } | null;
  /** Present when an agent drives the call (an MCP client). Agents act on someone's authority, never above it. */
  agent: { client: string } | null;
  /** Equals the trace id when the caller sent one; every public error carries it. */
  requestId: string;
};

/** A role in the org, lowest first. */
export type Role = OrgRole;

const RANK: Record<Role, number> = { viewer: 0, engineer: 1, admin: 2 };

/** Whether `have` is at least `need`. */
export function roleAtLeast(have: Role, need: Role): boolean {
  return RANK[have] >= RANK[need];
}

/** A short, stable label for logs and the audit log, e.g. "user:dana", "key:factory-api", "system:cloudevents". */
export function actorLabel(p: Principal): string {
  switch (p.kind) {
    case "user":
      return `user:${p.login}`;
    case "apiKey":
      return `key:${p.keyId}`;
    case "system":
      return `system:${p.source}`;
  }
}

/**
 * The person an action is for. A person's own call is always theirs: a login in the input can't change it.
 * Integration keys and system jobs relay people (a Slack bridge asking for someone), so they may name one;
 * without a name the action is recorded as theirs.
 */
export function personFor(actor: Actor, claimed: string | null | undefined): string {
  switch (actor.principal.kind) {
    case "user":
      return actor.principal.login;
    case "apiKey":
      return claimed ?? "api";
    case "system":
      return claimed ?? actor.principal.source;
  }
}

/** A system actor for the factory's own work (timers, inbound adapters). */
export function systemActor(source: string, requestId: string): Actor {
  return { principal: { kind: "system", source }, via: null, agent: null, requestId };
}
