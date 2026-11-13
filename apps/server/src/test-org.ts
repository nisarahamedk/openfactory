/** Test helper: the org parts of AppDeps on a fresh PGlite store, with two teams. */
import { PGlite } from "@electric-sql/pglite";
import type { Team, TaskId } from "@openfactory/contracts";
import { AppStore } from "@openfactory/ledger";
import { drizzle } from "drizzle-orm/pglite";
import { factoryViews } from "./org.js";

export const TEAMS: Team[] = [
  { slug: "core", name: "Core", source: "config", members: [{ login: "dana", name: null, role: "maintainer" }, { login: "li", name: null, role: "member" }], repos: ["o/r"], factory: "default" },
  { slug: "payments", name: "Payments", source: "config", members: [{ login: "omar", name: null, role: "member" }], repos: ["o/pay"], factory: "payments" },
];

export async function orgDeps(message: (id: TaskId, author: string, text: string) => Promise<null> = async () => null) {
  const store = new AppStore(drizzle(new PGlite()));
  await store.migrate();
  return {
    store,
    teams: async () => TEAMS,
    factories: async () => factoryViews({ payments: { extends: "default", scorers: ["ledger-balances"], benchmarks: [], world: "payments-30d" } }, TEAMS),
    message,
  };
}
