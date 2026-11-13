import { Hono } from "hono";
import { z } from "zod";
import { TaskId, type LedgerReader } from "@openfactory/contracts";
import { CaptureError, captureBenchmarkTask, type CaptureOptions, type PullRequestSource } from "./capture.js";
import { runAB, type ReplayArm } from "./replay.js";
import { compareArms } from "./stats.js";
import { ArmSpec, type BenchRun, type FileBenchStore } from "./store.js";

export interface BenchDeps {
  ledger: LedgerReader;
  prs: PullRequestSource;
  store: FileBenchStore;
  captureOptions: CaptureOptions;
  /** Build the plugins for one arm (harness for the model, workspace). Owned by the server. */
  armFor: (spec: ArmSpec) => ReplayArm;
  /** Hard ceiling per run, whatever the caller asks for. */
  maxCostUsdPerRun: number;
  now: () => string;
}

const StartRun = z.object({
  taskIds: z.array(z.string()).min(1).max(50),
  arms: z.tuple([ArmSpec, ArmSpec]),
  repeats: z.number().int().min(1).max(20),
  maxCostUsd: z.number().positive(),
});

const STATUS: Record<CaptureError["code"], 404 | 409 | 422> = { TASK_NOT_FOUND: 404, TASK_NOT_MERGED: 409, NO_CHECK: 422 };

/**
 * Benchmark API, mounted by the server under /v1:
 *   POST /tasks/:id/benchmark   capture a merged task ("Add to benchmark")
 *   GET  /bench/tasks           the suite
 *   POST /bench/runs            start an A-vs-B run (runs in the background)
 *   GET  /bench/runs[/:id]      runs with results and report
 */
export function createBenchRoutes(deps: BenchDeps): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof CaptureError) return c.json({ code: err.code, message: err.message }, STATUS[err.code]);
    if (err instanceof z.ZodError) return c.json({ code: "INVALID_REQUEST", message: "invalid request", issues: err.issues }, 400);
    console.error("bench: unexpected error", err);
    return c.json({ code: "INTERNAL", message: "internal error" }, 500);
  });

  app.post("/tasks/:id/benchmark", async (c) => {
    const id = TaskId.parse(c.req.param("id"));
    const task = await captureBenchmarkTask(id, { ledger: deps.ledger, prs: deps.prs, options: deps.captureOptions, now: deps.now() });
    const files = await deps.store.saveTask(task);
    return c.json({ task, files }, 201);
  });

  app.get("/bench/tasks", async (c) => c.json({ tasks: await deps.store.listTasks() }));

  app.post("/bench/runs", async (c) => {
    const body = StartRun.parse(await c.req.json());
    if (body.arms[0].label === body.arms[1].label) return c.json({ code: "INVALID_REQUEST", message: "arm labels must differ" }, 400);
    const tasks = [];
    for (const id of body.taskIds) {
      const t = await deps.store.getTask(id);
      if (t === null) return c.json({ code: "BENCHMARK_TASK_NOT_FOUND", message: `benchmark task ${id} not found` }, 404);
      tasks.push(t);
    }
    const run: BenchRun = {
      id: `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: deps.now(),
      status: "running",
      taskIds: body.taskIds,
      arms: body.arms,
      repeats: body.repeats,
      maxCostUsd: Math.min(body.maxCostUsd, deps.maxCostUsdPerRun),
      results: [],
      spentUsd: 0,
      stoppedForBudget: false,
      report: null,
      error: null,
      finishedAt: null,
    };
    await deps.store.saveRun(run);
    void executeRun(run, tasks, deps);
    return c.json({ run }, 202);
  });

  app.get("/bench/runs", async (c) => c.json({ runs: await deps.store.listRuns() }));
  app.get("/bench/runs/:id", async (c) => {
    const run = await deps.store.getRun(c.req.param("id"));
    return run === null ? c.json({ code: "RUN_NOT_FOUND", message: "run not found" }, 404) : c.json({ run });
  });

  return app;
}

/** Runs in the background; every result is persisted as it lands so a crash loses at most one pair. */
async function executeRun(run: BenchRun, tasks: Awaited<ReturnType<FileBenchStore["getTask"]>>[], deps: BenchDeps): Promise<void> {
  try {
    const arms: [ReplayArm, ReplayArm] = [deps.armFor(run.arms[0]), deps.armFor(run.arms[1])];
    const outcome = await runAB(
      { tasks: tasks.filter((t) => t !== null), arms, repeats: run.repeats, maxCostUsd: run.maxCostUsd, checkTimeoutMs: 600_000 },
      async (r, arm) => {
        run.results.push({ ...r, arm });
        run.spentUsd += r.usage.costUsd;
        await deps.store.saveRun(run);
      },
    );
    run.stoppedForBudget = outcome.stoppedForBudget;
    run.report = compareArms(run.results, run.arms[0].label, run.arms[1].label);
    run.status = "done";
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
  }
  run.finishedAt = deps.now();
  await deps.store.saveRun(run);
}
