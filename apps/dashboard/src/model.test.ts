import { describe, expect, it } from "vitest";
import type { Team, TaskRecord } from "@openfactory/contracts";
import { taskFacts } from "./insights.js";
import { explore, filterQuery, inScope, kindOf, lifeOf, matches, parseFilters, parseScope, people } from "./model.js";

const base = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id, factoryVersion: "fv_1", source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 1, url: null },
  title: "Add CSV export", ask: "", status: "merged", harness: { name: "h", model: "sonnet" }, harnessSessionId: null, environment: null, workspace: null, branch: null,
  pr: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 2 }, people: { comments: 0, reviewRounds: 0 }, evidence: [], scores: [],
  outcomes: [{ kind: "merged", source: "github", detail: "merge abc1234", at: "2026-10-01T00:00:00Z", arrivedAt: "2026-10-01T00:00:00Z" }],
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...over,
});
const teams: Team[] = [
  { slug: "core", name: "Core", source: "config", members: [{ login: "dana", name: null, role: "member" }], repos: ["acme/app"], factory: "default" },
  { slug: "pay", name: "Payments", source: "config", members: [{ login: "omar", name: null, role: "member" }], repos: ["acme/pay"], factory: "payments" },
];
const now = "2026-11-13T00:00:00Z";
const f = (t: TaskRecord) => taskFacts(t, []);

describe("model", () => {
  it("parses scopes and filters into a stable query", () => {
    expect(parseScope("team:pay")).toEqual({ kind: "team", team: "pay" });
    expect(parseScope("person:dana")).toEqual({ kind: "person", login: "dana" });
    expect(parseScope("nonsense")).toEqual({ kind: "org" });
    const fl = parseFilters((k) => ({ scope: "team:pay", days: "90", kind: "API" })[k]);
    expect(filterQuery(fl, { kind: "", repo: "acme/pay" })).toBe("scope=team%3Apay&days=90&repo=acme%2Fpay");
  });

  it("puts a task in its asker's team, else its repo's team", () => {
    expect(inScope(base("task_a", { requestedBy: "omar" }), { kind: "team", team: "pay" }, teams)).toBe(true);
    expect(inScope(base("task_a"), { kind: "team", team: "core" }, teams)).toBe(true);
    expect(inScope(base("task_a"), { kind: "person", login: "dana" }, teams)).toBe(false);
  });

  it("classifies kinds by label, then title", () => {
    expect(kindOf(base("task_a", { labels: ["factory", "kind:api"] }))).toBe("API");
    expect(kindOf(base("task_a", { title: "Fix flaky checkout e2e test" }))).toBe("Tests");
    expect(kindOf(base("task_a", { title: "Add a migration for plans" }))).toBe("Data and migrations");
    expect(kindOf(base("task_a"))).toBe("Features");
  });

  it("knows held up, came back and still watching", () => {
    expect(lifeOf(f(base("task_a")), now)).toBe("held");
    expect(lifeOf(f(base("task_a", { outcomes: [{ kind: "merged", source: "g", detail: "merge abc1234", at: "2026-11-10T00:00:00Z", arrivedAt: "x" }] })), now)).toBe("after");
    const back = base("task_a", { outcomes: [...base("t").outcomes, { kind: "hotfix", source: "g", detail: "fixed by #4", at: "2026-10-03T00:00:00Z", arrivedAt: "x" }] });
    expect(lifeOf(f(back), now)).toBe("came_back");
  });

  it("explores a measure by group and split, with the n behind each number", () => {
    const fs = [
      base("task_1", { requestedBy: "dana" }),
      base("task_2", { requestedBy: "omar", harness: { name: "h", model: "haiku" }, outcomes: [...base("t").outcomes, { kind: "reverted", source: "g", detail: "", at: "2026-10-02T00:00:00Z", arrivedAt: "x" }] }),
      base("task_3", { requestedBy: "omar", status: "failed", outcomes: [] }),
    ].map(f);
    const ex = explore(fs, { measure: "came_back", by: "team", split: "model" }, teams, now);
    expect(ex.overall).toEqual({ value: 0.5, n: 2 });
    const pay = ex.rows.find((r) => r.key === "pay")!;
    expect(pay.total).toEqual({ value: 1, n: 1 });
    expect(pay.cells.get("haiku")).toEqual({ value: 1, n: 1 });
    expect(pay.cells.get("sonnet")).toEqual({ value: null, n: 0 });
    const cost = explore(fs, { measure: "cost_per_merged", by: "none", split: "none" }, teams, now);
    expect(cost.overall.value).toBe(3); // $6 over 2 merged
    expect(matches(fs[2]!, parseFilters((k) => ({ state: "failed", days: "0" })[k]), teams, now)).toBe(true);
  });

  it("lists people by name, never by output", () => {
    const fs = [base("task_1", { requestedBy: "omar" }), base("task_2", { requestedBy: "omar" }), base("task_3", { requestedBy: "dana" })].map(f);
    expect(people(fs, teams, { kind: "org" }).map((p) => `${p.login}:${p.asked}`)).toEqual(["dana:1", "omar:2"]);
  });
});
