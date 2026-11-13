import { z } from "zod";
import { BenchmarkTask, LedgerEvent, RolloutState, SavedView, Signal, TaskRecord, TaskStatus, Team, ViewShare } from "@openfactory/contracts";
import { ArmSpec, BenchRun } from "@openfactory/bench";

/** Error body every /v1 route returns on failure. */
export const ApiError = z.object({ code: z.string(), message: z.string() }).meta({ id: "ApiError" });

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
    rules: z.object({ label: z.string(), maxTaskUsd: z.number(), maxReviewRounds: z.number(), maxNudges: z.number() }),
    prompts: z.object({ system: z.string(), intake: z.string(), review: z.string(), foreman: z.string() }),
  })
  .meta({ description: "This factory" });
export type FactoryInfo = z.infer<typeof FactoryInfo>;

/** Body of POST /v1/tasks/{id}/cancel. */
export const CancelTask = z.object({ by: z.string().max(100).optional(), reason: z.string().max(1000).optional() }).meta({ id: "CancelTask" });

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
    owner: z.string().min(1).max(100),
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
    by: z.string().min(1).max(100),
    note: z.string().max(500).nullable().default(null),
  })
  .meta({ id: "SetRollout" });

/** Body of POST /v1/tasks/{id}/messages. */
export const PostMessage = z.object({ author: z.string().min(1).max(100), text: z.string().min(1).max(10_000) }).meta({ id: "PostMessage" });

type Method = "get" | "post";

/** One /v1 operation: the single description both the OpenAPI document and the drift test use. */
export interface RouteSpec {
  method: Method;
  /** Hono-style path under /v1, e.g. "/tasks/:id". */
  path: string;
  operationId: string;
  summary: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Status → response body schema. */
  responses: Record<number, { description: string; schema: z.ZodType }>;
}

const notFound = { 404: { description: "Not found", schema: ApiError } };
const bad = { 400: { description: "Invalid request", schema: ApiError } };

