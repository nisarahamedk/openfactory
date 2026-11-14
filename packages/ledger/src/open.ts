import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { AppStore } from "./app-store.js";
import { AuditStore } from "./audit-store.js";
import { JobLog } from "./job-log.js";
import { OrgStore } from "./org-store.js";
import { runMigrations } from "./migrations.js";
import { Ledger } from "./store.js";

/** Open the ledger (and the app's own tables) on a Postgres URL and apply any migrations it hasn't had. */
export async function openPostgresLedger(url: string): Promise<{ ledger: Ledger; app: AppStore; jobs: JobLog; org: OrgStore; audit: AuditStore; close(): Promise<void> }> {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client);
  await runMigrations(db);
  const ledger = new Ledger(db);
  const app = new AppStore(db);
  return { ledger, app, jobs: new JobLog(db), org: new OrgStore(db), audit: new AuditStore(db), close: () => client.end() };
}
