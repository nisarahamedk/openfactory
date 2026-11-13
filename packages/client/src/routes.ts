import { z } from "zod";
import { BenchmarkTask, LedgerEvent, Signal, TaskRecord, TaskStatus } from "@openfactory/contracts";
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
    method: "get",
    path: "/openapi.json",
    operationId: "getOpenApi",
    summary: "This document",
    responses: { 200: { description: "OpenAPI 3.1 document", schema: z.record(z.string(), z.unknown()) } },
  },
];
