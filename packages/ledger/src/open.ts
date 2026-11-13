import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { AppStore } from "./app-store.js";
import { Ledger } from "./store.js";

/** Open the ledger (and the app's own tables) on a Postgres URL and make sure the tables exist. */
export async function openPostgresLedger(url: string): Promise<{ ledger: Ledger; app: AppStore; close(): Promise<void> }> {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client);
  const ledger = new Ledger(db);
  await ledger.migrate();
  const app = new AppStore(db);
  await app.migrate();
  return { ledger, app, close: () => client.end() };
}
