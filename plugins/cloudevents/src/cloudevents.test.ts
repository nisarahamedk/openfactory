import { describe, expect, it } from "vitest";
import { fake, parseCloudEvents, translate, type TranslateContext } from "./index.js";

const ctx: TranslateContext = { factoryLabel: "factory", source: null, now: "2026-11-14T00:00:00.000Z" };
const SHA = "a".repeat(40);
const h = (m: Record<string, string>) => (n: string) => m[n.toLowerCase()];

describe("parseCloudEvents", () => {
  it("reads structured, batch and binary mode", () => {
    const e = fake.changeMerged({ source: "https://ci.acme", repo: "o/r", prNumber: 3 });
    expect(parseCloudEvents(h({ "content-type": "application/cloudevents+json" }), JSON.stringify(e))[0]!.id).toBe(e.id);
    expect(parseCloudEvents(h({ "content-type": "application/cloudevents-batch+json" }), JSON.stringify([e, e]))).toHaveLength(2);
    const bin = parseCloudEvents(h({ "content-type": "application/json", "ce-specversion": "1.0", "ce-id": "x1", "ce-source": "s", "ce-type": "t" }), '{"a":1}');
    expect(bin[0]).toMatchObject({ id: "x1", source: "s", type: "t", data: { a: 1 } });
  });
  it("rejects what isn't a CloudEvent", () => {
    expect(() => parseCloudEvents(h({}), '{"id":"1"}')).toThrow(/not a CloudEvent/);
    expect(() => parseCloudEvents(h({}), "nope")).toThrow(/not JSON/);
  });
});

describe("translate", () => {
  it("Slack mention → ask, with a permalink and the bot mention removed", () => {
    const r = translate(fake.slackMention({ source: "https://acme.slack.com", user: "U1", channel: "C9", channelName: "web", text: "add a CSV export" }), ctx);
    expect(r).toMatchObject({ kind: "ask", ask: "add a CSV export", actor: { kind: "slack", id: "U1" }, place: "C9", origin: { label: "Slack #web" } });
    if (r.kind === "ask") expect(r.origin.url).toMatch(/^https:\/\/acme\.slack\.com\/archives\/C9\/p\d+/);
  });
  it("Teams message → ask", () => {
    const r = translate(fake.teamsMessage({ source: "https://teams.acme", aadObjectId: "aad-1", name: "Ravi", channelId: "19:ch", channelName: "platform", text: "bump node" }), ctx);
    expect(r).toMatchObject({ kind: "ask", ask: "bump node", actor: { kind: "msteams", id: "aad-1" }, place: "19:ch" });
  });
  it("Jira issue with the factory label → ask; without it → ignored", () => {
    const base = { source: "https://acme.atlassian.net", key: "PAY-7", project: "PAY", summary: "Show VAT", reporter: { accountId: "acc1", email: "o@acme.dev", name: "Omar" } };
    const r = translate(fake.jiraIssueCreated({ ...base, labels: ["factory", "ui"] }), ctx);
    expect(r).toMatchObject({ kind: "ask", ask: "Show VAT", place: "PAY", labels: ["ui"], origin: { url: "https://acme.atlassian.net/browse/PAY-7" } });
    expect(translate(fake.jiraIssueCreated({ ...base, labels: [] }), ctx).kind).toBe("ignore");
  });
  it("Datadog triggered alert tagged with the commit → incident outcome; recovery ignored", () => {
    expect(translate(fake.datadogAlert({ title: "5xx on /pricing", sha: SHA, service: "web" }), ctx)).toMatchObject({ kind: "outcome", match: { sha: SHA }, outcome: { kind: "incident_linked" } });
    expect(translate(fake.datadogAlert({ title: "x", sha: SHA, service: "web", transition: "Recovered" }), ctx).kind).toBe("ignore");
  });
  it("Rootly and PagerDuty incidents link by PR URL or task id", () => {
    expect(translate(fake.rootlyIncident({ title: "Checkout down", summary: "after https://github.com/o/r/pull/12", severity: "SEV1" }), ctx)).toMatchObject({ kind: "outcome", match: { repo: "o/r", prNumber: 12 } });
    expect(translate(fake.pagerdutyIncident({ title: "task_abc1234 broke login" }), ctx)).toMatchObject({ kind: "outcome", match: { taskId: "task_abc1234" } });
  });
  it("CDEvents: merge, deploy, rollback, incident, ticket, revert and follow-up fix", () => {
    const s = "https://ci.acme";
    expect(translate(fake.changeMerged({ source: s, repo: "o/r", prNumber: 5 }), ctx)).toMatchObject({ kind: "merge", repo: "o/r", prNumber: 5 });
    expect(translate(fake.changeAbandoned({ source: s, repo: "o/r", prNumber: 5 }), ctx)).toMatchObject({ kind: "close" });
    expect(translate(fake.serviceDeployed({ source: s, service: "web", environment: "prod", repo: "o/r", sha: SHA }), ctx)).toMatchObject({ kind: "outcome", match: { sha: SHA }, outcome: { kind: "deployed", detail: "deployed to prod" } });
    expect(translate(fake.serviceRolledBack({ source: s, service: "web", environment: "prod", repo: "o/r", sha: SHA }), ctx)).toMatchObject({ outcome: { kind: "reverted" } });
    expect(translate(fake.incidentDetected({ source: s, id: "INC-1", description: "p95 up", environment: "prod", service: "web", repo: "o/r", sha: SHA }), ctx)).toMatchObject({ outcome: { kind: "incident_linked" } });
    expect(translate(fake.ticketCreated({ source: s, id: "T-1", summary: "Fix typo", creator: "a@acme.dev", labels: ["factory"], uri: "https://t/1" }), ctx)).toMatchObject({ kind: "ask", actor: { email: "a@acme.dev" } });
    expect(translate(fake.changeReverted({ source: s, repo: "o/r", prNumber: 5, description: "broke pricing" }), ctx)).toMatchObject({ outcome: { kind: "reverted" }, match: { repo: "o/r", prNumber: 5 } });
    expect(translate(fake.changeFixed({ source: s, repo: "o/r", prNumber: 5, description: "fix" }), ctx)).toMatchObject({ outcome: { kind: "hotfix" } });
  });
  it("ignores unknown types and bot messages", () => {
    expect(translate({ specversion: "1.0", id: "1", source: "x", type: "com.example.thing" }, ctx).kind).toBe("ignore");
    const bot = fake.slackMention({ source: "https://acme.slack.com", user: "U1", channel: "C9", text: "hi there" });
    (bot.data as { event: Record<string, unknown> }).event.bot_id = "B1";
    expect(translate(bot, ctx).kind).toBe("ignore");
  });
});
