#!/usr/bin/env node
/**
 * Play a simulated org against a real factory, one phase at a time:
 *
 *   org-sim setup       a new org: name, repo, tools, team factories, teams, people (who then join)
 *   org-sim asks [n]    week-one asks from Slack, Microsoft Teams and Jira (the first n)
 *   org-sim status      the org's tasks and where each stands
 *   org-sim review      reviewers answer PRs waiting on them: most approve, one asks for a change
 *   org-sim merge       approved PRs merge (CDEvents change.merged) and deploy (service.deployed)
 *   org-sim outcomes    planted late outcomes: a Datadog alert, a Rootly incident, a revert, a follow-up fix
 *   org-sim rollout     the factory engineer sends a share of a team's new tasks to a candidate version
 *
 * Env: FACTORY_URL, FACTORY_API_TOKEN. State (which task came from which ask) is in ORG_SIM_STATE.
 * The factory runs with MENTIONS=off and its own label, so made-up logins never ping anyone on GitHub.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { FactoryApi } from "@openfactory/client";
import { fake } from "@openfactory/cloudevents";
import type { CloudEvent, TaskRecord } from "@openfactory/contracts";
import { CD, DATADOG, email, FACTORIES, JIRA, PEOPLE, REPO, ROOTLY, SLACK, SOURCES, TEAMS, TEAMS_SRC, WEEK1, type Ask } from "./org.js";

const base = process.env.FACTORY_URL ?? "https://acme-factory.178.105.22.96.sslip.io";
const token = process.env.FACTORY_API_TOKEN ?? null;
const api = new FactoryApi({ baseUrl: base, token });
const STATE = process.env.ORG_SIM_STATE ?? "org-sim-state.json";
type State = { asks: Record<string, { issueUrl: string | null; at: string; changedAt?: string }>; reviewed: Record<string, string>; merged: Record<string, string>; planted: Record<string, string> };
const load = (): State => {
  try {
    return { asks: {}, reviewed: {}, merged: {}, planted: {}, ...JSON.parse(readFileSync(STATE, "utf8")) };
  } catch {
    return { asks: {}, reviewed: {}, merged: {}, planted: {} };
  }
};
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const log = (...a: unknown[]) => console.log(...a);
const person = (login: string) => PEOPLE.find((p) => p.login === login)!;

async function send(events: CloudEvent[]) {
  const res = await fetch(new URL("/v1/events", base), {
    method: "POST",
    headers: { "content-type": "application/cloudevents-batch+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(events),
  });
  const body = (await res.json()) as { results?: Array<{ id: string; result: { kind: string; detail: string; taskId: string | null; url: string | null } }> };
  if (!res.ok) throw new Error(`POST /v1/events ${res.status}: ${JSON.stringify(body)}`);
  return body.results ?? [];
}

async function setup() {
  const pat = "acme-pat";
  await api.setOrg({ name: "Acme", by: pat, simulated: true });
  log("org named by", pat);
  await api.connectRepo({ repo: REPO, by: pat });
  for (const s of SOURCES) await api.connectSource({ ...s, by: pat });
  log("connected", SOURCES.map((s) => s.name).join(", "));
  // The factory engineer makes the team factories; the platform director makes teams and invites people.
  for (const f of FACTORIES) await api.saveFactory({ ...f, by: "acme-sam" });
  for (const t of TEAMS)
    await api.saveTeam({ slug: t.slug, name: t.name, description: t.description, repos: [REPO], factory: t.factory, members: t.members.map((login, i) => ({ login, role: i === 0 ? "maintainer" : "member" })), scope: t.scope, by: pat });
  for (const p of PEOPLE) await api.invite({ login: p.login, name: p.name, email: email(p), persona: p.persona, identities: { slack: p.slack, msteams: p.msteams, jira: p.jira, github: p.login }, by: pat });
  // Everyone but the VP signs in on day one.
  for (const p of PEOPLE) if (p.persona !== "vp") await api.join(p.login);
  const org = await api.org();
  log(org.setup.map((x) => `${x.done ? "✓" : "○"} ${x.title}: ${x.detail}`).join("\n"));
}

function askEvent(a: Ask): CloudEvent {
  const p = person(a.by);
  if (a.via === "slack") return fake.slackMention({ source: SLACK, user: p.slack, channel: a.place, channelName: SOURCES[0]!.routes[a.place] ?? a.place, text: a.text });
  if (a.via === "msteams") return fake.teamsMessage({ source: TEAMS_SRC, aadObjectId: p.msteams, name: p.name, channelId: a.place, channelName: "payments", text: a.text });
  const key = `${a.place}-${100 + WEEK1.indexOf(a)}`;
  return fake.jiraIssueCreated({ source: JIRA, key, project: a.place, summary: a.text.split(": ")[0] ?? a.text, description: a.text, labels: ["acme", ...(a.labels ?? [])], reporter: { accountId: p.jira, email: email(p), name: p.name } });
}

async function asks(n: number) {
  const st = load();
  const todo = WEEK1.filter((a) => !st.asks[a.key]).slice(0, n);
  for (const a of todo) {
    const ev = askEvent(a);
    // Slack and Teams asks carry their labels as text the agent reads; Jira carries them as labels.
    const [r] = await send([ev]);
    log(`${a.key} via ${a.via} by ${a.by}: ${r?.result.kind} ${r?.result.detail}`);
    st.asks[a.key] = { issueUrl: r?.result.url ?? null, at: new Date().toISOString() };
    save(st);
  }
}

async function orgTasks(): Promise<Array<{ key: string; task: TaskRecord }>> {
  const st = load();
  const tasks = await api.listTasks({ limit: 500 });
  const out: Array<{ key: string; task: TaskRecord }> = [];
  for (const [key, a] of Object.entries(st.asks)) {
    const n = a.issueUrl ? Number(/issues\/(\d+)/.exec(a.issueUrl)?.[1]) : NaN;
    const t = tasks.find((x) => x.source.issueNumber === n);
    if (t) out.push({ key, task: t });
  }
  return out;
}

async function status() {
  for (const { key, task } of await orgTasks())
    log(`${task.id} ${task.status.padEnd(15)} $${task.usage.costUsd.toFixed(2)} ${task.harness.model} ${task.factoryVersion} ${task.pr ? `PR #${task.pr.number}` : ""} ${key}`);
}

/** Who reviews: the team's maintainer, unless they asked; then another member. */
const reviewerFor = (login: string) => {
  const team = TEAMS.find((t) => t.members.includes(login));
  return team?.members.find((m) => m !== login) ?? "acme-sam";
};

