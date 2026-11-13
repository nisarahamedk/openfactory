import { describe, expect, it } from "vitest";
import { cachedDirectory, factoryViews, parseOrgConfig } from "./org.js";

describe("org config", () => {
  it("reads teams written in factory.yaml and team factories", () => {
    const c = parseOrgConfig(`
teams:
  - { slug: core, name: Core, members: [dana, { login: li, role: maintainer }], repos: [acme/app] }
  - { slug: payments, members: [omar], repos: [acme/pay], factory: payments }
factories:
  payments: { scorers: [ledger-balances], world: payments-30d, mergeRisk: { high: ["src/money/**"] } }
`);
    expect(c.directory).toBeNull();
    expect(c.teams!.map((t) => [t.slug, t.name, t.factory, t.members.map((m) => `${m.login}:${m.role}`).join(",")])).toEqual([
      ["core", "Core", "default", "dana:member,li:maintainer"],
      ["payments", "payments", "payments", "omar:member"],
    ]);
    const views = factoryViews(c.factories, c.teams!);
    expect(views.map((v) => [v.slug, v.extends, v.world, v.teams.join(",")])).toEqual([
      ["default", null, null, "core"],
      ["payments", "default", "payments-30d", "payments"],
    ]);
  });

  it("names a directory provider instead of listing teams", () => {
    const c = parseOrgConfig("teams: { github: { org: acme } }\n");
    expect(c.teams).toBeNull();
    expect(c.directory).toEqual({ name: "github", options: { org: "acme" } });
  });

  it("caches the directory and serves the last answer when it fails", async () => {
    let calls = 0;
    let clock = 0;
    const d = cachedDirectory({ name: "x", teams: async () => { calls++; if (calls > 1) throw new Error("down"); return []; } }, 1000, () => clock);
    await d.teams();
    await d.teams();
    expect(calls).toBe(1);
    clock = 5000;
    expect(await d.teams()).toEqual([]);
    expect(calls).toBe(2);
  });
});
