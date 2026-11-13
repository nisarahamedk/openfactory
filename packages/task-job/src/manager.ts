/**
 * TaskJobs: one pi-durable Harness per factory task (pi-durable has one writer
 * per storage, so each task gets its own SQLite file). The root conversation of
 * that Harness is the task's foreman; the job's own durable tasks run beside it.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, type Conversation, type TaskId as PdTaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Signal, TaskId, TaskRecord } from "@openfactory/contracts";
import { askForeman, FOREMAN_INSTRUCTIONS } from "@openfactory/foreman";
import { decide, isTerminal, pickModel, type Action, type ModelRouting } from "@openfactory/rules";
import { issueTarget, type JobDeps } from "./deps.js";
import { scoreAndExport, sleepAll } from "./steps.js";
import { jobTasks, type JobTasks } from "./tasks.js";

export type TaskJobsOptions = {
  dataDir: string;
  models: Models;
  foremanModel: { provider: string; modelId: string };
  factoryVersion: () => string;
  harnessInfo: { name: string; model: string };
  /** Which worker model a new task gets (factory.yaml `models:`). Null: always harnessInfo.model. */
  modelRouting?: ModelRouting | null;
};

type Open = { h: Harness; root: Conversation };

const JOB_KINDS = new Set(["factory.intake", "factory.review", "factory.finalize"]);

