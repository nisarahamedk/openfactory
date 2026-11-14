import { describe, expect, it } from "vitest";
import type { OrgFactory } from "@openfactory/contracts";
import { DefinitionsReader, githubDefinitions, syncDefinitions, type DefinitionsConfig } from "./definitions.js";

const cfg: DefinitionsConfig = { repo: { host: "github", owner: "acme", name: "factory" }, branch: "main", dir: "factories" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** A fake GitHub REST API: answers by "METHOD path", records every call. */
function fakeGh(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  return {
    calls,
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      if (!(key in routes)) throw new Error(`GitHub ${method} ${path} → 404: Not Found`);
      // SAFETY: the fake returns whatever the test put in `routes` for this call; each test shapes it as the real API does.
      // Verified by: the assertions below on what the adapter does with each answer.
      return routes[key] as T;
    },
  };
}

/** A repo with these files on main, served through the trees and blobs APIs. */
function repo(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const entries = Object.entries(files).map(([path, content], i) => ({ path, type: "blob", sha: `s${i}`, content }));
  return fakeGh({
    "GET /repos/acme/factory/git/trees/main?recursive=1": { truncated: false, tree: [{ path: "factories", type: "tree", sha: "t" }, ...entries.map(({ path, type, sha }) => ({ path, type, sha }))] },
    ...Object.fromEntries(entries.map((e) => [`GET /repos/acme/factory/git/blobs/${e.sha}`, { content: b64(e.content) }])),
    ...extra,
  });
}

const payments: OrgFactory = { slug: "payments", extends: "default", description: "Money rules", scorers: ["ledger-balances"], benchmarks: [], world: "payments-30d", mergeRisk: null, createdBy: "ada", createdAt: "t" };
const writes = {
  "GET /repos/acme/factory/git/ref/heads/main": { object: { sha: "c1" } },
  "GET /repos/acme/factory/git/commits/c1": { tree: { sha: "tree1" } },
  "POST /repos/acme/factory/git/trees": { sha: "tree2" },
  "POST /repos/acme/factory/git/commits": { sha: "c2" },
  "POST /repos/acme/factory/git/refs": {},
  "POST /repos/acme/factory/pulls": { number: 7, html_url: "https://github.com/acme/factory/pull/7" },
};

describe("factory definitions on GitHub", () => {
  it("reads a factory's folder", async () => {
    const gh = repo({ "factories/payments/factory.yaml": "scorers: []\n", "factories/payments/skills/a/SKILL.md": "x", "README.md": "not a factory" });
    expect(await githubDefinitions(gh, cfg).files("payments")).toEqual({ ok: true, files: { "factory.yaml": "scorers: []\n", "skills/a/SKILL.md": "x" } });
    expect(await githubDefinitions(gh, cfg).files("growth")).toEqual({ ok: true, files: null });
  });

  it("proposes file changes as one commit on a new branch and a pull request", async () => {
    const gh = repo({}, writes);
    const r = await githubDefinitions(gh, cfg, () => "2026-11-14T03:50:00.000Z").proposeFiles("payments", { "AGENTS.md": "Keep it small.", "skills/old/SKILL.md": null }, "ada", "Change payments");
    expect(r).toEqual({ ok: true, number: 7, url: "https://github.com/acme/factory/pull/7" });
    expect(gh.calls.find((c) => c.path.endsWith("/git/trees"))?.body).toEqual({
      base_tree: "tree1",
      tree: [
        { path: "factories/payments/AGENTS.md", mode: "100644", type: "blob", content: "Keep it small." },
        { path: "factories/payments/skills/old/SKILL.md", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(gh.calls.find((c) => c.path.endsWith("/git/refs"))?.body).toEqual({ ref: "refs/heads/factory/payments-20261114035000", sha: "c2" });
  });

  it("changes only the settings in factory.yaml, keeping comments and other keys", async () => {
    const gh = repo({ "factories/payments/factory.yaml": "# owned by payments\nlabel: v3\nscorers: []\n" }, writes);
    await githubDefinitions(gh, cfg).proposeFactory(payments, "ada");
    const yaml = (gh.calls.find((c) => c.path.endsWith("/git/trees"))?.body as { tree: { content: string }[] }).tree[0]?.content ?? "";
    expect(yaml).toContain("# owned by payments");
    expect(yaml).toContain("label: v3");
    expect(yaml).toContain("- ledger-balances");
    expect(yaml).not.toContain("createdBy");
  });

  it("reports a code host failure as a value", async () => {
    expect((await githubDefinitions(fakeGh({}), cfg).proposeFiles("p", { "AGENTS.md": "x" }, "ada", "t")).ok).toBe(false);
    expect((await githubDefinitions(fakeGh({}), cfg).files("p")).ok).toBe(false);
  });

  it("syncs merged folders: factories into the org store, every version back, broken folders reported", async () => {
    const stored: OrgFactory[] = [];
    const org = { factories: async () => stored, putFactory: async (f: OrgFactory) => (stored.push(f), f) };
    const reader = new DefinitionsReader(
      repo({
        "factories/default/AGENTS.md": "org rules",
        "factories/payments/factory.yaml": "description: Money rules\nworld: payments-30d\n",
        "factories/broken/factory.yaml": "scorers: nope\n",
      }),
      cfg,
    );
    const r = await syncDefinitions(reader, org, () => "now");
    expect(r.factories).toEqual(["payments"]);
    expect(r.versions.map((v) => v.id.replace(/_[0-9a-f]+$/, ""))).toEqual(["fv_default", "fv_payments"]);
    expect(r.versions[1]?.bundle.agentsMd).toBe("org rules");
    expect(Object.keys(r.problems)).toEqual(["broken"]);
    expect(stored[0]).toMatchObject({ slug: "payments", world: "payments-30d", createdAt: "now" });
    // Nothing changed: nothing written again.
    expect((await syncDefinitions(reader, org, () => "later")).factories).toEqual([]);
  });
});
