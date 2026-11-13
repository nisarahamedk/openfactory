/**
 * pi-durable `Storage` kept in Postgres: every commit is appended to the task's log in of_job_commits before it is
 * acknowledged, and reads are served from pi-durable's own in-memory storage, rebuilt by replaying the log when the
 * job is opened.
 *
 * Why this shape: pi-durable has one writer per storage, and a task's job is opened by one factory server at a time
 * (the lease in JobLog), so the server holding the lease can keep the read side in memory. Postgres is the record;
 * memory is a cache of it. Replaying through MemoryStorage.commit applies exactly the checks and id/seq rules it
 * applied the first time, so the rebuilt state is the same (storage.test.ts checks this after every conformance case).
 *
 * A failed append leaves memory ahead of the log, so the storage refuses everything after it and the job must be
 * reopened (which replays only what Postgres has). Revisit when task logs get long enough that replay is slow:
 * snapshot the state every N commits.
 */
import type { Context } from "@earendil-works/chord/context";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import type { Lease, LoggedCommit } from "@openfactory/ledger";

/** The part of JobLog this storage uses. */
export type CommitLog = {
  commits(taskId: string): Promise<LoggedCommit[]>;
  append(lease: Lease, commits: LoggedCommit[]): Promise<void>;
};

type Seq = Parameters<Parameters<Storage["commit"]>[1]>[1];
type Batches = Parameters<Storage["commit"]>[0];

export class PostgresJobStorage implements Storage {
  private broken: unknown = null;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly mem: MemoryStorage,
    private readonly log: CommitLog,
    private readonly lease: Lease,
    private readonly onBroken: (error: unknown) => void,
  ) {}

  /**
   * Open a task's job state: replay its log into memory. `lease` must be held (JobLog.acquire). `onBroken` is told
   * once when a write fails, so the owner can close the job and reopen it from the log.
   */
  static async open(log: CommitLog, lease: Lease, context: Context, onBroken: (error: unknown) => void = () => {}): Promise<PostgresJobStorage> {
    const mem = new MemoryStorage();
    for (const c of await log.commits(lease.taskId)) {
      let seq: Seq | undefined;
      const r = await mem.commit([JSON.parse(c.writes) as StorageWrite[]], (_i, s) => (seq = s), context);
      if (r.refused !== undefined || Number(seq) !== c.seq)
        throw new Error(`replaying ${lease.taskId}'s job log diverged at seq ${c.seq}${r.refused !== undefined ? `: ${String(r.refused)}` : ` (got ${String(seq)})`}`);
    }
    return new PostgresJobStorage(mem, log, lease, onBroken);
  }

  private usable(): void {
    if (this.broken !== null) throw new Error(`this job's storage stopped after a failed write; reopen it (${String(this.broken)})`, { cause: this.broken });
  }

  commit(batches: Batches, receive: (index: number, seq: Seq) => void, context: Context): ReturnType<Storage["commit"]> {
    const run = async () => {
      this.usable();
      const stored: Array<[number, Seq]> = [];
      let result: Awaited<ReturnType<Storage["commit"]>> | undefined;
      let failed: unknown;
      try {
        result = await this.mem.commit(batches, (i, s) => stored.push([i, s]), context);
      } catch (e) {
        failed = e;
      }
      if (stored.length > 0) {
        try {
          await this.log.append(
            this.lease,
            stored.map(([i, seq]) => ({ seq: Number(seq), writes: JSON.stringify(batches[i]) })),
          );
        } catch (e) {
          this.broken = e;
          // After this call settles: the owner closes the job, and close waits for the commits underway.
          setTimeout(() => this.onBroken(e), 0);
          throw e;
        }
      }
      for (const [i, s] of stored) receive(i, s);
      if (failed !== undefined) throw failed;
      return result!;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Reads reject (never throw) once the storage stopped. */
  private read<T>(f: () => Promise<T>): Promise<T> {
    try {
      this.usable();
    } catch (e) {
      return Promise.reject(e);
    }
    return f();
  }

  mintId: Storage["mintId"] = () => this.read(() => this.mem.mintId());
  conversation: Storage["conversation"] = (...a) => this.read(() => this.mem.conversation(...a));
  scanConversations: Storage["scanConversations"] = (...a) => this.read(() => this.mem.scanConversations(...a));
  entry: Storage["entry"] = ((...a: unknown[]) => this.read(() => (this.mem.entry as (...x: unknown[]) => Promise<unknown>)(...a))) as Storage["entry"];
  findLatestHeadMarker: Storage["findLatestHeadMarker"] = (...a) => this.read(() => this.mem.findLatestHeadMarker(...a));
  scanEntries: Storage["scanEntries"] = (...a) => this.read(() => this.mem.scanEntries(...a));
  task: Storage["task"] = (...a) => this.read(() => this.mem.task(...a));
  scanTasks: Storage["scanTasks"] = (...a) => this.read(() => this.mem.scanTasks(...a));
  submission: Storage["submission"] = (...a) => this.read(() => this.mem.submission(...a));
  scanSubmissions: Storage["scanSubmissions"] = (...a) => this.read(() => this.mem.scanSubmissions(...a));
  submissionByRequest: Storage["submissionByRequest"] = (...a) => this.read(() => this.mem.submissionByRequest(...a));
  findDocument: Storage["findDocument"] = (...a) => this.read(() => this.mem.findDocument(...a));
  document: Storage["document"] = (...a) => this.read(() => this.mem.document(...a));
  scanDocuments: Storage["scanDocuments"] = (...a) => this.read(() => this.mem.scanDocuments(...a));

  async close(context: Context): Promise<void> {
    await this.queue;
    await this.mem.close(context);
  }
}
