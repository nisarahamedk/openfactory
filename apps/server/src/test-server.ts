/**
 * Test helper: the real HTTP app over the real core, with Postgres stores on PGlite and in-memory fakes for the
 * job runner, the code host and benchmarks (packages/core/testing).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { kindOf, translate } from "@openfactory/cloudevents";
import type { Outcome, TaskId, Team } from "@openfactory/contracts";
import { createCore, mergeTeams, type DefinitionRepo } from "@openfactory/core";
import { MemoryBench, MemoryCodeHost, MemoryRunner, MemoryTasks, testFactoryInfo } from "@openfactory/core/testing";
import { AppStore, AuditStore, Ledger, OrgStore } from "@openfactory/ledger";
import { drizzle } from "drizzle-orm/pglite";
import { auditLog, ledgerTasks } from "./adapters/core.js";
import { fileEvidenceStore } from "./adapters/evidence.js";
import { createApp } from "./entrypoints/http.js";
import { factoryViews } from "./org.js";

export const TEAMS: Team[] = [
  { slug: "core", name: "Core", source: "config", members: [{ login: "dana", name: null, role: "maintainer" }, { login: "li", name: null, role: "member" }], repos: ["o/r"], factory: "default" },
  { slug: "payments", name: "Payments", source: "config", members: [{ login: "omar", name: null, role: "member" }], repos: ["o/pay"], factory: "payments" },
];

export async function testServer(opts: { apiToken?: string; teams?: Team[]; repos?: string[]; definitions?: DefinitionRepo } = {}) {
  const db = drizzle(new PGlite());
  const ledger = new Ledger(db);
  await ledger.migrate();
  const store = new AppStore(db);
  await store.migrate();
  const org = new OrgStore(db);
  await org.migrate();
  const auditStore = new AuditStore(db);
  await auditStore.migrate();
  const runner = new MemoryRunner(new MemoryTasks());
  const codeHost = new MemoryCodeHost();
  const bench = new MemoryBench();
  const outcomes: Array<{ taskId: TaskId; outcome: Outcome; key: string }> = [];
  const teams = opts.teams ?? TEAMS;
  const repos = (opts.repos ?? ["o/r", "o/pay", "acme/app", "acme/pay"]).map((r) => {
    const [owner = "", name = ""] = r.split("/");
    return { host: "github" as const, owner, name };
  });
  let tick = 0;
  const allTeams = async () => mergeTeams(teams, await org.teams());
  const core = createCore({
    tasks: ledgerTasks(ledger),
    // Cancels and retries return the ledger's record, as the job runner does.
    runner: { signal: runner.signal, cancel: async (id, by, reason) => (await runner.cancel(id, by, reason), ledger.getTask(id)), retry: async (id, by) => (await runner.retry(id, by), ledger.getTask(id)) },
    outcomes: {
      record: async (taskId, outcome, key) => {
        if (outcomes.some((o) => o.key === key)) return false;
        outcomes.push({ taskId, outcome, key });
        return true;
      },
    },
    codeHost,
    views: store,
    rollouts: store,
    org,
    directory: { teams: async () => teams },
    definitions: opts.definitions ?? null,
    catalog: { info: async () => testFactoryInfo, factories: async () => factoryViews({ payments: { extends: "default", scorers: ["ledger-balances"], benchmarks: [], world: "payments-30d" } }, await allTeams()) },
    health: { report: async () => ({ at: "t", ok: true, checks: [] }) },
    bench,
    translator: { translate, kindOf },
    audit: auditLog(auditStore),
    config: { repos: () => repos, factoryLabel: "factory", mentions: true },
    // A clock that moves, so audit rows and records order the way they happened.
    now: () => new Date(Date.parse("2026-11-14T00:00:00.000Z") + tick++ * 1000).toISOString(),
    log: () => {},
  });
  const evidence = fileEvidenceStore(mkdtempSync(join(tmpdir(), "ev-")), "https://f.example");
  const app = createApp({ core, apiToken: opts.apiToken, publicUrl: "https://f.example", version: "t", evidence, webhook: null, onSignal: runner.signal, log: () => {} });
  const headers = (as: string | null) => ({ "content-type": "application/json", ...(opts.apiToken ? { authorization: `Bearer ${opts.apiToken}` } : {}), ...(as ? { "x-factory-actor": as } : {}) });
  const get = (path: string, as: string | null = null) => app.request(path, { headers: headers(as) });
  const post = (path: string, body: unknown, as: string | null = null, extra: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { ...headers(as), ...extra }, body: JSON.stringify(body) });
  return { app, core, ledger, store, org, auditStore, runner, codeHost, bench, outcomes, evidence, get, post };
}
