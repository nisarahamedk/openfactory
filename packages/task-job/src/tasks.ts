/**
 * The task's life as pi-durable tasks. Every phase ends in a commit, so a
 * restarted server resumes at the last checkpoint. Work inside a phase is
 * written to be safe to repeat (see steps.ts).
 *
 *  factory.intake   prepare → turn → gate (→ nudge turn …) → awaiting review, env asleep
 *  factory.review   queue behind live work → wake → turn → gate → awaiting review, env asleep
 *  factory.finalize record outcome → score → export → tear down
 */
import type { Context } from "@earendil-works/chord/context";
import { defineTask, type TaskId as PdTaskId } from "@earendil-works/pi-durable";
import type { TaskId } from "@openfactory/contracts";
import type { JobDeps } from "./deps.js";
import { intakePrompt, reviewPrompt } from "./prompts.js";
import {
  announceReview,
  fail,
  mustTask,
  prepare,
  reviewGate,
  runTurn,
  scoreAndExport,
  sleepAll,
  wakeAll,
} from "./steps.js";

type Turnish =
  | { phase: "turn"; prompt: string; nudges: number }
  | { phase: "gate"; summary: string; nudges: number };

// biome-ignore lint: the runtime type is generic over each task's own state; we only use commit() and signal here.
type Rt = any;

const done = (rt: Rt, c: Context) => rt.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), c);
const failed = (rt: Rt, c: Context, message: string) =>
  rt.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }), c);
const aborted = (_t: unknown, rt: Rt, c: Context) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c);

async function guarded(deps: JobDeps, taskId: TaskId, stage: string, rt: Rt, c: Context, body: () => Promise<void>) {
  try {
    await body();
  } catch (e) {
    if (rt.signal?.aborted) throw e; // aborted: the abort handler records it
    const message = e instanceof Error ? e.message : String(e);
    deps.log("phase failed", { taskId, stage, error: message });
    await fail(deps, taskId, stage, message);
    await scoreAndExport(deps, taskId);
    await failed(rt, c, message);
  }
}

/** Shared turn → gate loop used by intake and review rounds. */
async function turnPhase(deps: JobDeps, taskId: TaskId, reason: "intake" | "review", s: Turnish & { phase: "turn" }, rt: Rt, c: Context) {
  await guarded(deps, taskId, "agent turn", rt, c, async () => {
    const summary = await runTurn(deps, taskId, reason, s.prompt, rt.signal);
    await rt.commit(() => ({ status: "running", checkpoint: { phase: "gate", summary, nudges: s.nudges } }), c);
  });
}

async function gatePhase(deps: JobDeps, taskId: TaskId, round: number, s: Turnish & { phase: "gate" }, rt: Rt, c: Context) {
  await guarded(deps, taskId, "review gate", rt, c, async () => {
    const gate = await reviewGate(deps, taskId, s.summary, s.nudges);
    if (gate.kind === "nudge") {
      await rt.commit(() => ({ status: "running", checkpoint: { phase: "turn", prompt: gate.prompt, nudges: s.nudges + 1 } }), c);
      return;
    }
    if (gate.kind === "give_up") throw new Error(`no reviewable result after ${s.nudges} nudges: ${gate.reason}`);
    await announceReview(deps, taskId, s.summary, round);
    await sleepAll(deps, taskId);
    await scoreAndExport(deps, taskId);
    await done(rt, c);
  });
}

export function jobTasks(deps: JobDeps) {
  const Intake = defineTask<{ taskId: TaskId }, { phase: "prepare" } | Turnish, null>({
    name: "factory.intake",
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: (task, rt, c) =>
        guarded(deps, task.input.taskId, "preparing environment", rt, c, async () => {
          await prepare(deps, task.input.taskId);
          await deps.ledger.setStatus(task.input.taskId, "working");
          const record = await mustTask(deps, task.input.taskId);
          await rt.commit(() => ({ status: "running", checkpoint: { phase: "turn", prompt: intakePrompt(record), nudges: 0 } }), c);
        }),
      turn: (task, rt, c) => turnPhase(deps, task.input.taskId, "intake", task.state.checkpoint, rt, c),
      gate: (task, rt, c) => gatePhase(deps, task.input.taskId, 0, task.state.checkpoint, rt, c),
    },
    abort: aborted,
  });

  const Review = defineTask<
    { taskId: TaskId; body: string; round: number; after: number[] },
    { phase: "queue" } | { phase: "wake" } | Turnish,
    null
  >({
    name: "factory.review",
    version: 1,
    initial: () => ({ phase: "queue" }),
    phases: {
      queue: async (task, rt, c) => {
        const after = task.input.after as unknown as PdTaskId[];
        if (after.length === 0) return rt.commit(() => ({ status: "running", checkpoint: { phase: "wake" } }), c);
        await rt.commit(() => ({ status: "waiting", checkpoint: { phase: "wake" }, on: after, policy: "allSettled" }), c);
      },
      wake: (task, rt, c) =>
        guarded(deps, task.input.taskId, "waking environment", rt, c, async () => {
          const t = task.input.taskId;
          const record = await mustTask(deps, t);
          if (record.status === "merged" || record.status === "closed") return done(rt, c);
          await deps.ledger.append(t, "review_round_started", { comments: 1 });
          await deps.ledger.setStatus(t, "iterating");
          await wakeAll(deps, t);
          await rt.commit(() => ({ status: "running", checkpoint: { phase: "turn", prompt: reviewPrompt(task.input.body), nudges: 0 } }), c);
        }),
      turn: (task, rt, c) => turnPhase(deps, task.input.taskId, "review", task.state.checkpoint, rt, c),
      gate: (task, rt, c) => gatePhase(deps, task.input.taskId, task.input.round, task.state.checkpoint, rt, c),
    },
    abort: aborted,
  });

  const Finalize = defineTask<{ taskId: TaskId; outcome: "merged" | "closed"; detail: string; at: string }, { phase: "record" } | { phase: "teardown" }, null>({
    name: "factory.finalize",
    version: 1,
    initial: () => ({ phase: "record" }),
    phases: {
      record: async (task, rt, c) => {
        const { taskId, outcome, detail, at } = task.input;
        const record = await mustTask(deps, taskId);
        if (!record.outcomes.some((o) => o.kind === (outcome === "merged" ? "merged" : "closed_unmerged"))) {
          await deps.ledger.append(taskId, "outcome_added", {
            outcome: { kind: outcome === "merged" ? "merged" : "closed_unmerged", source: "github", detail, at, arrivedAt: new Date().toISOString() },
          });
        }
        await deps.ledger.setStatus(taskId, outcome);
        await scoreAndExport(deps, taskId);
        await rt.commit(() => ({ status: "running", checkpoint: { phase: "teardown" } }), c);
      },
      teardown: async (task, rt, c) => {
        const record = await mustTask(deps, task.input.taskId);
        try {
          const ws = record.workspace ? await deps.workspace.get(record.workspace.id) : null;
          await ws?.destroy();
          const env = record.environment ? await deps.environment.get(record.environment.name) : null;
          await env?.destroy();
        } catch (e) {
          deps.log("teardown failed", { taskId: record.id, error: String(e) });
        }
        await done(rt, c);
      },
    },
    abort: aborted,
  });

  return { Intake, Review, Finalize };
}

export type JobTasks = ReturnType<typeof jobTasks>;
