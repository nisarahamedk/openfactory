import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** A cell value in a custom table. Like DX custom tables: plain SQL scalars only. */
export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

export const Deployment = z.object({
  id: z.string(),
  service: z.string(),
  environment: z.string(),
  commitSha: z.string(),
  repo: z.string(), // "owner/name"
  deployedAt: z.string(),
  success: z.boolean(),
});
export type Deployment = z.infer<typeof Deployment>;

export const Incident = z.object({
  id: z.string(),
  title: z.string(),
  severity: z.string(),
  startedAt: z.string(),
  resolvedAt: z.string().nullable(),
  /** PRs the incident is attributed to, as "owner/name#123". */
  linkedPrs: z.array(z.string()),
});
export type Incident = z.infer<typeof Incident>;

const Snapshot = z.object({
  tables: z.record(z.string(), z.object({ key: z.array(z.string()), rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))) })),
  deployments: z.array(Deployment),
  incidents: z.array(Incident),
});
type Snapshot = z.infer<typeof Snapshot>;

/**
 * The fake DX data: custom tables (keyed upserts), deployments and incidents.
 * In memory, optionally persisted to one JSON file after every write (atomic rename).
 */
export class DxStore {
  private data: Snapshot;

  constructor(private readonly file: string | null) {
    this.data = file !== null && existsSync(file)
      ? Snapshot.parse(JSON.parse(readFileSync(file, "utf8")))
      : { tables: {}, deployments: [], incidents: [] };
  }

  /** Insert or replace rows by the table's key columns. The first write fixes the key. */
  upsert(table: string, key: string[], rows: Row[]): { inserted: number; updated: number } {
    const t = (this.data.tables[table] ??= { key, rows: [] });
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      for (const k of t.key) if (row[k] === undefined || row[k] === null) throw new DxError(400, `row is missing key column "${k}"`);
      const idx = t.rows.findIndex((r) => t.key.every((k) => r[k] === row[k]));
      if (idx === -1) {
        t.rows.push(row);
        inserted++;
      } else {
        t.rows[idx] = { ...t.rows[idx], ...row };
        updated++;
      }
    }
    this.save();
    return { inserted, updated };
  }

  rows(table: string): Row[] {
    const t = this.data.tables[table];
    if (t === undefined) throw new DxError(404, `relation "custom.${table}" does not exist`);
    return t.rows;
  }

  tables(): Array<{ name: string; key: string[]; rowCount: number }> {
    return Object.entries(this.data.tables).map(([name, t]) => ({ name, key: t.key, rowCount: t.rows.length }));
  }

  addDeployment(d: Deployment): void {
    this.data.deployments = this.data.deployments.filter((x) => x.id !== d.id);
    this.data.deployments.push(d);
    this.save();
  }

  upsertIncident(i: Incident): void {
    this.data.incidents = this.data.incidents.filter((x) => x.id !== i.id);
    this.data.incidents.push(i);
    this.save();
  }

  deployments(): Deployment[] {
    return this.data.deployments;
  }

  incidents(): Incident[] {
    return this.data.incidents;
  }

  private save(): void {
    if (this.file === null) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }
}

/** An expected client error with the HTTP status the API returns for it. */
export class DxError extends Error {
  constructor(readonly status: 400 | 401 | 404, message: string) {
    super(message);
  }
}
