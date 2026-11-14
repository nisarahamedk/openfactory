/**
 * @openfactory/core: the factory's application, independent of how it's reached.
 *
 *   domain/       pure rules: actor, typed errors, authorization, task/rollout/org rules. No I/O.
 *   application/  use cases and the capability registry (`createCore`). Depends on ports only.
 *   ports/        interfaces the server wires to Postgres, the task job runner, GitHub, benchmarks.
 *
 * Entrypoints (REST, MCP, CloudEvents, webhooks, the app via REST) build an Actor from verified
 * credentials and call `core.execute(operation, actor, input)`. See docs/architecture.md.
 */
export { actorLabel, personFor, roleAtLeast, systemActor, type Actor, type Principal, type Role } from "./domain/actor.js";
export { details, errors, fail, Failure, retryable, type ErrorCode, type FactoryError } from "./domain/errors.js";
export { asTeam, decide, factoryFileProblem, mergeTeams, roleOfPerson, setupSteps, type Requirement } from "./domain/rules.js";
export type { Capability, InputOf, OutputOf, Registry, UseCaseContext } from "./application/capability.js";
export { capabilities, createCore, rawCapabilities, type Core } from "./application/core.js";
export type { EventResult } from "./application/org.js";
export type * from "./ports/index.js";
