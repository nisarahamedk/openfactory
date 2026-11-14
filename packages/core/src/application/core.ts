import type { CloudEvent } from "@openfactory/contracts";
import type { OperationName } from "@openfactory/contract";
import { actorLabel, systemActor, type Actor, type Role } from "../domain/actor.js";
import { Failure, fail } from "../domain/errors.js";
import { decide, roleOfPerson, type Requirement } from "../domain/rules.js";
import type { CoreDeps } from "../ports/index.js";
import { benchCapabilities } from "./bench.js";
import type { Capability, InputOf, OutputOf, Registry } from "./capability.js";
import { factoryCapabilities, viewCapabilities } from "./factories.js";
import { ingestEvents, orgCapabilities, type EventResult } from "./org.js";
import { taskCapabilities } from "./tasks.js";

/** The capability registry: one entry per contract operation. Every surface (REST, MCP) is derived from it. */
export const capabilities: Registry = { ...taskCapabilities, ...factoryCapabilities, ...viewCapabilities, ...orgCapabilities, ...benchCapabilities };

/**
 * Inputs served outside the contract, with their requirements. CloudEvents arrive in binary mode, which a JSON
 * contract can't describe, so the entrypoint parses them and calls `ingest`.
 */
export const rawCapabilities = { ingestEvents: { audience: "admin", risk: "external" } } as const satisfies Record<string, Requirement>;

/** The application: run any operation as an actor. */
export interface Core {
  /** Authorize, run, and audit one operation. Expected failures throw `Failure`; anything else is a defect. */
  execute<K extends OperationName>(name: K, actor: Actor, input: InputOf<K>): Promise<OutputOf<K>>;
  /** Act on inbound CloudEvents (parsed at the boundary). */
  ingest(actor: Actor, events: CloudEvent[]): Promise<EventResult[]>;
  /** The role this actor holds. */
  roleOf(actor: Actor): Promise<Role>;
}

/** Build the application from its ports. */
export function createCore(deps: CoreDeps): Core {
  async function roleOf(actor: Actor): Promise<Role> {
    switch (actor.principal.kind) {
      // The operator's key and the factory's own jobs run everything; people are limited by their org role.
      case "apiKey":
      case "system":
        return "admin";
      case "user": {
        const login = actor.principal.login;
        const people = await deps.org.people();
        return roleOfPerson(people.find((p) => p.login.toLowerCase() === login.toLowerCase()) ?? null, people.length > 0);
      }
    }
  }

  /** The action wrapper: authorize, run, and audit every call that isn't a read (the-stack P12). */
  async function guarded<T>(operation: string, need: Requirement, target: string | null, actor: Actor, run: (role: Role) => Promise<T>): Promise<T> {
    const role = await roleOf(actor);
    const audit = async (outcome: string) => {
      if (need.risk === "read" && outcome === "ok") return;
      await deps.audit
        .record({
          at: deps.now(),
          capability: operation,
          risk: need.risk,
          actor: actorLabel(actor.principal),
          via: actor.via ? `key:${actor.via.keyId}` : null,
          agent: actor.agent?.client ?? null,
          requestId: actor.requestId,
          target,
          outcome,
        })
        // The change already happened; losing its audit row must not turn success into an error.
        .catch((e) => deps.log("audit write failed", { operation, requestId: actor.requestId, error: String(e) }));
    };
    const verdict = decide(actor, role, need);
    if (!verdict.ok) {
      await audit("FORBIDDEN");
      fail({
        code: "FORBIDDEN",
        operation,
        reason: verdict.reason,
        message:
          verdict.reason === "role"
            ? `${operation} needs the ${need.audience} role; you are a ${role}. Ask an org admin to change your role.`
            : `${operation} can't be undone, so an agent can't run it on its own. Ask a person to do it in the app or with their own key.`,
      });
    }
    try {
      const out = await run(role);
      await audit("ok");
      return out;
    } catch (e) {
      await audit(e instanceof Failure ? e.error.code : "defect");
      throw e;
    }
  }

  return {
    roleOf,
    execute(name, actor, input) {
      const cap: Capability<InputOf<typeof name>, OutputOf<typeof name>> = capabilities[name];
      return guarded(name, cap, cap.target ? cap.target(input) : null, actor, (role) => cap.run({ actor, role, deps }, input));
    },
    ingest(actor, events) {
      // The caller is authorized to deliver events; what each event does (an ask for a linked person, a merge, an
      // outcome) is the factory's own work on that person's behalf, so it runs as the CloudEvents intake.
      return guarded("ingestEvents", rawCapabilities.ingestEvents, null, actor, () => ingestEvents(deps, systemActor("cloudevents", actor.requestId), events));
    },
  };
}
