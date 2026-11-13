/**
 * Numbered, append-only schema migrations. Each runs once, in order, recorded in of_migrations; replicas
 * starting together take an advisory lock so only one applies them.
 *
 * Rules (checked by migrations.test.ts): never edit a released migration, only add the next number. A step must
 * work on a database that already has everything before it. Versions 1 and 2 are the tables that existed before
 * this file (CREATE ... IF NOT EXISTS), so a database made by an older server upgrades cleanly.
 */
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { APP_MIGRATION } from "./app-store.js";
import { MIGRATION } from "./store.js";

export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "ledger: tasks and events", sql: MIGRATION },
  { version: 2, name: "app: saved views and rollouts", sql: APP_MIGRATION },
  {
    version: 3,
    name: "signal cursors (where each signal source got to)",
    sql: `
CREATE TABLE IF NOT EXISTS of_cursors (
  key text PRIMARY KEY,
  at text NOT NULL,
  updated_at timestamptz NOT NULL
);`,
  },
];

const LOCK_ID = 7_241_001; // any constant; shared by every factory server on this database

// biome-ignore lint: drizzle's PgDatabase needs a query-result HKT; any driver works.
type Db = PgDatabase<any, any, any>;

/** Apply every migration this database hasn't had yet. Returns the versions applied now. */
export async function runMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SELECT pg_advisory_xact_lock(${LOCK_ID})`));
    await tx.execute(sql.raw("CREATE TABLE IF NOT EXISTS of_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"));
    const res = (await tx.execute(sql.raw("SELECT version FROM of_migrations"))) as unknown as { rows?: Array<{ version: number }> } | Array<{ version: number }>;
    const rows = Array.isArray(res) ? res : (res.rows ?? []);
    const done = new Set(rows.map((r) => Number(r.version)));
    const applied: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(m.version)) continue;
      for (const stmt of m.sql.split(";").map((s) => s.trim()).filter(Boolean)) await tx.execute(sql.raw(stmt));
      await tx.execute(sql`INSERT INTO of_migrations (version, name) VALUES (${m.version}, ${m.name})`);
      applied.push(m.version);
    }
    return applied;
  });
}
