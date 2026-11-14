import { posix } from "node:path";
import type { AgentHarness, Effort, McpServer, BenchmarkTask, Environment, EnvironmentHandle, ReplayResult, TaskId, Usage, Workspace, WorkspaceHandle } from "@openfactory/contracts";

/** One side of an A-vs-B comparison: a factory version and the plugins it implies. */
export interface ReplayArm {
  label: string; // "A" / "B" or a human name
  factoryVersion: string;
  harness: AgentHarness;
  workspace: Workspace;
  systemPrompt: string;
  /** Environment for the agent process (model proxy URL, model name...). */
  env: Record<string, string>;
  /**
   * Where world checks run: each attempt gets a fresh environment, the agent can deploy
   * and validate there as in a real task, and the hidden world tests run against it.
   * Null or absent: world checks are skipped (recorded as world: null).
   */
  environment?: Environment | null;
  /** The factory version's bundle, put in place in the checkout before the agent starts (skills, AGENTS.md, index). */
  prepare?: (ws: WorkspaceHandle, cwd: string) => Promise<void>;
  /** The factory version's MCP tools and effort. */
  mcpServers?: McpServer[];
  effort?: Effort;
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
  let env: EnvironmentHandle | null = null;
  const base = { benchmarkTaskId: task.id, factoryVersion: arm.factoryVersion, attempt };
  const taskId = replayTaskId();
  const world = task.check.world;
  try {
    ws = await arm.workspace.create({
      taskId,
      repo: task.repo,
      branch: `bench/${task.id}/${arm.label}/${attempt}`.toLowerCase(),
      image: null,
      startRef: task.startCommit,
    });
    const cwd = ws.repoPath;
    await must(ws, ["git", "fetch", "--quiet", "origin", task.startCommit], cwd).catch(() => undefined); // may already be present
    await must(ws, ["git", "checkout", "--quiet", "--force", task.startCommit], cwd);
    await must(ws, ["git", "clean", "-fdq"], cwd);

    // World: a fresh environment per attempt, handed to the agent the same way a real task gets it.
    let envVars: Record<string, string> = {};
    let skill = "";
    if (world !== null && arm.environment) {
      env = await arm.environment.create({ taskId, repo: task.repo });
      for (const f of await env.credentialsForWorkspace()) await ws.writeFile(f.path, f.content);
      envVars = await env.envVars();
      skill = `\n\n${await env.skill()}`;
    }

    if (arm.prepare) await arm.prepare(ws, cwd);
    const session = await arm.harness.openSession({
      workspace: ws,
      cwd,
      systemPrompt: `${arm.systemPrompt}\n\n${REPLAY_PREAMBLE}${skill}`,
      resumeSessionId: null,
      env: { ...arm.env, ...envVars },
      ...(arm.mcpServers?.length ? { mcpServers: arm.mcpServers } : {}),
      ...(arm.effort ? { effort: arm.effort } : {}),
    });
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
    const repoPassed = check.exitCode === 0;
    let notes = `${turnNote}; check exit=${check.exitCode}\n${(check.stdout + check.stderr).slice(-1200)}`;

    // The world check deploys whatever the agent left in the checkout, then runs the hidden world tests.
    let worldPassed: boolean | null = null;
    if (world !== null && env !== null) {
      for (const [path, content] of Object.entries(world.files)) await ws.writeFile(posix.join(cwd, safeRelativePath(path)), content);
      const w = await ws.exec(world.command, { cwd, env: envVars, timeoutMs: opts.checkTimeoutMs });
      worldPassed = w.exitCode === 0;
      notes += `\nworld check exit=${w.exitCode}\n${(w.stdout + w.stderr).slice(-1200)}`;
    } else if (world !== null) {
      notes += "\nworld check skipped: this arm has no environment";
    }
    return {
      ...base,
      passed: repoPassed && worldPassed !== false,
      usage,
      durationMs: Date.now() - started,
      notes,
      checks: { repo: repoPassed, world: worldPassed },
    };
  } catch (err) {
    return { ...base, passed: false, usage, durationMs: Date.now() - started, notes: `replay error: ${err instanceof Error ? err.message : String(err)}`, checks: null };
  } finally {
    if (ws !== null) await ws.destroy().catch(() => undefined);
    if (env !== null) await env.destroy().catch(() => undefined);
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
