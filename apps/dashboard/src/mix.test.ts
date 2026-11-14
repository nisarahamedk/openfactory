import { expect, it } from "vitest";
import { categoryOf, reweight } from "./mix.js";

it("sorts tasks into kinds by label, then title", () => {
  expect(categoryOf({ title: "Anything", labels: ["factory", "ui"] })).toBe("ui");
  expect(categoryOf({ title: "Fix the broken pricing link" })).toBe("bug");
  expect(categoryOf({ title: "Bump Node to 22.21" })).toBe("infra");
  expect(categoryOf({ title: "Pricing FAQ: link straight to a question" })).toBe("ui");
});

it("re-weights per-kind results to the live mix and ignores kinds with no live work", () => {
  // Suite: 4 UI tasks (all pass, cheap), 1 bug (fails, dear). Live work: 80% bugs, 20% UI.
  const perKind = new Map([["ui", { pass: 4, cost: 0.4, n: 4 }], ["bug", { pass: 0, cost: 0.9, n: 1 }], ["docs", { pass: 1, cost: 0.1, n: 1 }]] as const);
  const live = new Map([["bug", 8], ["ui", 2]] as const);
  const r = reweight(new Map(perKind), new Map(live));
  expect(r.pass).toBeCloseTo(0.2); // raw suite pass rate would be 5/6
  expect(r.cost).toBeCloseTo(0.8 * 0.9 + 0.2 * 0.1);
  expect(reweight(new Map(), new Map(live))).toEqual({ pass: null, cost: null });
});

it("reads plural tests and AGENTS.md docs from a title", async () => {
  const { categoryOf } = await import("./mix.js");
  expect(categoryOf({ title: "Add unit tests for src/lib/format.ts" })).toBe("test");
  expect(categoryOf({ title: "Docs: add a section to AGENTS.md" })).toBe("docs");
});
