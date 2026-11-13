/**
 * Where durable task jobs keep their state in Postgres: an append-only log of each task's commits, and a lease per
 * task so only one factory server runs a task's job at a time.
 *
 * The lease is the fence: a server appends only while it holds the task's lease at the epoch it got. Another server
 * can take the lease once it has expired, which raises the epoch, so a server that stalled past its lease (a long GC
 * pause, a partitioned node) finds its next append refused instead of writing over the new holder's work.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";

// biome-ignore lint: drizzle's PgDatabase needs a query-result HKT; any driver works.
type Db = PgDatabase<any, any, any>;

export type Lease = { taskId: string; holder: string; epoch: number };
export type LoggedCommit = { seq: number; writes: string };

/** The lease was lost to another server: stop running this task here. */
export class LeaseLost extends Error {
  constructor(readonly lease: Lease) {
    super(`lost the lease on ${lease.taskId}'s job (held by another factory server now)`);
    this.name = "LeaseLost";
  }
}

const rowsOf = <T>(res: unknown): T[] => (Array.isArray(res) ? res : ((res as { rows?: T[] }).rows ?? [])) as T[];

export class JobLog {
  constructor(private readonly db: Db) {}

  /** Every commit of a task's job, oldest first. */
  async commits(taskId: string): Promise<LoggedCommit[]> {
    const rows = rowsOf<{ seq: string | number; writes: string }>(await this.db.execute(sql`SELECT seq, writes FROM of_job_commits WHERE task_id = ${taskId} ORDER BY seq`));
    return rows.map((r) => ({ seq: Number(r.seq), writes: r.writes }));
  }

  /** Whether a task has any job state here. */
  async has(taskId: string): Promise<boolean> {
    return rowsOf(await this.db.execute(sql`SELECT 1 FROM of_job_commits WHERE task_id = ${taskId} LIMIT 1`)).length > 0;
  }

  /** Append commits under `lease`, all or none. Throws LeaseLost when another server holds the task now. */
  async append(lease: Lease, commits: LoggedCommit[]): Promise<void> {
    if (commits.length === 0) return;
    await this.db.transaction(async (tx) => {
      // FOR SHARE: a server taking the lease over waits for this append to finish, and the next one sees its epoch.
      const held = rowsOf(
        await tx.execute(sql`SELECT 1 FROM of_job_leases WHERE task_id = ${lease.taskId} AND holder = ${lease.holder} AND epoch = ${lease.epoch} FOR SHARE`),
      );
      if (held.length === 0) throw new LeaseLost(lease);
      for (const c of commits) await tx.execute(sql`INSERT INTO of_job_commits (task_id, seq, writes) VALUES (${lease.taskId}, ${c.seq}, ${c.writes})`);
    });
  }

  /**
   * Take a task's lease for `holder`, or renew it if `holder` has it. Returns null while another server holds a
   * lease that hasn't expired.
   */
  async acquire(taskId: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const ttl = `${Math.ceil(ttlMs)} milliseconds`;
    const rows = rowsOf<{ epoch: string | number }>(
      await this.db.execute(sql`
        INSERT INTO of_job_leases (task_id, holder, epoch, expires_at) VALUES (${taskId}, ${holder}, 1, now() + ${ttl}::interval)
        ON CONFLICT (task_id) DO UPDATE SET holder = EXCLUDED.holder, epoch = of_job_leases.epoch + 1, expires_at = EXCLUDED.expires_at
          WHERE of_job_leases.holder = EXCLUDED.holder OR of_job_leases.expires_at < now()
        RETURNING epoch`),
    );
    return rows[0] ? { taskId, holder, epoch: Number(rows[0].epoch) } : null;
  }

  /** Extend a held lease. Returns false when it was lost (taken over after it expired). */
  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    const ttl = `${Math.ceil(ttlMs)} milliseconds`;
    const rows = rowsOf(
      await this.db.execute(
        sql`UPDATE of_job_leases SET expires_at = now() + ${ttl}::interval WHERE task_id = ${lease.taskId} AND holder = ${lease.holder} AND epoch = ${lease.epoch} RETURNING 1`,
      ),
    );
    return rows.length > 0;
  }

  /** Give a lease up (on shutdown), so another server can take the task at once. */
  async release(lease: Lease): Promise<void> {
    await this.db.execute(
      sql`UPDATE of_job_leases SET expires_at = now() - interval '1 second' WHERE task_id = ${lease.taskId} AND holder = ${lease.holder} AND epoch = ${lease.epoch}`,
    );
  }
}
