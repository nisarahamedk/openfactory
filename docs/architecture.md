# Architecture

The factory follows the-stack's layout and rules ([coding standards](https://github.com/nisarahamedk/the-stack/blob/main/docs/coding-standards.md), [errors](https://github.com/nisarahamedk/the-stack/blob/main/docs/errors.md), DECISIONS P9, P12, P18, P19). This page says how they apply here and where we deviate.

## Layers

```
apps/server/src/entrypoints   REST (/v1), MCP (/mcp), CloudEvents (/v1/events), webhooks, evidence
apps/server/src/adapters      ledger, GitHub, job runner, audit table, bench → core ports (translate only)
apps/server/src/main.ts       composition root: builds infrastructure, adapts it, calls createCore()
packages/core
  domain/                     Actor, Role, typed errors (FactoryError), pure rules (who may do what, rollouts, teams)
  application/                one Capability per operation, the registry, createCore() with the action wrapper
  ports/                      interfaces the core needs (TaskStore, TaskRunner, CodeHost, OrgStore, AuditLog, ...)
  testing/                    a faithful in-memory implementation of every port
packages/contract             oRPC contract: operations, paths, input/output schemas, ApiError; OpenAPI generated
```

Dependencies point inwards. `domain` imports nothing outside the domain. `application` imports `domain`, `ports` and the contract's types. The core never imports Hono, oRPC's server, the MCP SDK, Postgres or a plugin. A test fails the build when a layer imports across that line (`packages/core/src/layers.test.ts`).

## One registry, every surface

`packages/core/src/application/core.ts` exports `capabilities`, which has one entry per contract operation. Each entry gives:

| Field | Meaning |
|---|---|
| `audience` | lowest role that may call it: viewer < engineer < admin |
| `risk` | `read`, `reversible`, `irreversible`, `external` (P9) |
| `mcp` | whether agents see it as a tool |
| `target` | what the audit row names (a task id, a factory slug) |
| `run` | the use case |

The `Registry` type maps over every operation, so a missing entry fails type-checking. The REST router is typed the same way, so a missing handler fails too.

- **REST**: oRPC's OpenAPI handler serves the contract at `/v1`. Each handler is one line, `core.execute(name, actor, input)`. `/v1/openapi.json` is generated from the contract and never edited by hand. The only hand-written path is `POST /v1/events`, because CloudEvents in binary mode can't be described by a JSON contract.
- **MCP**: `/mcp` generates one tool per registry entry where `mcp` is true. The tool takes the contract's input schema, and its annotations come from the risk tier. It runs as Streamable HTTP, stateless, and returns JSON responses. `packages/mcp` is a stdio bridge to `/mcp` for local agents, so it can't drift from the server.
- **Web app**: the dashboard is a client of `/v1` (`packages/client`), the same as any other caller.

Every call goes through `core.execute`, the action wrapper (P12). It works out the actor's role, refuses the call if the role is too low or if an agent asks for an irreversible operation, runs the use case, and writes an audit row. Calls that only read and succeed aren't audited; every other call is, including refusals and failures. `GET /v1/audit` lists the audit rows.

## Actors

An `Actor` has a principal, an optional `via`, an optional `agent` and a `requestId`.

