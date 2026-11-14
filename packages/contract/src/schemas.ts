import { z } from "zod";
import { BenchmarkTask, ConnectedSource, Identities, InboundEvent, IntakeResult, LedgerEvent, OrgFactory, OrgRole, OrgState, OrgTeam, Persona, Person, RolloutState, SavedView, Signal, TaskRecord, TaskStatus, Team, ViewShare } from "@openfactory/contracts";
import { ArmSpec, BenchRun } from "@openfactory/bench";

/** Error body every /v1 route returns on failure (docs/errors.md in the-stack: code, message, details, requestId, retryable). */
export const ApiError = z
  .object({
    code: z.string().meta({ description: "Stable machine-readable code, e.g. TASK_NOT_FOUND" }),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).nullable(),
    requestId: z.string().meta({ description: "Quote this to find the request in the factory's logs" }),
    retryable: z.boolean(),
  })
  .meta({ id: "ApiError" });

/** What this factory is: version, providers, models and the prompts it gives the agent. Secrets are never included. */
export const FactoryInfo = z
  .object({
    version: z.string(),
    providersFrom: z.string().meta({ description: "factory.yaml path, or \"env\"" }),
    providers: z.record(z.string(), z.object({ name: z.string(), options: z.record(z.string(), z.unknown()) })),
    agent: z.object({ name: z.string(), model: z.string() }),
    foreman: z.object({ model: z.string() }),
    modelRouting: z
      .object({ default: z.string(), routes: z.array(z.object({ model: z.string(), labels: z.array(z.string()).optional(), keywords: z.array(z.string()).optional() })) })
      .nullable()
      .optional()
      .meta({ description: "Which worker model a new task gets; a model:<name> label always wins" }),
    rollout: z
      .object({ stable: z.string(), candidate: z.string().nullable(), share: z.number() })
      .nullable()
      .optional()
      .meta({ description: "A candidate factory version served to a share of new tasks" }),
    versions: z
      .record(
        z.string(),
        z.object({
          label: z.string().nullable(),
          prompt: z.string().nullable(),
          models: z.object({ default: z.string(), routes: z.array(z.object({ model: z.string(), labels: z.array(z.string()).optional(), keywords: z.array(z.string()).optional() })) }).nullable(),
          effort: z.string().nullable(),
          agentsMd: z.string().nullable(),
          skills: z.array(z.string()),
          mcp: z.array(z.string()),
          codegraph: z.boolean(),
        }),
      )
      .optional()
      .meta({ description: "What each factory version changes: prompt, routing policy, effort, AGENTS.md guidance, skills, MCP tools, CodeGraph" }),
    rules: z.object({ label: z.string(), maxTaskUsd: z.number(), maxReviewRounds: z.number(), maxNudges: z.number() }),
    prompts: z.object({ system: z.string(), intake: z.string(), review: z.string(), foreman: z.string() }),
  })
  .meta({ description: "This factory" });
export type FactoryInfo = z.infer<typeof FactoryInfo>;

/** Body of POST /v1/tasks/{id}/cancel. */
export const CancelTask = z.object({ by: z.string().max(100).optional(), reason: z.string().max(1000).optional() }).meta({ id: "CancelTask" });

/** Body of POST /v1/tasks/{id}/retry. */
export const RetryTask = z.object({ by: z.string().max(100).optional() }).meta({ id: "RetryTask" });
/** Body of POST /v1/tasks/{id}/approve. */
export const ApproveTask = z.object({ by: z.string().min(1).max(100).optional(), note: z.string().max(2000).optional() }).meta({ id: "ApproveTask" });

/** GET /v1/health: whether the factory is set up so a task can succeed. */
export const HealthReport = z
  .object({
    at: z.string(),
    ok: z.boolean(),
    checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string(), fix: z.string().nullable() })),
  })
  .meta({ description: "Start-up checks: code host, repos, model gateway and routed models" });
export type HealthReport = z.infer<typeof HealthReport>;

/** Body of POST /v1/egress. */
export const EgressReport = z
  .object({
    entries: z
      .array(z.object({ taskId: z.string(), host: z.string().max(253), allowed: z.boolean(), count: z.number().int().positive(), from: z.string(), to: z.string() }))
      .max(5000),
  })
  .meta({ id: "EgressReport" });

/** Body of POST /v1/bench/runs. */
export const StartBenchRun = z
  .object({
    taskIds: z.array(z.string()).min(1).max(50).meta({ description: "Benchmark task ids, as returned by POST /v1/tasks/{id}/benchmark", example: ["bench_k3x9a1"] }),
    arms: z.tuple([ArmSpec, ArmSpec]).meta({ description: "Arm A and arm B" }),
    repeats: z.number().int().min(1).max(20).meta({ example: 2 }),
    maxCostUsd: z.number().positive().meta({ description: "Budget for the run; the server caps it further", example: 5 }),
  })
  .meta({ id: "StartBenchRun" });

/** One factory: the org default or a team factory, with what it changes on top of the default. */
export const FactoryView = z
  .object({
    slug: z.string(),
    extends: z.string().nullable(),
    description: z.string().nullable(),
    scorers: z.array(z.string()),
    benchmarks: z.array(z.string()),
    world: z.string().nullable().meta({ description: "OpenWorld world for the 30-day check" }),
    mergeRisk: z.record(z.string(), z.unknown()).nullable(),
    teams: z.array(z.string()),
  })
  .meta({ description: "A factory: the org default or a team factory" });
export type FactoryView = z.infer<typeof FactoryView>;

