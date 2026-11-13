import { expect, it } from "vitest";
import { buildOpenApi, V1_ROUTES } from "./index.js";

it("operation ids are unique and every path parameter is declared", () => {
  const ids = V1_ROUTES.map((r) => r.operationId);
  expect(new Set(ids).size).toBe(ids.length);
  const doc = buildOpenApi({ serverUrl: null, version: "t" }) as { paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>> };
  for (const [path, ops] of Object.entries(doc.paths)) {
    const wanted = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const op of Object.values(ops)) expect((op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name)).toEqual(wanted);
  }
});
