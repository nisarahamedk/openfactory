/**
 * Adapters from the server's infrastructure to the core's ports. Each one only translates: no decisions.
 */
import type { BenchService } from "@openfactory/bench";
import type { Chat, Signal, TaskId, TaskRecord } from "@openfactory/contracts";
import { fail, type AuditLog, type Bench, type CodeHost, type TaskRunner, type TaskStore } from "@openfactory/core";
import type { GitHubClient } from "@openfactory/github";
import type { AuditStore, Ledger } from "@openfactory/ledger";
import { TaskBusy } from "@openfactory/task-job";

/** The ledger as the core's TaskStore. */
export function ledgerTasks(ledger: Ledger): TaskStore {
  return {
    getTask: (id) => ledger.getTask(id),
    listTasks: (f) => ledger.listTasks(f),
    events: (id) => ledger.events(id),
    findByPr: (r, n) => ledger.findByPr(r, n),
    findByHeadSha: (r, sha) => ledger.findByHeadSha(r, sha),
    recordEgress: async (taskId, e) => (await ledger.append(taskId, "egress", e, { dedupeKey: `egress:${taskId}:${e.host}:${e.allowed}:${e.from}` })).appended,
    recordMessage: async (taskId, m, key) => {
      await ledger.append(taskId, "message_received", m, { dedupeKey: key });
    },
  };
}

/** GitHub as the core's CodeHost: issues through the REST client, comments through the chat plugin. */
export function githubCodeHost(gh: Pick<GitHubClient, "request">, chat: Chat): CodeHost {
  return {
    openIssue: async (repo, issue) => {
      const r = await gh.request<{ number: number; html_url: string }>("POST", `/repos/${repo.owner}/${repo.name}/issues`, issue);
      return { number: r.number, url: r.html_url };
    },
    comment: (target, markdown) => chat.post(target, markdown),
  };
}

/** Another server holds the task's lease right now: the caller can try again shortly. */
function busy(taskId: TaskId): never {
  return fail({ code: "TASK_BUSY", taskId, message: `Another factory server is running task ${taskId} right now. Try again in a few seconds.` });
}

/**
 * The job runner as the core's TaskRunner. Signals, cancels and retries share one queue, so a cancel never races
 * a signal for the same task, and the job only records and schedules, so the queue stays quick.
 */
export function queuedRunner(jobs: { handle(s: Signal): Promise<unknown>; cancel(id: TaskId, by: string, reason?: string): Promise<TaskRecord | null>; retry(id: TaskId, by: string): Promise<TaskRecord | null> }, log: (m: string, f?: object) => void): TaskRunner & { enqueue: (s: Signal) => Promise<unknown> } {
  let chain: Promise<unknown> = Promise.resolve();
  const queue = <T>(what: string, run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run);
    chain = next.catch((e) => log(`${what} failed`, { error: String(e) }));
    return next;
  };
  const translated = async <T>(taskId: TaskId, p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof TaskBusy) busy(taskId);
      throw e;
    }
  };
  const signal = (s: Signal) => queue(`signal ${s.type} ${s.id}`, () => jobs.handle(s));
  return {
    enqueue: signal,
    signal,
    cancel: (id, by, reason) => translated(id, queue(`cancel ${id}`, () => jobs.cancel(id, by, reason ?? undefined))),
    retry: (id, by) => translated(id, queue(`retry ${id}`, () => jobs.retry(id, by))),
  };
}

/** The Postgres audit table as the core's AuditLog. */
export function auditLog(store: AuditStore): AuditLog {
  return { record: (e) => store.record(e), list: (o) => store.list(o) };
}

/** The benchmark service as the core's Bench port. */
export function benchPort(svc: BenchService): Bench {
  return { capture: (id) => svc.capture(id), tasks: () => svc.tasks(), start: (i) => svc.start(i), runs: () => svc.runs(), run: (id) => svc.run(id) };
}
