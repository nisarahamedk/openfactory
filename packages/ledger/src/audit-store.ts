/**
 * The audit log: every state-changing call through the API, MCP, the app and connected tools, with who made it
 * (the-stack P12: one audit event per action, written by the action wrapper in core). Append-only.
 */
import { randomBytes } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";

export const audit = pgTable("of_audit", {
  id: text("id").primaryKey(),
  at: timestamp("at", { withTimezone: true, mode: "string" }).notNull(),
  capability: text("capability").notNull(),
  risk: text("risk").notNull(),
  actor: text("actor").notNull(),
  via: text("via"),
  agent: text("agent"),
  requestId: text("request_id").notNull(),
  target: text("target"),
  outcome: text("outcome").notNull(),
});

/** Migration 6 (see migrations.ts). Released: never edit it; add a new numbered migration instead. */
export const AUDIT_MIGRATION = `
CREATE TABLE IF NOT EXISTS of_audit (
  id text PRIMARY KEY,
  at timestamptz NOT NULL,
  capability text NOT NULL,
  risk text NOT NULL,
  actor text NOT NULL,
  via text,
  agent text,
  request_id text NOT NULL,
  target text,
  outcome text NOT NULL
);
CREATE INDEX IF NOT EXISTS of_audit_at ON of_audit (at DESC);
CREATE INDEX IF NOT EXISTS of_audit_target ON of_audit (target, at DESC);
`;

const Risk = z.enum(["read", "reversible", "irreversible", "external"]);

/** One audit row, as the API returns it. */
export type AuditRow = {
  id: string;
  at: string;
  capability: string;
  risk: z.infer<typeof Risk>;
  actor: string;
  via: string | null;
  agent: string | null;
  requestId: string;
  target: string | null;
  outcome: string;
};

// biome-ignore lint: drizzle's PgDatabase needs a query-result HKT; any driver works.
type Db = PgDatabase<any, any, any>;

/** Append and read audit rows. */
export class AuditStore {
  constructor(private readonly db: Db) {}

  /** For tests on a fresh database; servers run the numbered migrations instead. */
  async migrate(): Promise<void> {
    for (const stmt of AUDIT_MIGRATION.split(";").map((s) => s.trim()).filter(Boolean)) await this.db.execute(sql.raw(stmt));
  }

  async record(e: Omit<AuditRow, "id">): Promise<void> {
    await this.db.insert(audit).values({ id: `aud_${randomBytes(8).toString("hex")}`, ...e });
  }

  /** Newest first, optionally only one target's rows. */
  async list(opts: { limit: number; target: string | null }): Promise<AuditRow[]> {
    const q = this.db.select().from(audit);
    const rows = await (opts.target === null ? q : q.where(eq(audit.target, opts.target))).orderBy(desc(audit.at)).limit(opts.limit);
    return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString(), risk: Risk.catch("read").parse(r.risk) }));
  }
}
