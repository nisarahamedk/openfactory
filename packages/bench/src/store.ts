import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BenchmarkTask, ReplayResult } from "@openfactory/contracts";
import { writeHarborTask } from "./harbor.js";
import type { ABReport } from "./stats.js";

export const ArmSpec = z.object({
  label: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  factoryVersion: z.string().min(1),
  model: z.string().min(1),
  systemPrompt: z.string().default(""),
});
export type ArmSpec = z.infer<typeof ArmSpec>;

export const BenchRun = z.object({
  id: z.string(),
  createdAt: z.string(),
  status: z.enum(["running", "done", "failed"]),
  taskIds: z.array(z.string()),
  arms: z.tuple([ArmSpec, ArmSpec]),
  repeats: z.number().int().positive(),
  maxCostUsd: z.number().positive(),
  results: z.array(ReplayResult.extend({ arm: z.string() })),
  spentUsd: z.number(),
  stoppedForBudget: z.boolean(),
  report: z.custom<ABReport>().nullable(),
  error: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type BenchRun = z.infer<typeof BenchRun>;

/**
 * Benchmark suite on disk: `<root>/tasks/<id>/` is a Harbor task folder (plus our
 * benchmark.json), `<root>/runs/<id>.json` is one A-vs-B run. Plain files so a team
 * can commit its suite to git and run it in Harbor too.
 */
export class FileBenchStore {
  constructor(private readonly root: string) {}

  async saveTask(task: BenchmarkTask): Promise<string[]> {
    return writeHarborTask(join(this.root, "tasks", task.id), task, { agentTimeoutSec: 1800, verifierTimeoutSec: 600 });
  }

  async getTask(id: string): Promise<BenchmarkTask | null> {
    try {
      return BenchmarkTask.parse(JSON.parse(await readFile(join(this.root, "tasks", id, "benchmark.json"), "utf8")));
    } catch {
      return null;
    }
  }

  async listTasks(): Promise<BenchmarkTask[]> {
    const ids = await readdir(join(this.root, "tasks")).catch(() => [] as string[]);
    const tasks = await Promise.all(ids.map((id) => this.getTask(id)));
    return tasks.filter((t): t is BenchmarkTask => t !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveRun(run: BenchRun): Promise<void> {
    const dir = join(this.root, "runs");
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${run.id}.json.tmp`);
    await writeFile(tmp, JSON.stringify(run, null, 2));
    await rename(tmp, join(dir, `${run.id}.json`));
  }

  async getRun(id: string): Promise<BenchRun | null> {
    if (!/^run_[a-z0-9]+$/.test(id)) return null;
    try {
      return BenchRun.parse(JSON.parse(await readFile(join(this.root, "runs", `${id}.json`), "utf8")));
    } catch {
      return null;
    }
  }

  async listRuns(): Promise<BenchRun[]> {
    const names = await readdir(join(this.root, "runs")).catch(() => [] as string[]);
    const runs = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => this.getRun(n.replace(/\.json$/, ""))));
    return runs.filter((r): r is BenchRun => r !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
