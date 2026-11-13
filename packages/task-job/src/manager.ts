/**
 * TaskJobs: one pi-durable Harness per factory task (pi-durable has one writer per storage, so each task gets its
 * own storage). The root conversation of that Harness is the task's foreman; the job's own durable tasks run beside it.
 *
 * Where a job keeps its state: in Postgres when `jobLog` is set (the commit log in of_job_commits, see pg-storage.ts),
 * else in a SQLite file per task under dataDir. A task that already has a SQLite file keeps using it, so switching
 * an existing factory to Postgres needs no migration: old tasks finish on their files, new ones start in Postgres.
 *
 * With Postgres, a server runs a task's job only while it holds the task's lease (renewed every leaseMs/3). If a
 * server dies, its leases expire and the sweep on another server (or on the restarted one) takes those tasks over.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, Harness, type Conversation, type TaskId as PdTaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RepoRef, Signal, TaskId, TaskRecord } from "@openfactory/contracts";
import type { JobLog, Lease } from "@openfactory/ledger";
import { askForeman, FOREMAN_INSTRUCTIONS } from "@openfactory/foreman";
import { decide, isTerminal, pickModel, pickVersion, planScope, type Action, type ModelRouting, type Rollout } from "@openfactory/rules";
import { issueTarget, type JobDeps } from "./deps.js";
import { PostgresJobStorage } from "./pg-storage.js";
import { describeError, scoreAndExport, sleepAll } from "./steps.js";
import { jobTasks, type JobTasks } from "./tasks.js";

export type TaskJobsOptions = {
  dataDir: string;
  models: Models;
  foremanModel: { provider: string; modelId: string };
  factoryVersion: () => string;
  harnessInfo: { name: string; model: string };
  /** Which worker model a new task gets (factory.yaml `models:`). Null: always harnessInfo.model. */
  modelRouting?: ModelRouting | null;
  /** A candidate factory version served to a share of new tasks (factory.yaml `rollout:`). */
  rollout?: Rollout | null | ((factory: string) => Promise<Rollout | null>);
  /** Which factory (org default or a team factory) a new task runs on. Missing: always "default". */
  factoryOf?: (task: { requestedBy: string; repo: RepoRef }) => Promise<{ factory: string; team: string | null }>;
  /** Model routing per factory version, when a version changes it. */
  versionModels?: Record<string, ModelRouting>;
  /** Every repo the factory may work in; an issue that names one of them adds it to the task's scope. */
  knownRepos?: RepoRef[];
  /** Keep job state in Postgres (and run each task under a lease) instead of SQLite files. */
  jobLog?: JobLog | null;
  /** This server's name on leases. Default: host, pid and a random suffix. */
  holder?: string;
  /** How long a lease lasts without renewal; a dead server's tasks move after this. Default 60 s. */
  leaseMs?: number;
};

type Open = { h: Harness; root: Conversation; lease?: Lease; renew?: ReturnType<typeof setInterval> };

/** Another factory server is running this task's job right now. */
export class TaskBusy extends Error {
  constructor(readonly taskId: TaskId) {
    super(`another factory server is running task ${taskId}; try again in a minute`);
    this.name = "TaskBusy";
  }
}

const JOB_KINDS = new Set(["factory.intake", "factory.review", "factory.finalize"]);