async function review() {
  const st = load();
  for (const { key, task } of await orgTasks()) {
    if (task.status !== "awaiting_review") continue;
    // After a change request, the next time the task is back in review (and has moved since), it's approved.
    if (st.reviewed[key] === "changes" && Date.parse(task.updatedAt) > Date.parse(st.asks[key]?.changedAt ?? task.updatedAt) + 60_000) {
      await api.approve(task.id, { by: reviewerFor(task.requestedBy ?? ""), note: "Thanks, that covers it." });
      st.reviewed[key] = "approved";
      save(st);
      log(`${key}: approved after the change`);
      continue;
    }
    if (st.reviewed[key]) continue;
    const who = reviewerFor(task.requestedBy ?? "");
    // One change request per org-week, on a payments task (billing paths always get a human look).
    const change = key === "pay-plan-renewal" && !Object.values(st.reviewed).includes("changes");
    const text = change
      ? "Close. Please use the owner's locale for the date (Intl.DateTimeFormat with the browser locale) rather than a fixed en-GB format, and add the cancelled case to the e2e check."
      : "Looks right, and the screenshots match the ask. Approving; ship it.";
    // A change request is a message (it starts a review round); an approval is the Approve action, which never does.
    if (change) await api.postMessage(task.id, { author: who, text });
    else await api.approve(task.id, { by: who, note: text });
    st.reviewed[key] = change ? "changes" : "approved";
    if (change && st.asks[key]) st.asks[key]!.changedAt = new Date().toISOString();
    save(st);
    log(`${key}: ${who} ${change ? "asked for a change" : "approved"}`);
  }
}

async function merge() {
  const st = load();
  for (const { key, task } of await orgTasks()) {
    if (st.merged[key] || st.reviewed[key] !== "approved" || task.status !== "awaiting_review" || !task.pr?.headSha) continue;
    const sha = task.pr.headSha;
    const [m] = await send([fake.changeMerged({ source: CD, repo: REPO, prNumber: task.pr.number })]);
    const [d] = await send([fake.serviceDeployed({ source: CD, service: "firstword", environment: "prod", repo: REPO, sha })]);
    st.merged[key] = sha;
    save(st);
    log(`${key}: merged (${m?.result.detail}), deployed (${d?.result.detail})`);
  }
}

/** Late outcomes planted on what merged: each kind of trouble the factory has to notice after the fact. */
async function outcomes() {
  const st = load();
  const merged = (await orgTasks()).filter(({ key }) => st.merged[key]);
  const pick = (k: string) => merged.find((m) => m.key === k) ?? null;
  const plans: Array<[string, (t: TaskRecord) => CloudEvent]> = [
    ["web-privacy-date", (t) => fake.datadogAlert({ source: DATADOG, title: "Marketing pages: client error rate above 2%", body: `Errors started after deploy of ${t.pr!.headSha}`, sha: t.pr!.headSha!, service: "firstword-web" })],
    ["pay-plan-copy", (t) => fake.rootlyIncident({ source: ROOTLY, title: "Billing portal link broken on plan page", summary: `Owners can't reach billing. Suspected change: https://github.com/${REPO}/pull/${t.pr!.number}`, severity: "SEV2" })],
    ["pay-plan-copy", (t) => fake.changeReverted({ source: CD, repo: REPO, prNumber: t.pr!.number, description: "Reverted after SEV2: billing link pointed at the old route" })],
    ["plat-format-test", (t) => fake.changeFixed({ source: CD, repo: REPO, prNumber: t.pr!.number, description: "Follow-up: test was timezone-dependent and failed on CI runners in UTC+13" })],
  ];
  for (const [k, make] of plans) {
    const m = pick(k);
    const id = `${k}:${plans.findIndex((p) => p[1] === make)}`;
    if (!m || st.planted[id]) continue;
    const [r] = await send([make(m.task)]);
    st.planted[id] = r?.result.detail ?? "sent";
    save(st);
    log(`${k}: ${r?.result.kind} ${r?.result.detail}`);
  }
}

async function rollout(factory: string, candidate: string, share: number) {
  const r = await api.setRollout(factory, { live: "acme-v1", candidate, share, by: "acme-sam", note: `Try ${candidate} on ${Math.round(share * 100)}% of ${factory}'s new tasks` });
  log(r);
}

const [cmd, ...args] = process.argv.slice(2);
const run: Record<string, () => Promise<void>> = {
  setup,
  asks: () => asks(Number(args[0] ?? WEEK1.length)),
  status,
  review,
  merge,
  outcomes,
  rollout: () => rollout(args[0] ?? "web", args[1] ?? "acme-v2-skills", Number(args[2] ?? 0.5)),
};
const f = cmd ? run[cmd] : undefined;
if (!f) {
  console.error(`usage: org-sim ${Object.keys(run).join("|")}`);
  process.exit(2);
}
f().catch((e) => {
  console.error(e);
  process.exit(1);
});