/** Every /v1 route the factory server serves. A server test fails when this list drifts from the real routes. */
export const V1_ROUTES: RouteSpec[] = [
  {
    method: "get",
    path: "/tasks",
    operationId: "listTasks",
    summary: "List tasks, newest first",
    query: z.object({ status: TaskStatus.optional(), limit: z.coerce.number().int().min(1).max(500).optional().meta({ example: 50 }) }),
    responses: { 200: { description: "Tasks", schema: z.object({ tasks: z.array(TaskRecord) }) }, ...bad },
  },
  {
    method: "get",
    path: "/tasks/:id",
    operationId: "getTask",
    summary: "One task's ledger record (status, PR, cost, scores, evidence, outcomes)",
    responses: { 200: { description: "The task", schema: z.object({ task: TaskRecord }) }, ...notFound },
  },
  {
    method: "get",
    path: "/tasks/:id/events",
    operationId: "listTaskEvents",
    summary: "The task's append-only event log, oldest first",
    responses: { 200: { description: "Events", schema: z.object({ events: z.array(LedgerEvent) }) }, ...notFound },
  },
  {
    method: "post",
    path: "/tasks/:id/cancel",
    operationId: "cancelTask",
    summary: "Stop a task: abort its running turn, put its environment to sleep, mark it failed (stage \"cancelled\"). A later comment resumes it.",
    body: CancelTask,
    responses: { 200: { description: "The task after cancelling", schema: z.object({ task: TaskRecord }) }, ...bad, ...notFound },
  },
  {
    method: "get",
    path: "/factory",
    operationId: "getFactory",
    summary: "This factory: version, providers (no secrets), agent and foreman models, rules and prompts",
    responses: { 200: { description: "Factory", schema: z.object({ factory: FactoryInfo }) } },
  },
  {
    method: "post",
    path: "/signals",
    operationId: "postSignal",
    summary: "Inject a signal (issue labelled, comment, merge...) as if a signal source had sent it",
    body: Signal,
    responses: { 202: { description: "Accepted", schema: z.object({ result: z.unknown() }) }, ...bad },
  },
  {
    method: "post",
    path: "/egress",
    operationId: "postEgress",
    summary: "Egress proxy collector: what each task's sandbox reached, aggregated per host and window (denied hosts included)",
    body: EgressReport,
    responses: { 202: { description: "Recorded", schema: z.object({ recorded: z.number().int() }) }, ...bad },
  },
  {
    method: "post",
    path: "/tasks/:id/benchmark",
    operationId: "addToBenchmark",
    summary: "Add a merged task to the benchmark suite (Harbor task folder)",
    responses: {
      201: { description: "Captured", schema: z.object({ task: BenchmarkTask, files: z.array(z.string()) }) },
      ...notFound,
      409: { description: "Task is not merged", schema: ApiError },
      422: { description: "No hidden check could be built", schema: ApiError },
    },
  },
  {
    method: "get",
    path: "/bench/tasks",
    operationId: "listBenchmarkTasks",
    summary: "The benchmark suite",
    responses: { 200: { description: "Benchmark tasks", schema: z.object({ tasks: z.array(BenchmarkTask) }) } },
  },
  {
    method: "post",
    path: "/bench/runs",
    operationId: "startBenchRun",
    summary: "Start a paired A-vs-B replay run in the background",
    body: StartBenchRun,
    responses: { 202: { description: "Started", schema: z.object({ run: BenchRun }) }, ...bad, ...notFound },
  },
  {
    method: "get",
    path: "/bench/runs",
    operationId: "listBenchRuns",
    summary: "A-vs-B runs, newest first",
    responses: { 200: { description: "Runs", schema: z.object({ runs: z.array(BenchRun) }) } },
  },
  {
    method: "get",
    path: "/bench/runs/:id",
    operationId: "getBenchRun",
    summary: "One run with its results and report",
    responses: { 200: { description: "The run", schema: z.object({ run: BenchRun }) }, ...notFound },
  },
  {
    method: "post",
    path: "/tasks/:id/messages",
    operationId: "postTaskMessage",
    summary: "Write to the task as a person: posted where the task lives (PR or issue) and handed to its agent like a comment",
    body: PostMessage,
    responses: { 200: { description: "Posted", schema: z.object({ task: TaskRecord, url: z.string().nullable() }) }, ...bad, ...notFound },
  },
  {
    method: "get",
    path: "/teams",
    operationId: "listTeams",
    summary: "Teams and their people and repos, from the org's directory (GitHub teams, SSO groups or factory.yaml)",
    responses: { 200: { description: "Teams", schema: z.object({ teams: z.array(Team) }) } },
  },
  {
    method: "get",
    path: "/factories",
    operationId: "listFactories",
    summary: "The org default factory and every team factory built on it, with each one's rollout",
    responses: { 200: { description: "Factories", schema: z.object({ factories: z.array(FactoryView), rollouts: z.array(RolloutState) }) } },
  },
  {
    method: "get",
    path: "/rollout/:factory",
    operationId: "getRollout",
    summary: "A factory's live version, candidate and the candidate's share of new tasks, with history",
    responses: { 200: { description: "Rollout", schema: z.object({ rollout: RolloutState.nullable(), history: z.array(RolloutState) }) }, ...notFound },
  },
  {
    method: "post",
    path: "/rollout/:factory",
    operationId: "setRollout",
    summary: "Change which version new tasks run on: send a share to a candidate, promote, or roll back",
    body: SetRollout,
    responses: { 200: { description: "New rollout", schema: z.object({ rollout: RolloutState }) }, ...bad, ...notFound },
  },
  {
    method: "get",
    path: "/views",
    operationId: "listViews",
    summary: "Saved views a person may see: their own, their teams' and the org's",
    query: z.object({ viewer: z.string().meta({ example: "dana" }) }),
    responses: { 200: { description: "Views", schema: z.object({ views: z.array(SavedView) }) }, ...bad },
  },
  {
    method: "get",
    path: "/views/:id",
    operationId: "getView",
    summary: "One saved view (anyone with the id may open it)",
    responses: { 200: { description: "The view", schema: z.object({ view: SavedView }) }, ...notFound },
  },
  {
    method: "post",
    path: "/views",
    operationId: "saveView",
    summary: "Save a view: a name plus the app path holding its scope, filters, measure and grouping",
    body: SaveView,
    responses: { 200: { description: "Saved", schema: z.object({ view: SavedView }) }, ...bad },
  },
  {
    method: "post",
    path: "/views/:id/delete",
    operationId: "deleteView",
    summary: "Delete a saved view (its owner only)",
    body: z.object({ by: z.string() }),
    responses: { 200: { description: "Deleted", schema: z.object({ deleted: z.boolean() }) }, ...bad },
  },
  {
    method: "get",
    path: "/openapi.json",
    operationId: "getOpenApi",
    summary: "This document",
    responses: { 200: { description: "OpenAPI 3.1 document", schema: z.record(z.string(), z.unknown()) } },
  },
];
