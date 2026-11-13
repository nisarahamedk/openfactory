import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { Ledger } from "./store.js";

/** Open the ledger on a Postgres URL and make sure the tables exist. */
export async function openPostgresLedger(url: string): Promise<{ ledger: Ledger; close(): Promise<void> }> {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const ledger = new Ledger(drizzle(client));
  await ledger.migrate();
  return { ledger, close: () => client.end() };
}