- **Principal**: `user` (a person, by login), `apiKey` (an integration acting as itself) or `system` (the factory's own jobs).
- **via**: the key a person acted through.
- **agent**: set to `{ client }` when the call came through MCP.
- **requestId**: taken from the trace id in `traceparent`, else from `x-request-id`, else a fresh one. It is returned as `x-request-id` and appears in every error body.

The API token is the only credential today. A call with `X-Factory-Actor: <login>` acts as that person, through the key. Without that header, the call acts as the key.

Roles come from the org's people table. The API key and system jobs are admin. While nobody has been set up, everyone is admin; this is the bootstrap rule. Once the org is set up, a person who isn't listed is a viewer.

For a person, the actor is who did it. A `by`, `owner` or `author` field in a body is ignored for people; it only says whom an integration is relaying. Those fields are deprecated and stay only so old callers keep working.

## Errors

Expected failures are a `FactoryError` union keyed on `code`. Use cases throw them with `fail()`. Each entrypoint maps them with an exhaustive switch:

- **REST**: `statusOf(code)` gives the HTTP status, and the body is `{code, message, details, requestId, retryable}`.
- **MCP**: an `isError` result with the text `CODE: message`.

Anything else is a defect. One top-level handler logs it and returns `INTERNAL` with the request id.

## Ports and plugins

Ports (`packages/core/src/ports`) are the core's own small interfaces, shaped by what the use cases need. Plugin interfaces (`packages/contracts`) are the seams for vendors, such as chat, code host, agent and workspace. The adapters in `apps/server/src/adapters` connect the two and make no decisions.

Signal plumbing doesn't count as an action, so it skips the registry. The GitHub webhook, the poller and the job queue feed the task runner directly. Through the API, signals and egress reports are actions (`postSignal`, `postEgress`) and are audited.

## Factories as code

Decided by Nisar on 2026-11-14: definitions live in git, rollout state stays in the database.

A factory is a folder in the definitions repo (`FACTORY_DEFINITIONS_REPO`), and the folder is the whole bundle the agent gets:

```
factories/<slug>/
  factory.yaml            extends, description, scorers, benchmarks, world, mergeRisk,
                          plus the version's label, models (routing), effort, codegraph
  AGENTS.md               extra guidance (written as CLAUDE.local.md in the checkout)
  skills/<name>/SKILL.md  skills, with name and description frontmatter
  mcp.json                MCP servers, in the standard { "mcpServers": { ... } } shape
  agents/worker.md        extra system prompt for the worker agent
```

- **Inheritance**: a folder `extends` another, `default` unless it says otherwise. Inheritance works file by file, and factory.yaml merges key by key, so a team folder only holds what it changes.
- **Versions**: the version is the content hash of the resolved folder, for example `fv_payments_3f2a9c1b0d`. The same files always give the same version, and any change gives a new one.
- **Changing**: `proposeFactoryFiles` writes or deletes any files in a folder as one commit on a new branch, with a pull request. `saveFactory` changes only the settings in factory.yaml and keeps comments and every other key. `getFactoryFiles` reads a folder. All three are on REST and MCP.
- **Syncing**: the server reads the default branch at start-up and every minute.
  - Each team folder becomes a team factory.
  - Each folder's version becomes runnable. Make it live or a candidate with the rollout, as before.
  - A folder with problems, such as bad YAML, a skill without frontmatter or invalid mcp.json, is skipped. Its problems are logged, and the other folders still load.
- **Rollout state** is not in git: which version is live, the candidate and its share. It changes like a deploy, applies instantly, and the audit log records who changed it.
- **Without a definitions repo**, team factory settings are saved straight to the database and versions come from factory.yaml's `versions:` block, as before. Local dev and the simulated org work this way.

The core sees a `DefinitionRepo` port. The format is in `apps/server/src/adapters/factory-folder.ts` and the GitHub adapter is in `definitions.ts`.

Not covered yet:
- Deleting a folder doesn't remove the factory.
- Foreman prompts aren't read from `agents/`.
- Models first named in a synced version aren't in the start-up health check, or in `TASK_KEY_MODELS` unless listed there.
- The app has no file editor yet; edit files through the API, MCP, or GitHub.

## Deviations and follow-ups

| Gap | Why it's fine for now | What closes it |
|---|---|---|
| No `orgId` on rows | one org per install (self-hosted, P19) | add with the hosted, multi-org product |
| One shared API token, people asserted by header | the dashboard and integrations are trusted callers | per-person keys and OAuth for MCP; then the header is only honoured for integration keys |
| The audit row is written after the change, not in the same transaction | a lost row is logged, never turns success into an error | write both in one Postgres transaction once the stores share a connection |
| External actions by agents run immediately | agents can't run irreversible operations | a pending-approval step for `external` actions requested by agents |
| `FactoryApi` is hand-written | it parses every response with the contract's schemas | generate it from the contract (oRPC client) |
| Test files aren't type-checked in CI | builds exclude them, and vitest strips types without checking | a `typecheck:tests` script per package in CI |
