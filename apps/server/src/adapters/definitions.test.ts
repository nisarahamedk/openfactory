import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { OrgFactory } from "@openfactory/contracts";
import { definitionFile, githubDefinitions, syncDefinitions, type DefinitionsConfig } from "./definitions.js";

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
      const r = routes[key];
      if (r instanceof Error) throw r;
      // SAFETY: the fake returns whatever the test put in `routes` for this call; each test shapes it as the real API does.
      // Verified by: the assertions below on what the adapter does with each answer.
      return r as T;
    },
  };
}

const payments: OrgFactory = { slug: "payments", extends: "default", description: "Money rules", scorers: ["ledger-balances"], benchmarks: [], world: "payments-30d", mergeRisk: null, createdBy: "ada", createdAt: "t" };

describe("factory definitions on GitHub", () => {
  it("proposes a new definition as a branch, a file and a pull request", async () => {
    const gh = fakeGh({
      "GET /repos/acme/factory/git/ref/heads/main": { object: { sha: "abc" } },
      "POST /repos/acme/factory/git/refs": {},
      "PUT /repos/acme/factory/contents/factories/payments.yaml": {},
      "POST /repos/acme/factory/pulls": { number: 7, html_url: "https://github.com/acme/factory/pull/7" },
    });
    const r = await githubDefinitions(gh, cfg, () => "2026-11-14T03:50:00.000Z").proposeFactory(payments, "ada");
    expect(r).toEqual({ ok: true, number: 7, url: "https://github.com/acme/factory/pull/7" });
    expect(gh.calls.find((c) => c.method === "POST" && c.path.endsWith("/git/refs"))?.body).toEqual({ ref: "refs/heads/factory/payments-20261114035000", sha: "abc" });
    const put = gh.calls.find((c) => c.method === "PUT")?.body as { content: string; sha?: string };
    expect(put.sha).toBeUndefined();
    expect(Buffer.from(put.content, "base64").toString()).toContain("world: payments-30d");
    expect(Buffer.from(put.content, "base64").toString()).not.toContain("createdBy");
  });

  it("reports a code host failure as a value", async () => {
    const r = await githubDefinitions(fakeGh({}), cfg).proposeFactory(payments, "ada");
    expect(r.ok).toBe(false);
  });

  it("syncs merged files into the org store, skipping bad and unchanged ones", async () => {
    const stored: OrgFactory[] = [{ ...payments, slug: "growth", world: null, description: null, scorers: [] }];
    const org = { factories: async () => stored, putFactory: async (f: OrgFactory) => (stored.push(f), f) };
    const logged: string[] = [];
    const gh = fakeGh({
      "GET /repos/acme/factory/contents/factories?ref=main": [
        { name: "payments.yaml", path: "factories/payments.yaml", type: "file" },
        { name: "growth.yaml", path: "factories/growth.yaml", type: "file" },
        { name: "broken.yaml", path: "factories/broken.yaml", type: "file" },
        { name: "README.md", path: "factories/README.md", type: "file" },
      ],
      "GET /repos/acme/factory/contents/factories/payments.yaml?ref=main": { content: b64(definitionFile(payments)) },
      "GET /repos/acme/factory/contents/factories/growth.yaml?ref=main": { content: b64(stringify({ extends: "default", description: null, scorers: [], benchmarks: [], world: null, mergeRisk: null })) },
      "GET /repos/acme/factory/contents/factories/broken.yaml?ref=main": { content: b64("scorers: not-a-list\n") },
    });
    const wrote = await syncDefinitions(gh, cfg, org, () => "now", (m) => logged.push(m));
    expect(wrote).toEqual(["payments"]);
    expect(stored.find((f) => f.slug === "payments")).toMatchObject({ world: "payments-30d", scorers: ["ledger-balances"], createdBy: null, createdAt: "now" });
    expect(logged).toEqual(["factory definition skipped"]);
  });

  it("treats a missing definitions folder as no definitions", async () => {
    expect(await syncDefinitions(fakeGh({}), cfg, { factories: async () => [], putFactory: async (f) => f }, () => "now", () => {})).toEqual([]);
  });
});
