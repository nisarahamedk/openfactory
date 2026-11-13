/**
 * Postgres ledger: an append-only event log plus the projected task record,
 * written in one transaction so readers never see one without the other.
 */
import {
  TaskRecord,
  type LedgerEvent,
  type LedgerReader,
  type RepoRef,
  type TaskId,
  type TaskStatus,
} from "@openfactory/contracts";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { bigserial, integer, jsonb, pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { apply, newRecord, repoKey, type EventDataOf, type EventType, type NewTask } from "./projection.js";

export const tasks = pgTable(
  "of_tasks",
  {
    id: text("id").primaryKey(),
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number"),
    prNumber: integer("pr_number"),
    status: text("status").notNull(),
    record: jsonb("record").$type<TaskRecord>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  },
  (t) => [index("of_tasks_issue").on(t.repo, t.issueNumber), index("of_tasks_pr").on(t.repo, t.prNumber)],
);

export const events = pgTable(
  "of_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    taskId: text("task_id").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    dedupeKey: text("dedupe_key"),
  },
  (t) => [index("of_events_task").on(t.taskId, t.seq), uniqueIndex("of_events_dedupe").on(t.dedupeKey)],
);

/** Idempotent schema setup, run at server start. Small enough not to need a migration tool yet. */
export const MIGRATION = `
CREATE TABLE IF NOT EXISTS of_tasks (
  id text PRIMARY KEY,
  repo text NOT NULL,
  issue_number integer,
  pr_number integer,
  status text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS of_tasks_issue ON of_tasks (repo, issue_number);
CREATE INDEX IF NOT EXISTS of_tasks_pr ON of_tasks (repo, pr_number);
CREATE TABLE IF NOT EXISTS of_events (
  seq bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES of_tasks(id),
  at timestamptz NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL,
  dedupe_key text
);
CREATE INDEX IF NOT EXISTS of_events_task ON of_events (task_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS of_events_dedupe ON of_events (dedupe_key);
`;

// biome-ignore lint: drizzle's PgDatabase needs a query-result HKT; any driver works.
type Db = PgDatabase<any, any, any>;

export type AppendResult = { record: TaskRecord; appended: boolean };

export class Ledger implements LedgerReader {
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async migrate(): Promise<void> {
    for (const stmt of MIGRATION.split(";").map((s) => s.trim()).filter(Boolean)) {
      await this.db.execute(sql.raw(stmt));
    }
  }

  async createTask(input: Omit<NewTask, "at"> & { at?: string; dedupeKey?: string }): Promise<AppendResult> {
    const at = input.at ?? this.now();
    const record = newRecord({ ...input, at });
    return this.db.transaction(async (tx) => {
      if (input.dedupeKey) {
        const seen = await tx.select().from(events).where(eq(events.dedupeKey, input.dedupeKey)).limit(1);
        if (seen[0]) {
          const existing = await tx.select().from(tasks).where(eq(tasks.id, seen[0].taskId)).limit(1);
          if (existing[0]) return { record: existing[0].record, appended: false };
        }
      }
      await tx.insert(tasks).values({
        id: record.id,
        repo: repoKey(record.source.repo),
        issueNumber: record.source.issueNumber,
        prNumber: null,
        status: record.status,
        record,
        createdAt: at,
        updatedAt: at,
      });
      await tx.insert(events).values({
        taskId: record.id,
        at,
        type: "task_created",
        data: { source: record.source, title: record.title, factoryVersion: record.factoryVersion, requestedBy: record.requestedBy ?? null, labels: record.labels ?? [] },
        dedupeKey: input.dedupeKey ?? null,
      });
      return { record, appended: true };
    });
  }

  /**
   * Append one event and update the record. With `dedupeKey` (e.g. a webhook delivery id) a repeat is a no-op
   * that returns the current record and `appended: false`.
   */
  async append<T extends EventType>(
    taskId: TaskId,
    type: T,
    data: EventDataOf<T>,
    opts: { dedupeKey?: string; at?: string } = {},
  ): Promise<AppendResult> {
    const at = opts.at ?? this.now();
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
      const row = rows[0];
      if (!row) throw new Error(`Ledger: task ${taskId} not found`);
      if (opts.dedupeKey) {
        const seen = await tx.select({ seq: events.seq }).from(events).where(eq(events.dedupeKey, opts.dedupeKey)).limit(1);
        if (seen[0]) return { record: row.record, appended: false };
      }
      const event: LedgerEvent = { taskId, at, type, data: data as Record<string, unknown> };
      const record = apply(row.record, event);
      await tx.insert(events).values({ taskId, at, type, data: event.data, dedupeKey: opts.dedupeKey ?? null });
      await tx
        .update(tasks)
        .set({ record, status: record.status, prNumber: record.pr?.number ?? null, updatedAt: record.updatedAt })
        .where(eq(tasks.id, taskId));
      return { record, appended: true };
    });
  }

  /** Change status, recording the transition. No-op when already there. */
  async setStatus(taskId: TaskId, to: TaskStatus, reason?: string): Promise<TaskRecord> {
    const current = await this.getTask(taskId);
    if (!current) throw new Error(`Ledger: task ${taskId} not found`);
    if (current.status === to) return current;
    const data: EventDataOf<"status_changed"> = reason ? { from: current.status, to, reason } : { from: current.status, to };
    return (await this.append(taskId, "status_changed", data)).record;
  }

  async getTask(id: TaskId): Promise<TaskRecord | null> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    return rows[0]?.record ?? null;
  }

  async listTasks(filter: { status?: TaskStatus; limit?: number } = {}): Promise<TaskRecord[]> {
    const q = this.db.select().from(tasks);
    const rows = await (filter.status ? q.where(eq(tasks.status, filter.status)) : q)
      .orderBy(desc(tasks.createdAt))
      .limit(filter.limit ?? 100);
    return rows.map((r) => r.record);
  }

  async events(id: TaskId): Promise<LedgerEvent[]> {
    const rows = await this.db.select().from(events).where(eq(events.taskId, id)).orderBy(asc(events.seq));
    return rows.map((r) => ({ taskId: r.taskId as TaskId, at: new Date(r.at).toISOString(), type: r.type, data: r.data }));
  }

  async findByIssue(repo: RepoRef, issueNumber: number): Promise<TaskRecord | null> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.repo, repoKey(repo)), eq(tasks.issueNumber, issueNumber)))
      .orderBy(desc(tasks.createdAt))
      .limit(1);
    return rows[0]?.record ?? null;
  }

  async findByPr(repo: RepoRef, prNumber: number): Promise<TaskRecord | null> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.repo, repoKey(repo)), eq(tasks.prNumber, prNumber)))
      .limit(1);
    return rows[0]?.record ?? null;
  }

  async findByHeadSha(repo: RepoRef, sha: string): Promise<TaskRecord | null> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.repo, repoKey(repo)), sql`${tasks.record}->'pr'->>'headSha' = ${sha}`))
      .limit(1);
    return rows[0]?.record ?? null;
  }

  /** Was this delivery already recorded on any task? */
  async seen(dedupeKey: string): Promise<boolean> {
    const rows = await this.db.select({ seq: events.seq }).from(events).where(eq(events.dedupeKey, dedupeKey)).limit(1);
    return rows.length > 0;
  }
}
