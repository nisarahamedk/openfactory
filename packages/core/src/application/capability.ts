import type { ContractProcedure, InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import type { contract, OperationName, RiskTier } from "@openfactory/contract";
import type { Actor, Role } from "../domain/actor.js";
import type { CoreDeps } from "../ports/index.js";

/** An operation's input after parsing at the boundary. */
export type InputOf<K extends OperationName> = (typeof contract)[K] extends ContractProcedure<infer I, infer _O, infer _E, infer _M> ? InferSchemaOutput<I> : never;
/** What an operation returns. */
export type OutputOf<K extends OperationName> = (typeof contract)[K] extends ContractProcedure<infer _I, infer O, infer _E, infer _M> ? InferSchemaInput<O> : never;

/** What a use case gets: who acts, their role, and the ports. */
export type UseCaseContext = { actor: Actor; role: Role; deps: CoreDeps };

/**
 * One capability: what it needs and what it does. The registry holds one per contract operation, and every
 * surface is derived from it (the-stack coding-standards §7, P9, P12):
 *   - `audience`: the lowest org role that may run it.
 *   - `risk`: read / reversible / irreversible / external. Agents never run irreversible ones on their own.
 *   - `mcp`: also an MCP tool. REST serves every capability; machine-only inputs (signals, egress) aren't tools.
 *   - `target`: what the call acts on, for the audit log.
 */
export interface Capability<I, O> {
  audience: Role;
  risk: RiskTier;
  mcp: boolean;
  target: ((input: I) => string | null) | null;
  run(ctx: UseCaseContext, input: I): Promise<O>;
}

/** One capability per contract operation; a missing or mistyped one fails type-checking. */
export type Registry = { [K in OperationName]: Capability<InputOf<K>, OutputOf<K>> };
