import { expect, it } from "vitest";
import { FactoryApi } from "./index.js";

it("acting for a person sends X-Factory-Actor; the plain client doesn't", async () => {
  const seen: Array<Record<string, string>> = [];
  const fetchFake: typeof fetch = async (_url, init) => {
    seen.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
    return new Response(JSON.stringify({ tasks: [] }), { headers: { "content-type": "application/json" } });
  };
  const api = new FactoryApi({ baseUrl: "http://f.test", token: "tok", fetch: fetchFake });
  await api.listTasks();
  await api.actingAs("dana").listTasks();
  expect(seen.map((h) => [h.authorization, h["x-factory-actor"] ?? null])).toEqual([
    ["Bearer tok", null],
    ["Bearer tok", "dana"],
  ]);
});