/** Body of POST /v1/views. */
export const SaveView = z
  .object({
    id: z.string().optional().meta({ description: "Update this view (owner only); omit to create" }),
    name: z.string().min(1).max(120),
    path: z.string().startsWith("/").max(2000).meta({ example: "/insights?scope=team:core&measure=came_back&by=kind" }),
    owner: z.string().min(1).max(100).optional().meta({ description: "Deprecated: the signed-in person owns the view" }),
    share: ViewShare,
    team: z.string().nullable().default(null),
  })
  .meta({ id: "SaveView" });

/** Body of POST /v1/rollout/{factory}. */
export const SetRollout = z
  .object({
    live: z.string().nullable(),
    candidate: z.string().nullable(),
    share: z.number().min(0).max(1),
    by: z.string().min(1).max(100).optional(),
    note: z.string().max(500).nullable().default(null),
  })
  .meta({ id: "SetRollout" });

/** Body of POST /v1/tasks. */
export const NewTaskRequest = z
  .object({
    ask: z.string().min(3).max(20_000).meta({ description: "What the person wants, in their words. The first line becomes the title." }),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).nullable().default(null).meta({ description: "owner/name; omit to let the factory pick from the person's team" }),
    requestedBy: z.string().min(1).max(100).optional().meta({ description: "Who the task is for. A person's own call always uses them; integration keys may name the person they relay" }),
    origin: z.object({ label: z.string().max(200), url: z.string().max(2000).nullable() }).nullable().optional().meta({ description: "Where the ask came from (a Slack thread, a Jira issue), shown on the task" }),
    labels: z.array(z.string().max(50)).max(20).optional().meta({ description: "Extra issue labels (they steer model routing, e.g. ui, small)" }),
  })
  .meta({ id: "NewTaskRequest" });

const by = z.string().min(1).max(100).optional().meta({ description: "Deprecated: who acts comes from the credentials. Integration keys (no person) may still name the person they relay" });
/** Body of POST /v1/org. */
export const SetOrg = z.object({ name: z.string().min(1).max(80), by, simulated: z.boolean().optional() }).meta({ id: "SetOrg" });
/** Body of POST /v1/org/repos. */
export const ConnectOrgRepo = z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), by }).meta({ id: "ConnectOrgRepo" });
/** Body of POST /v1/org/people. */
export const InvitePerson = z
  .object({ login: Person.shape.login, name: z.string().max(120).nullable().optional(), email: z.string().email().nullable().optional(), persona: Persona, role: OrgRole.optional(), identities: Identities.optional(), by })
  .meta({ id: "InvitePerson" });
/** Body of POST /v1/org/teams. */
export const SaveOrgTeam = OrgTeam.omit({ createdBy: true, createdAt: true }).extend({ by }).meta({ id: "SaveOrgTeam" });
/** Body of POST /v1/org/factories. */
/** A change proposed as a pull request to the factory definitions repo; it takes effect when merged. */
export const Proposal = z.object({ number: z.number().int(), url: z.string() }).meta({ id: "Proposal" });
export type Proposal = z.infer<typeof Proposal>;

/** A file in a factory's folder, by its path inside the folder (e.g. AGENTS.md, skills/pricing/SKILL.md). */
export const FactoryFile = z.object({ path: z.string().min(1).max(200), content: z.string().max(200_000) }).meta({ id: "FactoryFile" });
export type FactoryFile = z.infer<typeof FactoryFile>;

/** Change files in a factory's folder through a pull request; `content: null` deletes the file. */
export const ProposeFactoryFiles = z
  .object({
    files: z.array(z.object({ path: FactoryFile.shape.path, content: FactoryFile.shape.content.nullable() })).min(1).max(50),
    title: z.string().min(1).max(200).nullable().default(null),
    by,
  })
  .meta({ id: "ProposeFactoryFiles" });

export const SaveOrgFactory = OrgFactory.omit({ createdBy: true, createdAt: true }).extend({ by }).meta({ id: "SaveOrgFactory" });
/** Body of POST /v1/org/sources. */
export const ConnectOrgSource = ConnectedSource.omit({ connectedBy: true, connectedAt: true }).extend({ by }).meta({ id: "ConnectOrgSource" });

/** Body of POST /v1/tasks/{id}/messages. */
export const PostMessage = z.object({ author: z.string().min(1).max(100).optional(), text: z.string().min(1).max(10_000) }).meta({ id: "PostMessage" });


/** Risk tiers (the-stack P9): what an action can do, which decides who may run it directly. */
export const RiskTier = z.enum(["read", "reversible", "irreversible", "external"]).meta({ id: "RiskTier" });
export type RiskTier = z.infer<typeof RiskTier>;

/** One state-changing action, as the audit log keeps it. */
export const AuditEntry = z
  .object({
    id: z.string(),
    at: z.string(),
    capability: z.string().meta({ description: "The operation, e.g. setRollout" }),
    risk: RiskTier,
    actor: z.string().meta({ description: "Who acted, e.g. user:dana, key:factory-api, system:cloudevents" }),
    via: z.string().nullable().meta({ description: "The credential a person acted through, e.g. key:factory-api for the app" }),
    agent: z.string().nullable().meta({ description: "The agent that made the call (an MCP client), if any" }),
    requestId: z.string(),
    target: z.string().nullable().meta({ description: "What it acted on, e.g. task_k3x9a1 or factory payments" }),
    outcome: z.string().meta({ description: "ok, or the error code" }),
  })
  .meta({ id: "AuditEntry" });
export type AuditEntry = z.infer<typeof AuditEntry>;

/** Body of POST /v1/bench/runs, parsed. */
export type StartBenchRunShape = z.infer<typeof StartBenchRun>;
/** One A-vs-B benchmark run. */
export type BenchRunShape = z.infer<typeof BenchRun>;
