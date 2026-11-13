import { describe, expect, it, test } from "vitest";
import { LiteLlmGateway } from "../src/index.js";

/** A small stand-in for LiteLLM's key admin API (/key/info, /key/generate, /key/delete). */
function fakeLiteLlm(masterKey: string) {
  const keys = new Map<string, { maxBudget: number; spend: number; models: string[] }>();
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${masterKey}`) return new Response("no", { status: 401 });
    if (url.pathname === "/key/info") {
      const k = keys.get(url.searchParams.get("key") ?? "");
      return k === undefined ? new Response("not found", { status: 404 }) : Response.json({ key: url.searchParams.get("key"), info: { spend: k.spend, max_budget: k.maxBudget } });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { key?: string; keys?: string[]; max_budget?: number; models?: string[] };
    if (url.pathname === "/key/generate") {
      keys.set(body.key ?? "", { maxBudget: body.max_budget ?? 0, spend: 0, models: body.models ?? [] });
      return Response.json({ key: body.key });
    }
    if (url.pathname === "/key/delete") {
      const found = (body.keys ?? []).filter((k) => keys.delete(k));
      return found.length === 0 ? new Response("not found", { status: 404 }) : Response.json({ deleted_keys: found });
    }
    return new Response("?", { status: 404 });
  };
  return { fetch: f, keys };
}

const make = () => {
  const fake = fakeLiteLlm("sk-master");
  const gateway = new LiteLlmGateway({
    adminUrl: "http://litellm:4000/",
    masterKey: "sk-master",
    agentBaseUrl: "http://litellm.factory.svc:4000",
    models: ["claude-sonnet-5-5"],
    envNames: { baseUrl: "ANTHROPIC_BASE_URL", key: "ANTHROPIC_API_KEY" },
    fetch: fake.fetch,
  });
  return { fake, gateway };
};

test("a task gets its own key with its budget, the same one every time", async () => {
  const { fake, gateway } = make();
  const first = await gateway.forTask("task_a", { usd: 3 });
  const again = await gateway.forTask("task_a", { usd: 3 });
  const other = await gateway.forTask("task_b", { usd: 3 });
  expect(first).toEqual(again);
  expect(first.ANTHROPIC_BASE_URL).toBe("http://litellm.factory.svc:4000");
  expect(first.ANTHROPIC_API_KEY).not.toBe(other.ANTHROPIC_API_KEY);
  expect(first.ANTHROPIC_API_KEY).not.toContain("sk-master");
  expect(fake.keys.get(first.ANTHROPIC_API_KEY ?? "")).toEqual({ maxBudget: 3, spend: 0, models: ["claude-sonnet-5-5"] });
});

test("spend is read back, and revoke is safe twice", async () => {
  const { fake, gateway } = make();
  const env = await gateway.forTask("task_a", { usd: 3 });
  fake.keys.get(env.ANTHROPIC_API_KEY ?? "")!.spend = 0.42;
  expect(await gateway.spend("task_a")).toEqual({ usd: 0.42 });
  await gateway.revoke("task_a");
  await gateway.revoke("task_a");
  expect(await gateway.spend("task_a")).toBeNull();
});

describe("anthropicBase", () => {
  it("drops a trailing /v1 so the agent does not call /v1/v1/messages", async () => {
    const { anthropicBase } = await import("../src/index.js");
    expect(anthropicBase("http://litellm:4000/v1")).toBe("http://litellm:4000");
    expect(anthropicBase("http://litellm:4000/v1/")).toBe("http://litellm:4000");
    expect(anthropicBase("http://litellm:4000")).toBe("http://litellm:4000");
  });
});
