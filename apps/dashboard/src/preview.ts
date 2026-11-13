#!/usr/bin/env node
/**
 * The app against made-up data, for design work and screenshots: an in-memory stand-in for the
 * factory server's /v1 with three teams, ~80 tasks over 60 days, late outcomes, a team factory,
 * a rollout and saved views. Nothing real is called.
 *
 *   node dist/preview.js            # http://localhost:8787, signed in as anyone you pick
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Evidence, LedgerEvent, Outcome, RolloutState, SavedView, Team, TaskRecord, TaskStatus } from "@openfactory/contracts";
import { FactoryApi } from "@openfactory/client";
import { createDashboard } from "./app.js";

const NOW = Date.parse("2026-11-13T15:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;

export const TEAMS: Team[] = [
  { slug: "web", name: "Web", source: "github:acme/web", members: ["dana", "li", "sam", "ines"].map((login, i) => ({ login, name: null, role: i === 1 ? ("maintainer" as const) : ("member" as const) })), repos: ["acme/web", "acme/design-system"], factory: "default" },
  { slug: "payments", name: "Payments", source: "github:acme/payments", members: ["omar", "kai", "rosa"].map((login, i) => ({ login, name: null, role: i === 0 ? ("maintainer" as const) : ("member" as const) })), repos: ["acme/payments-api", "acme/ledger"], factory: "payments" },
  { slug: "platform", name: "Platform", source: "github:acme/platform", members: ["noor", "tom"].map((login) => ({ login, name: null, role: "member" as const })), repos: ["acme/infra", "acme/api"], factory: "default" },
];

const ASKS: Record<string, string[]> = {
  web: ["Show usage limits on the billing page", "Add CSV export to the reports page", "Paginate the activity list", "Fix the date picker in Safari", "Add dark mode to settings", "Fix flaky checkout e2e test", "Empty state for the projects page", "Copy changes on the pricing page", "Use the design-system usage bar", "Keyboard shortcuts for the editor"],
  payments: ["Partial refunds for split shipments", "Retry failed payouts with backoff", "Refund to original card after chargeback", "Add idempotency keys to the payout API", "Migrate refunds table to bigint amounts", "Webhook for failed payouts", "Fix rounding in currency conversion", "Reconcile ledger entries nightly"],
  platform: ["Rate-limit the public API", "Upgrade Drizzle to 0.45", "Add request ids to API logs", "Speed up the dashboard query", "Add a health endpoint to the worker", "Bump Node to 22 in CI"],
};

function makeTasks(): { tasks: TaskRecord[]; events: Record<string, LedgerEvent[]> } {
  const tasks: TaskRecord[] = [];
  const events: Record<string, LedgerEvent[]> = {};
  let n = 0;
  for (let day = 58; day >= 0; day--) {
    const count = rnd() < 0.35 ? 0 : 1 + Math.floor(rnd() * 2.2);
    for (let k = 0; k < count; k++) {
      const team = pick(TEAMS);
      const who = pick(team.members).login;
      const title = pick(ASKS[team.slug]!);
      const created = NOW - day * D - rnd() * 10 * H;
      const id = `task_${(++n).toString(36).padStart(3, "0")}k${Math.floor(rnd() * 1e6).toString(36)}`;
      const model = /copy|empty state|dark mode|e2e|bump/i.test(title) ? "claude-haiku" : "claude-sonnet";
      const version = day > 30 ? "2026-10-14.2" : day > 7 ? "2026-11-06.1" : rnd() < 0.15 ? "2026-11-12.1" : "2026-11-06.1";
      const repo = pick(team.repos);
      const [owner, name] = repo.split("/") as [string, string];
      const ageH = (NOW - created) / H;
      let status: TaskStatus;
      if (ageH < 3) status = pick(["working", "working", "preparing"] as const);
      else if (ageH < 30) status = pick(["awaiting_review", "awaiting_review", "iterating", "merged"] as const);
      else status = rnd() < 0.8 ? "merged" : rnd() < 0.6 ? "failed" : "closed";
      const cost = Math.round((model === "claude-haiku" ? 0.15 + rnd() * 0.6 : 0.9 + rnd() * 3.4) * 100) / 100;
      const pr = status === "preparing" || (status === "working" && rnd() < 0.6) ? null : { number: 100 + n, url: `https://github.com/${repo}/pull/${100 + n}`, headSha: `h${n}abcdef` };
      const mergedAt = created + (4 + rnd() * 40) * H;
      const outcomes: Outcome[] = [];
      if (status === "merged") {
        outcomes.push({ kind: "merged", source: "github", detail: `merge ${(n * 7919).toString(16).padStart(7, "0")}`, at: iso(mergedAt), arrivedAt: iso(mergedAt) });
        const risky = team.slug === "payments" && /refund|payout|rounding/i.test(title);
        const r = rnd();
        if ((risky && r < 0.35) || r < 0.05) {
          const kind = pick(["reverted", "hotfix", "incident_linked", "rework"] as const);
          const at = mergedAt + (1 + rnd() * 6) * D;
          if (at < NOW) outcomes.push({ kind, source: kind === "incident_linked" ? "dxfake" : "github", detail: kind === "reverted" ? `reverted by PR #${300 + n}` : kind === "hotfix" ? `fixed by PR #${300 + n}: ${risky ? "refunds paid twice" : "null check"} (2 shared files)` : kind === "incident_linked" ? `INC-${80 + n}: ${risky ? "refunds paid twice" : "5xx spike"}` : `reworked by PR #${300 + n}`, at: iso(at), arrivedAt: iso(at + 2 * H) });
        }
      }
      const evidence: Evidence[] = pr
        ? [
            { kind: "screenshot", title: "Billing page, free plan", url: "https://example.com/s1.png", commitSha: pr.headSha!, environment: `devspace:${id}`, createdAt: iso(created + 2 * H) },
            ...(team.slug === "web" ? [{ kind: "test-user" as const, title: "Free plan, 85% used", url: "https://example.com/login", commitSha: pr.headSha!, environment: `devspace:${id}`, createdAt: iso(created + 2 * H), testUser: { role: "free user", state: "Free plan, 85% used", loginUrl: "https://example.com/login?as=free-85" } }, { kind: "test-user" as const, title: "Pro plan, over the limit", url: "https://example.com/login", commitSha: pr.headSha!, environment: `devspace:${id}`, createdAt: iso(created + 2 * H), testUser: { role: "pro user", state: "Pro plan, over the limit", loginUrl: "https://example.com/login?as=pro-over" } }] : []),
            { kind: "test-output", title: "e2e: 3 passed", url: "https://example.com/e2e.txt", commitSha: pr.headSha!, environment: `devspace:${id}`, createdAt: iso(created + 2 * H) },
          ]
        : [];
      const rounds = status === "merged" ? Math.floor(rnd() * 2.5) : 0;
      const t: TaskRecord = {
        id,
        factoryVersion: version,
        versionArm: version === "2026-11-12.1" ? "candidate" : "stable",
        source: { kind: "github_issue", repo: { host: "github", owner, name }, issueNumber: 40 + n, url: `https://github.com/${repo}/issues/${40 + n}` },
        title,
        ask: `${title}.\n\nDone when: it works in the environment for the states that matter, with a test.`,
        status,
        harness: { name: "claude-code", model },
        harnessSessionId: null,
        environment: pr ? { plugin: "devspace", name: `task-${id}` } : null,
        workspace: null,
        branch: pr ? `factory/${id}` : null,
        pr,
        usage: { inputTokens: Math.round(cost * 200_000), outputTokens: Math.round(cost * 20_000), costUsd: cost },
        people: { comments: rounds * 2, reviewRounds: rounds },
        evidence,
        scores: [],
        outcomes,
        requestedBy: who,
        labels: ["factory"],
        risk: pr ? { level: team.slug === "payments" && /refund|payout|migrat/i.test(title) ? "high" : /copy|empty|dark/i.test(title) ? "low" : "medium", reasons: team.slug === "payments" ? ["Touches money paths."] : ["Touches UI, no migrations or auth."], headSha: pr.headSha! } : null,
        worldChecks: pr && team.slug === "payments" ? [{ world: "payments-30d", headSha: pr.headSha!, simDays: 30, status: outcomes.some((o) => o.kind !== "merged") ? "failed" : "passed", startedAt: iso(created + 3 * H), finishedAt: iso(created + 3.1 * H), invariants: [{ name: "money conserved", ok: !outcomes.some((o) => o.kind !== "merged"), detail: "" }], metrics: [], reportUrl: null }] : [],
        createdAt: iso(created),
        updatedAt: iso(Math.min(NOW, status === "merged" ? mergedAt : created + 2 * H)),
      };
      tasks.push(t);
      const ev = (type: string, at: number, data: Record<string, unknown>): LedgerEvent => ({ taskId: id, at: iso(at), type, data });
      events[id] = [
        ev("task_created", created, {}),
        ev("turn_started", created + 0.1 * H, { reason: "intake" }),
        ...(status === "working" || status === "preparing" ? [] : [ev("turn_finished", created + 1.5 * H, { reason: "intake", usage: t.usage, stopReason: "end_turn", summary: `I ${title.toLowerCase()}. Tested it in the task's environment: e2e passed, screenshots attached.` })]),
        ...(pr ? [ev("pr_opened", created + 1.6 * H, { number: pr.number, url: pr.url, headSha: pr.headSha }), ev("pr_stats", created + 1.6 * H, { headSha: pr.headSha, additions: 40 + Math.floor(rnd() * 300), deletions: Math.floor(rnd() * 80), changedFiles: 2 + Math.floor(rnd() * 9) }), ev("comment_received", created + (3 + rnd() * 18) * H, { author: pick(team.members).login, isBot: false, on: "pr" })] : []),
        ...(status === "merged" ? [ev("status_changed", mergedAt, { from: "awaiting_review", to: "merged" })] : []),
      ];
    }
  }
  return { tasks: tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), events };
}

export function previewServer() {
  const { tasks, events } = makeTasks();
  const views: SavedView[] = [
    { id: "view_a1", name: "Is our factory working?", path: "/insights?scope=team:payments&days=90&measure=came_back&by=month&split=model", owner: "omar", share: "team", team: "payments", createdAt: iso(NOW - 9 * D), updatedAt: iso(NOW - 2 * D) },
    { id: "view_a2", name: "Where we wait on review", path: "/insights?scope=team:web&days=30&measure=review_wait&by=repo", owner: "li", share: "team", team: "web", createdAt: iso(NOW - 5 * D), updatedAt: iso(NOW - 5 * D) },
    { id: "view_a3", name: "Leadership monthly", path: "/insights?scope=org&days=90&measure=merged&by=month&split=team", owner: "noor", share: "org", team: null, createdAt: iso(NOW - 20 * D), updatedAt: iso(NOW - 1 * D) },
  ];
  const rollouts: Record<string, { state: RolloutState; history: RolloutState[] }> = {
    default: { state: { factory: "default", live: "2026-11-06.1", candidate: "2026-11-12.1", share: 0.1, updatedBy: "noor", updatedAt: iso(NOW - 26 * H), note: "trial: implement agent checks limits against real traffic" }, history: [{ factory: "default", live: "2026-11-06.1", candidate: null, share: 0, updatedBy: "noor", updatedAt: iso(NOW - 7 * D), note: "promoted" }, { factory: "default", live: "2026-10-14.2", candidate: "2026-11-06.1", share: 0.25, updatedBy: "noor", updatedAt: iso(NOW - 10 * D), note: "trial" }] },
  };
  const s = new Hono();
  s.get("/v1/factory", (c) => c.json({ factory: { version: "2026-11-06.1", providersFrom: "factory.yaml", providers: { agent: { name: "acp", options: {} }, workspace: { name: "k8s", options: {} }, devEnvironment: { name: "devspace", options: {} }, evidence: { name: "s3", options: { bucket: "evidence" } } }, agent: { name: "claude-code", model: "claude-sonnet" }, foreman: { model: "claude-haiku" }, rules: { label: "factory", maxTaskUsd: 8, maxReviewRounds: 4, maxNudges: 2 }, prompts: { system: "You are a careful engineer.", intake: "Do the task.", review: "Address the review.", foreman: "Answer briefly." } } }));
  s.get("/v1/tasks", (c) => c.json({ tasks }));
  s.get("/v1/tasks/:id", (c) => { const t = tasks.find((x) => x.id === c.req.param("id")); return t ? c.json({ task: t }) : c.json({ message: "no such task" }, 404); });
  s.get("/v1/tasks/:id/events", (c) => c.json({ events: events[c.req.param("id")] ?? [] }));
  s.get("/v1/teams", (c) => c.json({ teams: TEAMS }));
  s.get("/v1/factories", (c) => c.json({
    factories: [
      { slug: "default", extends: null, description: "The org default. Every team factory builds on it.", scorers: [], benchmarks: ["core"], world: null, mergeRisk: null, teams: ["web", "platform"] },
      { slug: "payments", extends: "default", description: "Money rules reviewer and ledger checks.", scorers: ["ledger-balances"], benchmarks: ["payments-core"], world: "payments-30d", mergeRisk: { riskyPaths: ["src/refunds/", "src/payouts/"], mediumLines: 150, highLines: 600 }, teams: ["payments"] },
    ],
    rollouts: Object.values(rollouts).map((r) => r.state),
  }));
  s.get("/v1/rollout/:f", (c) => c.json({ rollout: rollouts[c.req.param("f")]?.state ?? null, history: rollouts[c.req.param("f")]?.history ?? [] }));
  s.post("/v1/rollout/:f", async (c) => {
    const b = await c.req.json();
    const prev = rollouts[c.req.param("f")];
    const state: RolloutState = { factory: c.req.param("f"), live: b.live, candidate: b.candidate, share: b.candidate ? b.share : 0, updatedBy: b.by, updatedAt: new Date().toISOString(), note: b.note ?? null };
    rollouts[c.req.param("f")] = { state, history: prev ? [prev.state, ...prev.history] : [] };
    return c.json({ rollout: state });
  });
  s.get("/v1/views", (c) => { const me = c.req.query("viewer"); const mine = TEAMS.filter((t) => t.members.some((m) => m.login === me)).map((t) => t.slug); return c.json({ views: views.filter((v) => v.owner === me || v.share === "org" || (v.share === "team" && mine.includes(v.team ?? ""))) }); });
  s.get("/v1/views/:id", (c) => { const v = views.find((x) => x.id === c.req.param("id")); return v ? c.json({ view: v }) : c.json({ message: "no such view" }, 404); });
  s.post("/v1/views", async (c) => { const b = await c.req.json(); const v: SavedView = { id: `view_${views.length + 10}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...b, team: b.share === "team" ? b.team : null }; views.push(v); return c.json({ view: v }); });
  s.post("/v1/views/:id/delete", (c) => c.json({ deleted: false }));
  s.post("/v1/tasks/:id/messages", async (c) => { const b = await c.req.json(); (events[c.req.param("id")] ??= []).push({ taskId: c.req.param("id"), at: new Date().toISOString(), type: "message_received", data: { author: b.author, text: b.text, url: null } }); const t = tasks.find((x) => x.id === c.req.param("id"))!; t.updatedAt = new Date().toISOString(); return c.json({ task: t, url: null }); });
  s.post("/v1/tasks", (c) => c.json({ issueUrl: "https://github.com/acme/web/issues/999", repo: "acme/web", issueNumber: 999 }, 202));
  s.post("/v1/tasks/:id/benchmark", (c) => c.json({ message: "preview: nothing is captured" }, 409));
  s.post("/v1/tasks/:id/cancel", (c) => c.json({ message: "preview: nothing to stop" }, 409));
  s.get("/v1/bench/tasks", (c) => c.json({ tasks: [] }));
  s.get("/v1/bench/runs", (c) => c.json({ runs: [] }));
  return new FactoryApi({ baseUrl: "http://preview.local", token: null, fetch: (input, init) => Promise.resolve(s.fetch(new Request(input, init))) });
}

if (process.argv[1]?.endsWith("preview.js")) {
  const app = createDashboard(previewServer(), { password: null, models: ["claude-sonnet", "claude-haiku"], now: () => iso(NOW), factoryName: "acme" });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, (i) => console.log(`preview on http://localhost:${i.port}`));
}
