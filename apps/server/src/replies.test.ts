import { fake } from "@openfactory/cloudevents";
import { mergeTeams } from "@openfactory/core";
import { describe, expect, it } from "vitest";
import { tellThreads } from "./replies.js";
import { testServer } from "./test-server.js";

const NOW = "2026-11-14T00:00:00.000Z";
const SHA = "b".repeat(40);

describe("mergeTeams", () => {
  it("drops the inferred everyone team once the org has teams", () => {
    const everyone = { slug: "everyone", name: "Everyone", source: "inferred" as const, members: [{ login: "a", name: null, role: "member" as const }], repos: ["o/r"], factory: "default" };
    const web = { slug: "web", name: "Web", description: null, members: [{ login: "a", role: "member" as const }], repos: ["o/r"], factory: "web", scope: { paths: [], labels: [] }, createdBy: "a", createdAt: NOW };
    expect(mergeTeams([everyone], []).map((t) => t.slug)).toEqual(["everyone"]);
    expect(mergeTeams([everyone], [web]).map((t) => t.slug)).toEqual(["web"]);
  });
});

it("answers the asker in their Slack thread as the task moves: record mode, then the Slack API", async () => {
  const s = await testServer({ teams: [] });
  await s.post("/v1/org/sources", { id: "slack", kind: "slack", name: "Acme Slack", ceSource: "https://acme.slack.com", uses: ["asks"], routes: { C_PAY: "payments" } });
  await s.post("/v1/org/teams", { slug: "payments", name: "Payments", repos: ["acme/app"] });
  await s.post("/v1/org/people", { login: "omar", persona: "engineer", identities: { slack: "U_OMAR" } });
  await s.post("/v1/events", fake.slackMention({ source: "https://acme.slack.com", user: "U_OMAR", channel: "C_PAY", channelName: "payments", text: "show VAT on invoices" }));
  const [th] = await s.org.threads();
  expect(th).toMatchObject({ sourceId: "slack", kind: "slack", place: "C_PAY", repo: "acme/app", issueNumber: 100, told: null });
  const { record } = await s.ledger.createTask({ id: "task_r1", factoryVersion: "fv", source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 100, url: null }, title: "VAT on invoices", ask: "a", harness: { name: "h", model: "m" } });
  await s.ledger.setStatus(record.id, "preparing");
  const deps = { store: s.org, ledger: s.ledger, appUrl: "https://app.acme", ceSource: "x", now: () => NOW, log: () => {} };
  const first = await tellThreads(deps);
  expect(first.map((r) => [r.status, r.delivery])).toEqual([["working", "recorded"]]);
  expect(first[0]?.text).toMatch(/On it: "VAT on invoices".*https:\/\/app\.acme\/tasks\/task_r1/);
  expect(await tellThreads(deps)).toEqual([]); // nothing new
  // Switch the source to post with the Slack API; the next news goes to chat.postMessage in the same thread.
  await s.post("/v1/org/sources", { id: "slack", kind: "slack", name: "Acme Slack", ceSource: "https://acme.slack.com", uses: ["asks"], routes: { C_PAY: "payments" }, reply: { mode: "post", tokenEnv: "SLACK_BOT_TOKEN" } });
  await s.ledger.setStatus(record.id, "working");
  await s.ledger.append(record.id, "pr_opened", { number: 12, url: "https://github.com/acme/app/pull/12", headSha: SHA });
  await s.ledger.setStatus(record.id, "awaiting_review");
  const calls: Array<{ url: string; body: { channel: string; thread_ts: string; text: string } }> = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, ts: "2.0" }));
  };
  const second = await tellThreads({ ...deps, fetch: fakeFetch, env: { SLACK_BOT_TOKEN: "xoxb-test" } });
  expect(second.map((r) => [r.status, r.delivery])).toEqual([["awaiting_review", "sent"]]);
  expect(calls[0]).toMatchObject({ url: "https://slack.com/api/chat.postMessage", body: { channel: "C_PAY", thread_ts: th?.thread } });
  expect(calls[0]?.body.text).toMatch(/Ready for review: PR #12/);
});