export function newTaskId(): TaskId {
  return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class TaskJobs {
  private readonly open = new Map<TaskId, Promise<Open>>();
  private readonly tasks: JobTasks;
  private readonly extension;

  constructor(
    private readonly deps: JobDeps,
    private readonly opts: TaskJobsOptions,
  ) {
    this.tasks = jobTasks(deps);
    this.extension = defineExtension({ name: "factory", tasks: [this.tasks.Intake, this.tasks.Review, this.tasks.Finalize] });
    mkdirSync(join(opts.dataDir, "tasks"), { recursive: true });
  }

  private harness(taskId: TaskId): Promise<Open> {
    let p = this.open.get(taskId);
    if (!p) {
      p = (async () => {
        const registry = createRegistry();
        registry.install(this.extension);
        const storage = await openNodeSqliteStorage(join(this.opts.dataDir, "tasks", `${taskId}.sqlite`));
        const h = await Harness.open(
          storage,
          {
            models: this.opts.models,
            registry,
            onReport: (r: { kind: string; error?: unknown }) => this.deps.log("pi-durable report", { taskId, kind: r.kind, error: String(r.error ?? "") }),
          } as Parameters<typeof Harness.open>[1],
          ctx,
        );
        const root = await h.root(ctx, {
          agent: { model: this.opts.foremanModel, instructions: FOREMAN_INSTRUCTIONS, maxTurns: 4 },
        });
        h.resume();
        return { h, root };
      })();
      this.open.set(taskId, p);
      p.catch(() => this.open.delete(taskId));
    }
    return p;
  }

  /** Reopen every task that still has work, so sleeping and interrupted jobs continue after a restart. */
  async resumeAll(): Promise<number> {
    const live = (await this.deps.ledger.listTasks({ limit: 500 })).filter((t) => !isTerminal(t.status));
    const files = new Set(readdirSync(join(this.opts.dataDir, "tasks")));
    let n = 0;
    for (const t of live) {
      if (!files.has(`${t.id}.sqlite`)) continue;
      await this.harness(t.id);
      n++;
    }
    return n;
  }

  private async liveJobTasks(taskId: TaskId): Promise<PdTaskId[]> {
    const { h } = await this.harness(taskId);
    const insp = await h.inspect(ctx);
    return insp.tasks.filter((t) => JOB_KINDS.has(t.record.kind)).map((t) => t.record.id as PdTaskId);
  }

  private async create(taskId: TaskId, make: (tasks: JobTasks) => { def: unknown; input: unknown }): Promise<void> {
    const { h, root } = await this.harness(taskId);
    const { def, input } = make(this.tasks);
    // biome-ignore lint: each definition carries its own input type; `make` pairs them.
    await h.commit((tx) => tx.createTask(def as any, input as any, { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
    h.resume();
  }

  /** Find the task a signal belongs to. */
  async taskFor(signal: Signal): Promise<TaskRecord | null> {
    const l = this.deps.ledger;
    switch (signal.type) {
      case "issue_labeled":
        return l.findByIssue(signal.repo, signal.issueNumber);
      case "issue_comment":
        return (await l.findByPr(signal.repo, signal.issueNumber)) ?? (await l.findByIssue(signal.repo, signal.issueNumber));
      case "pr_review_comment":
      case "pr_merged":
      case "pr_closed":
        return l.findByPr(signal.repo, signal.prNumber);
      case "ci_completed":
        return l.findByHeadSha(signal.repo, signal.headSha);
    }
  }

  /** The one entry point for signals: rules decide, the job acts. Safe to call twice with the same signal. */
  async handle(signal: Signal): Promise<Action & { taskId?: TaskId }> {
    const task = await this.taskFor(signal);
    const action = decide(task, signal, this.deps.rules);
    this.deps.log("signal", { type: signal.type, id: signal.id, action: action.kind, taskId: task?.id });
    const l = this.deps.ledger;
    switch (action.kind) {
      case "ignore":
        return action;
      case "start_task": {
        if (signal.type !== "issue_labeled") return action;
        const routed = this.opts.modelRouting
          ? pickModel({ title: signal.title, labels: signal.labels ?? [signal.label] }, this.opts.modelRouting)
          : { model: this.opts.harnessInfo.model, reason: "default" };
        this.deps.log("model routed", { issue: signal.issueNumber, model: routed.model, reason: routed.reason });
        const { record, appended } = await l.createTask({
          id: newTaskId(),
          factoryVersion: this.opts.factoryVersion(),
          source: {
            kind: "github_issue",
            repo: signal.repo,
            issueNumber: signal.issueNumber,
            url: `https://github.com/${signal.repo.owner}/${signal.repo.name}/issues/${signal.issueNumber}`,
          },
          title: signal.title,
          ask: signal.body,
          harness: { name: this.opts.harnessInfo.name, model: routed.model },
          dedupeKey: `signal:${signal.id}`,
          at: signal.at,
        });
        if (!appended) return { ...action, taskId: record.id };
        await this.create(record.id, (t) => ({ def: t.Intake, input: { taskId: record.id } }));
        void this.foremanSay(record.id, "ack", "", `ack:${signal.id}`);
        return { ...action, taskId: record.id };
      }
      case "review_round":
      case "retry": {
        if (!task) return action;
        const on = signal.type === "pr_review_comment" || (task.pr && "issueNumber" in signal && signal.issueNumber === task.pr.number) ? "pr" : "issue";
        const { appended } = await l.append(task.id, "comment_received", { author: signal.actor.login, isBot: signal.actor.isBot, on }, { dedupeKey: `signal:${signal.id}` });
        if (!appended) return { ...action, taskId: task.id };
        const after = (await this.liveJobTasks(task.id)) as unknown as number[];
        if (action.kind === "retry" && !task.pr) {
          await this.create(task.id, (t) => ({ def: t.Intake, input: { taskId: task.id } }));
        } else {
          await this.create(task.id, (t) => ({
            def: t.Review,
            input: { taskId: task.id, body: action.body, round: task.people.reviewRounds + 1, after },
          }));
        }
        const target = task.pr ? { repo: task.source.repo, issueOrPr: task.pr.number } : issueTarget(task);
        if (target)
          void this.deps.chat
            .post(target, after.length ? "Got it. I'll pick this up as soon as the current turn finishes." : "Got it, working on it.")
            .catch(() => {});
        return { ...action, taskId: task.id };
      }
      case "foreman_reply": {
        if (!task) return action;
        const { appended } = await l.append(task.id, "comment_received", { author: signal.actor.login, isBot: signal.actor.isBot, on: "issue" }, { dedupeKey: `signal:${signal.id}` });
        if (appended) await this.foremanSay(task.id, "question", action.body, `q:${signal.id}`);
        return { ...action, taskId: task.id };
      }
      case "finalize": {
        if (!task) return action;
        if (await l.seen(`signal:${signal.id}`)) return { ...action, taskId: task.id };
        await l.append(task.id, "signal_received", { type: signal.type, actor: signal.actor.login }, { dedupeKey: `signal:${signal.id}` });
        const { h } = await this.harness(task.id);
        for (const id of await this.liveJobTasks(task.id)) await h.abortTask(id, ctx).catch(() => {});
        await this.create(task.id, (t) => ({
          def: t.Finalize,
          input: { taskId: task.id, outcome: action.outcome, detail: action.mergeSha ? `merge ${action.mergeSha}` : "closed", at: signal.at },
        }));
        return { ...action, taskId: task.id };
      }
      case "record_ci": {
        if (!task || signal.type !== "ci_completed") return action;
        await l.append(task.id, "ci_completed", { headSha: signal.headSha, conclusion: signal.conclusion, name: signal.name }, { dedupeKey: `signal:${signal.id}` });
        return { ...action, taskId: task.id };
      }
    }
  }

  /**
   * Stop a task from the API: abort its running job, put its environment to sleep, and mark it failed
   * (stage "cancelled"), so a later comment can still resume it. Returns null when the task is unknown.
   */
  async cancel(taskId: TaskId, by: string, reason?: string): Promise<TaskRecord | null> {
    const l = this.deps.ledger;
    const task = await l.getTask(taskId);
    if (!task) return null;
    if (isTerminal(task.status)) return task;
    const { h } = await this.harness(taskId);
    for (const id of await this.liveJobTasks(taskId)) await h.abortTask(id, ctx).catch(() => {});
    await l.append(taskId, "cancelled", reason ? { by, reason } : { by });
    const record = await l.setStatus(taskId, "failed", "cancelled");
    await sleepAll(this.deps, taskId);
    await scoreAndExport(this.deps, taskId);
    const target = record.pr ? { repo: record.source.repo, issueOrPr: record.pr.number } : issueTarget(record);
    if (target) await this.deps.chat.post(target, `Stopped by ${by}${reason ? `: ${reason}` : "."} Comment again to resume.`).catch(() => {});
    return (await l.getTask(taskId)) ?? record;
  }

  /** Have the foreman post in the issue. Failures are logged; the foreman never blocks the job. */
  async foremanSay(taskId: TaskId, kind: "ack" | "question", text: string, requestId: string): Promise<void> {
    try {
      const record = await this.deps.ledger.getTask(taskId);
      if (!record) return;
      const target = issueTarget(record);
      if (!target) return;
      const { h, root } = await this.harness(taskId);
      const events = await this.deps.ledger.events(taskId);
      const reply = await askForeman(h, root, { kind, record, events, text, requestId }, ctx);
      const posted = await this.deps.chat.post(target, reply.text);
      await this.deps.ledger.append(taskId, "foreman_replied", { url: posted.url, usage: reply.usage }, { dedupeKey: `foreman:${requestId}` });
    } catch (e) {
      this.deps.log("foreman failed", { taskId, error: String(e) });
    }
  }

  /** Wait until a task's job has nothing running (tests and the CLI). */
  async idle(taskId: TaskId): Promise<void> {
    const { h } = await this.harness(taskId);
    for (;;) {
      const live = await this.liveJobTasks(taskId);
      if (live.length === 0) return;
      await Promise.all(live.map((id) => h.waitForTask(id, ctx).catch(() => {})));
    }
  }

  async close(): Promise<void> {
    for (const p of this.open.values()) {
      const { h } = await p.catch(() => ({ h: null as Harness | null }));
      await h?.close(ctx).catch(() => {});
    }
    this.open.clear();
  }
}
