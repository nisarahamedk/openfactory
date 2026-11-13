import { posix } from "node:path";
import type { AgentHarness, BenchmarkTask, ReplayResult, TaskId, Usage, Workspace, WorkspaceHandle } from "@openfactory/contracts";

/** One side of an A-vs-B comparison: a factory version and the plugins it implies. */
export interface ReplayArm {
  label: string; // "A" / "B" or a human name
  factoryVersion: string;
  harness: AgentHarness;
  workspace: Workspace;
  systemPrompt: string;
  /** Environment for the agent process (model proxy URL, model name...). */
  env: Record<string, string>;
}

const REPLAY_PREAMBLE =
  "This is a benchmark replay of past work. Do the task in the current checkout. " +
  "Do not push, open pull requests, or contact anyone; your changes are judged in place when you finish.";

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** Reject absolute paths and `..` so hidden test files can't be written outside the repo. */
export function safeRelativePath(p: string): string {
  const n = posix.normalize(p);
  if (n.startsWith("/") || n === ".." || n.startsWith("../")) throw new Error(`unsafe path in benchmark check: ${p}`);
  return n;
}

function replayTaskId(): TaskId {
  return `task_r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function must(ws: WorkspaceHandle, cmd: string[], cwd: string): Promise<void> {
  const r = await ws.exec(cmd, { cwd, timeoutMs: 300_000 });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode}): ${(r.stderr || r.stdout).slice(-500)}`);
}

/**
 * Run one attempt of one benchmark task under one arm, through the worker plugins'
 * contracts only: fresh workspace → checkout start commit → one agent turn with the
 * ask → copy hidden check files in → run the check. The workspace is always destroyed.
 * Infrastructure failures are recorded as a failed attempt with the reason in `notes`.
 */
export async function runAttempt(task: BenchmarkTask, arm: ReplayArm, attempt: number, opts: { checkTimeoutMs: number }): Promise<ReplayResult> {
  const started = Date.now();
  let usage = ZERO;
  let ws: WorkspaceHandle | null = null;
  const base = { benchmarkTaskId: task.id, factoryVersion: arm.factoryVersion, attempt };
  try {
    ws = await arm.workspace.create({
      taskId: replayTaskId(),
      repo: task.repo,
      branch: `bench/${task.id}/${arm.label}/${attempt}`.toLowerCase(),
      image: null,
    });
    const cwd = ws.repoPath;
    await must(ws, ["git", "fetch", "--quiet", "origin", task.startCommit], cwd).catch(() => undefined); // may already be present
    await must(ws, ["git", "checkout", "--quiet", "--force", task.startCommit], cwd);
    await must(ws, ["git", "clean", "-fdq"], cwd);

    const session = await arm.harness.openSession({ workspace: ws, cwd, systemPrompt: `${arm.systemPrompt}\n\n${REPLAY_PREAMBLE}`, resumeSessionId: null, env: arm.env });
    let turnNote = "";
    try {
      const turn = await session.prompt(task.ask, () => undefined);
      usage = turn.usage;
      turnNote = `agent stop=${turn.stopReason}`;
    } finally {
      await session.close().catch(() => undefined);
    }

    for (const [path, content] of Object.entries(task.check.files)) {
      await ws.writeFile(posix.join(cwd, safeRelativePath(path)), content);
    }
    const check = await ws.exec(task.check.command, { cwd, timeoutMs: opts.checkTimeoutMs });
    const tail = (check.stdout + check.stderr).slice(-1500);
    return {
      ...base,
      passed: check.exitCode === 0,
      usage,
      durationMs: Date.now() - started,
      notes: `${turnNote}; check exit=${check.exitCode}\n${tail}`,
    };
  } catch (err) {
    return { ...base, passed: false, usage, durationMs: Date.now() - started, notes: `replay error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (ws !== null) await ws.destroy().catch(() => undefined);
  }
}

export interface ABPlan {
  tasks: BenchmarkTask[];
  arms: [ReplayArm, ReplayArm];
  repeats: number;
  /** Stop scheduling new attempts once spend reaches this. */
  maxCostUsd: number;
  checkTimeoutMs: number;
}

/**
 * Paired A-vs-B run: for each task and repeat, A and B run side by side, so drift over
 * time (model load, repo mirrors) hits both arms equally. Results stream to `onResult`.
 * Returns why it stopped.
 */
export async function runAB(plan: ABPlan, onResult: (r: ReplayResult, armLabel: string) => Promise<void>): Promise<{ stoppedForBudget: boolean; spentUsd: number }> {
  let spent = 0;
  for (const task of plan.tasks) {
    for (let i = 1; i <= plan.repeats; i++) {
      if (spent >= plan.maxCostUsd) return { stoppedForBudget: true, spentUsd: spent };
      const pair = await Promise.all(plan.arms.map((arm) => runAttempt(task, arm, i, { checkTimeoutMs: plan.checkTimeoutMs })));
      for (const [k, r] of pair.entries()) {
        spent += r.usage.costUsd;
        await onResult(r, plan.arms[k]?.label ?? "?");
      }
    }
  }
  return { stoppedForBudget: false, spentUsd: spent };
}
