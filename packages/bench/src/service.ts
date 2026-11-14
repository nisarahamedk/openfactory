import type { BenchmarkTask, LedgerReader, TaskId } from "@openfactory/contracts";
import { CaptureError, captureBenchmarkTask, type CaptureOptions, type PullRequestSource } from "./capture.js";
import { runAB, type ReplayArm } from "./replay.js";
import { compareArms } from "./stats.js";
import type { ArmSpec, BenchRun, FileBenchStore } from "./store.js";

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

/** Input for starting an A-vs-B run (the contract's StartBenchRun). */
export type StartRun = { taskIds: string[]; arms: [ArmSpec, ArmSpec]; repeats: number; maxCostUsd: number };

/**
 * The benchmark suite and A-vs-B runs, with expected failures as values (core's Bench port). Reached through
 * the factory's API and MCP tools: POST /v1/tasks/{id}/benchmark, /v1/bench/tasks, /v1/bench/runs.
 */
export class BenchService {
  constructor(private readonly deps: BenchDeps) {}

  /** Capture a merged task ("Add to benchmark"). */
  async capture(id: TaskId): Promise<{ ok: true; task: BenchmarkTask; files: string[] } | { ok: false; code: CaptureError["code"]; message: string }> {
    try {
      const task = await captureBenchmarkTask(id, { ledger: this.deps.ledger, prs: this.deps.prs, options: this.deps.captureOptions, now: this.deps.now() });
      return { ok: true, task, files: await this.deps.store.saveTask(task) };
    } catch (err) {
      if (err instanceof CaptureError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  tasks(): Promise<BenchmarkTask[]> {
    return this.deps.store.listTasks();
  }

  /** Start a run in the background; the per-run budget is capped by the server's ceiling. */
  async start(input: StartRun): Promise<{ ok: true; run: BenchRun } | { ok: false; code: "SAME_LABELS" | "BENCHMARK_TASK_NOT_FOUND"; message: string; id: string | null }> {
    if (input.arms[0].label === input.arms[1].label) return { ok: false, code: "SAME_LABELS", message: "arm labels must differ", id: null };
    const tasks: BenchmarkTask[] = [];
    for (const id of input.taskIds) {
      const t = await this.deps.store.getTask(id);
      if (t === null) return { ok: false, code: "BENCHMARK_TASK_NOT_FOUND", message: `benchmark task ${id} not found`, id };
      tasks.push(t);
    }
    const run: BenchRun = {
      id: `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: this.deps.now(),
      status: "running",
      taskIds: input.taskIds,
      arms: input.arms,
      repeats: input.repeats,
      maxCostUsd: Math.min(input.maxCostUsd, this.deps.maxCostUsdPerRun),
      results: [],
      spentUsd: 0,
      stoppedForBudget: false,
      report: null,
      error: null,
      finishedAt: null,
    };
    await this.deps.store.saveRun(run);
    void executeRun(run, tasks, this.deps);
    return { ok: true, run };
  }

  runs(): Promise<BenchRun[]> {
    return this.deps.store.listRuns();
  }

  run(id: string): Promise<BenchRun | null> {
    return this.deps.store.getRun(id);
  }
}

/** Runs in the background; every result is persisted as it lands so a crash loses at most one pair. */
async function executeRun(run: BenchRun, tasks: BenchmarkTask[], deps: BenchDeps): Promise<void> {
  try {
    const arms: [ReplayArm, ReplayArm] = [deps.armFor(run.arms[0]), deps.armFor(run.arms[1])];
    const outcome = await runAB({ tasks, arms, repeats: run.repeats, maxCostUsd: run.maxCostUsd, checkTimeoutMs: 600_000 }, async (r, arm) => {
      run.results.push({ ...r, arm });
      run.spentUsd += r.usage.costUsd;
      await deps.store.saveRun(run);
    });
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
