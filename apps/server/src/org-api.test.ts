import { PGlite } from "@electric-sql/pglite";
import { fake } from "@openfactory/cloudevents";
import type { Outcome, Signal, TaskId } from "@openfactory/contracts";
import { Ledger, OrgStore } from "@openfactory/ledger";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { createOrgRoutes, mergeTeams, type AskInput } from "./org-api.js";

const NOW = "2026-11-14T00:00:00.000Z";
const SHA = "b".repeat(40);

async function setup() {
  const db = drizzle(new PGlite());
  const ledger = new Ledger(db);
  await ledger.migrate();
  const store = new OrgStore(db);
  await store.migrate();
  const asks: AskInput[] = [];
  const signals: Signal[] = [];
  const outcomes: Array<{ taskId: TaskId; outcome: Outcome; ref: string }> = [];
  const app = createOrgRoutes({
    store,
    ledger,
    ask: async (i) => {
      asks.push(i);
      return { issueUrl: "https://github.com/acme/app/issues/7", repo: i.repo ?? "acme/app", issueNumber: 7 };
    },
    onSignal: async (s) => {
      signals.push(s);
    },
    addOutcome: async (taskId, outcome, ref) => {
      outcomes.push({ taskId, outcome, ref });
      return true;
    },
    repos: () => [{ host: "github", owner: "acme", name: "app" }],
    factoryLabel: "factory",
    now: () => NOW,
    log: () => {},
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { app, store, ledger, asks, signals, outcomes, post };
}

it("walks setup: org, repo, sources, teams, factories, people, each step done once it exists", async () => {
  const s = await setup();
  let org = (await (await s.app.request("/org")).json()).org;
  expect(org.setup.filter((x: { done: boolean }) => x.done)).toHaveLength(0);
  await s.post("/org", { name: "Acme", by: "pat", simulated: true });
  await s.post("/org/repos", { repo: "acme/app", by: "pat" });
  await s.post("/org/sources", { id: "slack", kind: "slack", name: "Acme Slack", ceSource: "https://acme.slack.com", uses: ["asks"], routes: { C_PAY: "payments" }, by: "pat" });
  await s.post("/org/sources", { id: "ci", kind: "cdevents", name: "Deploys", ceSource: "https://ci.acme", uses: ["deploys", "outcomes"], by: "pat" });
  expect((await s.post("/org/teams", { slug: "payments", name: "Payments", repos: ["acme/app"], factory: "payments", by: "pat" })).status).toBe(400); // factory first
  expect((await s.post("/org/factories", { slug: "payments", description: "Money rules", scorers: ["ledger-balances"], by: "pat" })).status).toBe(200);
  expect((await s.post("/org/teams", { slug: "payments", name: "Payments", members: [{ login: "omar" }], repos: ["acme/app"], factory: "payments", scope: { paths: ["src/billing/**"], labels: ["billing"] }, by: "pat" })).status).toBe(200);
  const inv = await (await s.post("/org/people", { login: "omar", email: "omar@acme.dev", persona: "engineer", identities: { slack: "U_OMAR" }, by: "pat" })).json();
  expect(inv.person).toMatchObject({ role: "engineer", status: "invited", invitedBy: "pat" });
  await s.app.request("/org/people/omar/join", { method: "POST" });
  org = (await (await s.app.request("/org")).json()).org;
  expect(org.org).toMatchObject({ name: "Acme", simulated: true });
  expect(org.people.map((p: { login: string; persona: string; status: string }) => [p.login, p.persona, p.status])).toEqual([
    ["omar", "engineer", "joined"],
    ["pat", "platform_director", "joined"],
  ]);
  expect(Object.fromEntries(org.setup.map((x: { key: string; done: boolean }) => [x.key, x.done]))).toEqual({ org: true, repo: true, sources: true, teams: true, factories: true, people: true, first_task: false });
  expect(mergeTeams([], org.teams)[0]).toMatchObject({ slug: "payments", source: "app", factory: "payments", members: [{ login: "omar" }] });
});

it("a Slack mention from a linked person asks in their channel's team repo; strangers get an error result", async () => {
  const s = await setup();
  await s.post("/org/sources", { id: "slack", kind: "slack", name: "Acme Slack", ceSource: "https://acme.slack.com", uses: ["asks"], routes: { C_PAY: "payments" }, by: "pat" });
  await s.post("/org/teams", { slug: "payments", name: "Payments", repos: ["acme/pay"], by: "pat" });
  await s.post("/org/people", { login: "omar", persona: "engineer", identities: { slack: "U_OMAR" }, by: "pat" });
  const ev = fake.slackMention({ source: "https://acme.slack.com", user: "U_OMAR", channel: "C_PAY", channelName: "payments", text: "show VAT on invoices" });
  const r = await (await s.post("/events", ev, { "content-type": "application/cloudevents+json" })).json();
  expect(r.results[0]).toMatchObject({ duplicate: false, result: { kind: "ask", url: "https://github.com/acme/app/issues/7" } });
  expect(s.asks[0]).toMatchObject({ ask: "show VAT on invoices", requestedBy: "omar", repo: "acme/pay", team: "payments", origin: { label: "Slack #payments" } });
  // Same event again: CloudEvents source + id dedupe.
  expect((await (await s.post("/events", ev)).json()).results[0].duplicate).toBe(true);
  const stranger = await (await s.post("/events", fake.slackMention({ source: "https://acme.slack.com", user: "U_NOBODY", channel: "C_PAY", text: "do a thing" }))).json();
  expect(stranger.results[0].result).toMatchObject({ kind: "error" });
  expect(stranger.results[0].result.detail).toMatch(/Nobody in the org is linked to slack user U_NOBODY/);
  const log = await (await s.app.request("/events")).json();
  expect(log.events.map((e: { result: { kind: string } }) => e.result.kind)).toEqual(["error", "ask"]);
});

it("a CDEvents merge moves the factory PR; deploys and incidents become outcomes on the right task", async () => {
  const s = await setup();
  const { record } = await s.ledger.createTask({ id: "task_t1", factoryVersion: "fv", source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 3, url: null }, title: "t", ask: "a", harness: { name: "h", model: "m" } });
  await s.ledger.append(record.id, "pr_opened", { number: 12, url: "https://github.com/acme/app/pull/12", headSha: SHA, branch: "factory/t1" });
  const m = await (await s.post("/events", fake.changeMerged({ source: "https://ci.acme", repo: "acme/app", prNumber: 12 }))).json();
  expect(m.results[0].result).toMatchObject({ kind: "signal", taskId: "task_t1" });
  expect(s.signals[0]).toMatchObject({ type: "pr_merged", prNumber: 12, mergeSha: SHA });
  await s.post("/events", fake.serviceDeployed({ source: "https://ci.acme", service: "web", environment: "prod", repo: "acme/app", sha: SHA }));
  await s.post("/events", fake.rootlyIncident({ title: "Checkout 500s", summary: "started after https://github.com/acme/app/pull/12", severity: "SEV2" }));
  await s.post("/events", fake.changeReverted({ source: "https://ci.acme", repo: "acme/app", prNumber: 12, description: "reverted: broke checkout" }));
  expect(s.outcomes.map((o) => [o.taskId, o.outcome.kind])).toEqual([
    ["task_t1", "deployed"],
    ["task_t1", "incident_linked"],
    ["task_t1", "reverted"],
  ]);
  const none = await (await s.post("/events", fake.serviceDeployed({ source: "https://ci.acme", service: "web", environment: "prod", repo: "acme/app", sha: "c".repeat(40) }))).json();
  expect(none.results[0].result.kind).toBe("ignored");
});

describe("mergeTeams", () => {
  it("drops the inferred everyone team once the org has teams", async () => {
    const { mergeTeams } = await import("./org-api.js");
    const everyone = { slug: "everyone", name: "Everyone", source: "inferred", members: [{ login: "a", name: null, role: "member" as const }], repos: ["o/r"], factory: "default" };
    const web = { slug: "web", name: "Web", description: null, members: [{ login: "a", role: "member" as const }], repos: ["o/r"], factory: "web", scope: { paths: [], labels: [] }, createdBy: "a", createdAt: "2026-11-14T00:00:00Z" };
    expect(mergeTeams([everyone] as never, []).map((t) => t.slug)).toEqual(["everyone"]);
    expect(mergeTeams([everyone] as never, [web] as never).map((t) => t.slug)).toEqual(["web"]);
  });
});
