import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@openfactory/contracts";
import { Health } from "./health.js";

const repos = [{ host: "github" as const, owner: "acme", name: "app" }];
const models = (ids: string[]) => (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }))) as unknown as typeof fetch;
const task = (model: string) => ({ harness: { name: "claude-code", model } }) as TaskRecord;

describe("start-up checks", () => {
  it("pass when the token, repos, gateway and routed models are all there", async () => {
    const h = new Health({
      forgeGet: async (p) => (p === "/user" ? { login: "bot" } : { permissions: { push: true } }),
      repos,
      gateway: { baseUrl: "http://gw/v1", key: "k" },
      models: ["claude-haiku", "claude-sonnet"],
      taskKeyModels: ["claude-haiku", "claude-sonnet"],
      fetch: models(["claude-haiku", "claude-sonnet"]),
    });
    const r = await h.current();
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(["code host", "repo acme/app", "model gateway", "models"]);
  });

  it("catch the live failure: a routed model the gateway key can't use, with a fix, and stop a task routed to it", async () => {
    const h = new Health({
      forgeGet: async (p) => (p === "/user" ? { login: "bot" } : { permissions: { push: false } }),
      repos,
      gateway: { baseUrl: "http://gw/v1", key: "k" },
      models: ["claude-haiku", "claude-sonnet"],
      taskKeyModels: null,
      fetch: models(["claude-haiku"]),
    });
    const r = await h.current();
    expect(r.ok).toBe(false);
    const bad = r.checks.filter((c) => !c.ok);
    expect(bad.map((c) => c.name)).toEqual(["repo acme/app", "models"]);
    expect(bad[1]!.fix).toContain("claude-sonnet");
    expect((await h.forTask(task("claude-haiku"))).find((c) => c.name === "model claude-haiku")?.ok).toBe(true);
    expect((await h.forTask(task("claude-sonnet"))).find((c) => c.name === "model claude-sonnet")?.ok).toBe(false);
  });

  it("report a refused token or an unreachable gateway", async () => {
    const h = new Health({
      forgeGet: async () => {
        throw new Error("GitHub GET /user → 401: Bad credentials");
      },
      repos: [],
      gateway: { baseUrl: "http://gw/v1", key: "k" },
      models: [],
      taskKeyModels: null,
      fetch: (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
    });
    const r = await h.current();
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["code host", "model gateway"]);
  });
});
