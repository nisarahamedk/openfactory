import { errors, fail } from "../domain/errors.js";
import type { Bench, CoreDeps } from "../ports/index.js";
import type { Registry } from "./capability.js";

function benchOrFail(deps: CoreDeps): Bench {
  return deps.bench ?? fail({ code: "BENCHMARKS_NOT_SET_UP", message: "Benchmarks aren't set up on this factory. Set BENCH_DIR (Helm: bench.enabled) and restart the server." });
}

/** Benchmark suite and A-vs-B runs; also the audit log. */
export const benchCapabilities: Pick<Registry, "addToBenchmark" | "listBenchmarkTasks" | "startBenchRun" | "listBenchRuns" | "getBenchRun" | "listAudit"> = {
  addToBenchmark: {
    audience: "engineer",
    risk: "reversible",
    mcp: true,
    target: (i) => i.id,
    run: async ({ deps }, i) => {
      const r = await benchOrFail(deps).capture(i.id);
      if (r.ok) return { task: r.task, files: r.files };
      switch (r.code) {
        case "TASK_NOT_FOUND":
          return fail(errors.taskNotFound(i.id));
        case "TASK_NOT_MERGED":
          return fail({ code: "TASK_NOT_MERGED", taskId: i.id, message: `${r.message}. Only a merged task can join the benchmark.` });
        case "NO_CHECK":
          return fail({ code: "NO_HIDDEN_CHECK", taskId: i.id, message: `${r.message}. Add tests to the PR, or set BENCH_CHECK_JSON to say how to check it.` });
      }
    },
  },
  listBenchmarkTasks: { audience: "viewer", risk: "read", mcp: true, target: null, run: async ({ deps }) => ({ tasks: await benchOrFail(deps).tasks() }) },
  // External: replays run agents, which spends model money (capped by the server's per-run ceiling).
  startBenchRun: {
    audience: "engineer",
    risk: "external",
    mcp: true,
    target: null,
    run: async ({ deps }, i) => {
      const r = await benchOrFail(deps).start(i);
      if (r.ok) return { run: r.run };
      switch (r.code) {
        case "SAME_LABELS":
          return fail(errors.invalid("The two arms need different labels.", [{ path: "arms", message: "labels must differ" }]));
        case "BENCHMARK_TASK_NOT_FOUND":
          return fail({ code: "BENCHMARK_TASK_NOT_FOUND", benchmarkTaskId: r.id ?? "", message: `Benchmark task ${r.id ?? ""} was not found. listBenchmarkTasks shows the suite.` });
      }
    },
  },
  listBenchRuns: { audience: "viewer", risk: "read", mcp: true, target: null, run: async ({ deps }) => ({ runs: await benchOrFail(deps).runs() }) },
  getBenchRun: {
    audience: "viewer",
    risk: "read",
    mcp: true,
    target: (i) => i.id,
    run: async ({ deps }, i) => ({ run: (await benchOrFail(deps).run(i.id)) ?? fail({ code: "RUN_NOT_FOUND", runId: i.id, message: `Benchmark run ${i.id} was not found. listBenchRuns shows every run.` }) }),
  },
  listAudit: {
    audience: "engineer",
    risk: "read",
    mcp: true,
    target: null,
    run: async ({ deps }, i) => ({ entries: await deps.audit.list({ limit: i.limit ?? 200, target: i.target ?? null }) }),
  },
};