export function newTaskId(): TaskId {
  return `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Statuses where a job was doing work (not waiting on a person), so a lost job must be rebuilt. */
const MID_WORK = new Set<TaskRecord["status"]>(["received", "preparing", "working", "iterating"]);

export class TaskJobs {
  private readonly open = new Map<TaskId, Promise<Open>>();
  private readonly tasks: JobTasks;
  private readonly extension;
  private readonly holder: string;
  private readonly leaseMs: number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: JobDeps,
    private readonly opts: TaskJobsOptions,
  ) {
    this.tasks = jobTasks(deps);
    this.extension = defineExtension({ name: "factory", tasks: [this.tasks.Intake, this.tasks.Review, this.tasks.Finalize] });
    mkdirSync(join(opts.dataDir, "tasks"), { recursive: true });
    this.holder = opts.holder ?? `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.leaseMs = opts.leaseMs ?? 60_000;
  }

  private sqlitePath(taskId: TaskId): string {
    return join(this.opts.dataDir, "tasks", `${taskId}.sqlite`);
  }

  /** Open a task's storage: its SQLite file if it has one (or there is no Postgres), else Postgres under a lease. */
  private async storage(taskId: TaskId): Promise<{ storage: Parameters<typeof Harness.open>[0]; lease?: Lease }> {
    const log = this.opts.jobLog;
    if (!log || existsSync(this.sqlitePath(taskId))) return { storage: await openNodeSqliteStorage(this.sqlitePath(taskId)) };
    const lease = await log.acquire(taskId, this.holder, this.leaseMs);
    if (!lease) throw new TaskBusy(taskId);
    const onBroken = (e: unknown) => {
      this.deps.log("job storage write failed; closing the job so it reopens from Postgres", { taskId, error: describeError(e) });
      void this.drop(taskId, true, lease);
    };
    return { storage: await PostgresJobStorage.open(log, lease, ctx, onBroken), lease };
  }

  /** Close a task's job here (lease lost, or shutting down). */
  private async drop(taskId: TaskId, release: boolean, only?: Lease): Promise<void> {
    const p = this.open.get(taskId);
    if (!p) return;
    const o = await p.catch(() => null);
    // A job reopened since (a new lease) is not the one to drop.
    if (only && o?.lease !== only) return;
    if (this.open.get(taskId) === p) this.open.delete(taskId);
    if (!o) return;
    if (o.renew) clearInterval(o.renew);
    await o.h.close(ctx).catch(() => {});
    if (release && o.lease) await this.opts.jobLog?.release(o.lease).catch(() => {});
  }

  private harness(taskId: TaskId): Promise<Open> {
    let p = this.open.get(taskId);
    if (!p) {
      p = (async () => {
        const registry = createRegistry();
        registry.install(this.extension);
        const { storage, lease } = await this.storage(taskId);
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
        const o: Open = { h, root, lease };
        if (lease) {
          let renewedAt = Date.now();
          o.renew = setInterval(() => {
            void this.opts.jobLog!.renew(lease, this.leaseMs).then(
              (ok) => {
                if (ok) {
                  renewedAt = Date.now();
                  return;
                }
                this.deps.log("job lease lost; stopping the job here", { taskId });
                void this.drop(taskId, false, lease);
              },
              (e) => {
                this.deps.log("job lease renewal failed", { taskId, error: describeError(e) });
                // Past the lease, another server may have the task: stop here; the sweep reopens it if not.
                if (Date.now() - renewedAt >= this.leaseMs) void this.drop(taskId, false, lease);
              },
            );
          }, Math.max(1000, Math.floor(this.leaseMs / 3)));
          o.renew.unref?.();
        }
        return o;
      })();
      this.open.set(taskId, p);
      p.catch(() => this.open.delete(taskId));
    }
    return p;
  }

  /**
   * Reopen every task that still has work, so sleeping and interrupted jobs continue after a restart.
   *
   * The ledger is the record; a task's job file is only where its durable job keeps its place. When that file
   * is gone (a lost or replaced volume, a new node) a task that was mid-work is rebuilt from the ledger: it
   * starts again from intake, or carries on as a review round once it has a PR. A task waiting for review needs
   * nothing: the next comment starts a fresh job.
   */
  async resumeAll(): Promise<{ resumed: number; rebuilt: number }> {
    const live = (await this.deps.ledger.listTasks({ limit: 500 })).filter((t) => !isTerminal(t.status));
    const files = new Set(readdirSync(join(this.opts.dataDir, "tasks")));
    let resumed = 0;
    let rebuilt = 0;
    for (const t of live) {
      if (this.open.has(t.id)) continue;
      if (files.has(`${t.id}.sqlite`) || (await this.opts.jobLog?.has(t.id))) {
        try {
          await this.harness(t.id);
          resumed++;
        } catch (e) {
          if (!(e instanceof TaskBusy)) throw e;
        }
        continue;
      }
      if (!MID_WORK.has(t.status)) continue;
      // Take the lease first, so two servers starting together don't both rebuild it.
      if (this.opts.jobLog && !(await this.opts.jobLog.acquire(t.id, this.holder, this.leaseMs))) continue;
      await this.deps.ledger.append(t.id, "job_rebuilt", { status: t.status, reason: "the task's job state was missing at start-up" });
      if (!t.pr) await this.create(t.id, (x) => ({ def: x.Intake, input: { taskId: t.id } }));
      else
        await this.create(t.id, (x) => ({
          def: x.Review,
          input: { taskId: t.id, body: "The factory restarted while you were working. Carry on from where you left off and finish the ask.", round: t.people.reviewRounds + 1, after: [] },
        }));
      rebuilt++;
    }
    return { resumed, rebuilt };
  }

  /**
   * With Postgres: every lease period, pick up tasks whose server went away (their leases expired). Call once at
   * start-up, after resumeAll.
   */
  startSweeping(): void {
    if (!this.opts.jobLog || this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.resumeAll().then(
        (r) => (r.resumed || r.rebuilt ? this.deps.log("took over tasks from another server", r) : undefined),
        (e) => this.deps.log("task sweep failed", { error: describeError(e) }),
      );
    }, this.leaseMs);
    this.sweeper.unref?.();
  }

  /** Whether this server may act on a task's job now (always, without Postgres). */
  private async mayRun(taskId: TaskId): Promise<boolean> {
    if (!this.opts.jobLog || this.open.has(taskId) || existsSync(this.sqlitePath(taskId))) return true;
    try {
      await this.harness(taskId);
      return true;
    } catch (e) {
      if (e instanceof TaskBusy) return false;
      throw e;
    }
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
    // Leave a task another server runs to that server (it sees the same signal); recording it here would mark it seen.
    if (task && action.kind !== "ignore" && action.kind !== "record_ci" && !(await this.mayRun(task.id))) {
      this.deps.log("signal left to the server running the task", { taskId: task.id, id: signal.id });
      return { kind: "ignore", reason: "another factory server runs this task" } as Action;
    }
    const l = this.deps.ledger;
    switch (action.kind) {
      case "ignore":
        return action;
      case "start_task": {
        if (signal.type !== "issue_labeled") return action;
        const assigned = this.opts.factoryOf
          ? await this.opts.factoryOf({ requestedBy: signal.actor.login, repo: signal.repo }).catch(() => ({ factory: "default", team: null }))
          : { factory: "default", team: null };
        const rollout = typeof this.opts.rollout === "function" ? await this.opts.rollout(assigned.factory) : (this.opts.rollout ?? null);
        const version = rollout ? pickVersion(signal.id, rollout) : { version: this.opts.factoryVersion(), arm: "stable" as const };
        const routing = this.opts.versionModels?.[version.version] ?? this.opts.modelRouting;
        const labels = signal.labels ?? [signal.label];
        const routed = routing ? pickModel({ title: signal.title, labels }, routing) : { model: this.opts.harnessInfo.model, reason: "default" };
        const { record, appended } = await l.createTask({
          id: newTaskId(),
          factoryVersion: version.version,
          source: {
            kind: "github_issue",
            repo: signal.repo,
            issueNumber: signal.issueNumber,
            url: `https://github.com/${signal.repo.owner}/${signal.repo.name}/issues/${signal.issueNumber}`,
          },
          title: signal.title,
          ask: signal.body,
          requestedBy: signal.actor.login,
          labels: signal.labels ?? [signal.label],
          harness: { name: this.opts.harnessInfo.name, model: routed.model },
          dedupeKey: `signal:${signal.id}`,
          at: signal.at,
        });
        if (!appended) return { ...action, taskId: record.id };
        this.deps.log("model routed", { taskId: record.id, issue: signal.issueNumber, model: routed.model, reason: routed.reason });
        if (this.opts.factoryOf) await l.append(record.id, "factory_assigned", assigned);
        if (rollout?.candidate) await l.append(record.id, "version_routed", { version: version.version, arm: version.arm, share: rollout.share });
        const scope = planScope(signal.repo, { title: signal.title, body: signal.body, labels }, this.opts.knownRepos ?? []);
        if (scope.repos.length > 1)
          await l.append(record.id, "scope_planned", { repos: scope.repos.map((r) => ({ host: "github" as const, owner: r.owner, name: r.name })), reason: scope.reason });
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
    if (target) await this.deps.chat.post(target, `Stopped by ${by}${reason ? `: ${reason}` : "."} Comment again or press Retry in the factory app to resume.`).catch(() => {});
    return (await l.getTask(taskId)) ?? record;
  }

  /**
   * Try a failed or stopped task again, as if someone had commented: a task without a PR starts over from
   * intake (its workspace and environment are woken, not rebuilt); a task with a PR gets a review round that
   * tells the agent to carry on. Returns null when the task is unknown; a task that isn't failed is returned as is.
   */
  async retry(taskId: TaskId, by: string): Promise<TaskRecord | null> {
    const l = this.deps.ledger;
    const task = await l.getTask(taskId);
    if (!task) return null;
    if (task.status !== "failed") return task;
    if ((await this.liveJobTasks(taskId)).length > 0) return task;
    await l.append(taskId, "retry_requested", { by });
    if (!task.pr) await this.create(taskId, (t) => ({ def: t.Intake, input: { taskId } }));
    else
      await this.create(taskId, (t) => ({
        def: t.Review,
        input: { taskId, body: `${by} asked you to try again after the task stopped. Carry on from where you left off and finish the ask.`, round: task.people.reviewRounds + 1, after: [] },
      }));
    const target = task.pr ? { repo: task.source.repo, issueOrPr: task.pr.number } : issueTarget(task);
    if (target) void this.deps.chat.post(target, `Retrying, as ${by} asked.`).catch(() => {});
    return (await l.getTask(taskId)) ?? task;
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
      this.deps.log("foreman failed", { taskId, error: describeError(e) });
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
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const id of [...this.open.keys()]) await this.drop(id, true);
  }
}
