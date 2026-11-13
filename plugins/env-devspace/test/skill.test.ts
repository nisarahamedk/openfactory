import { expect, test } from "vitest";
import { namespaceFor, renderSkill } from "../src/index.js";

test("namespace names are valid Kubernetes names", () => {
  expect(namespaceFor("task-", "task_7f3a")).toBe("task-7f3a");
  expect(namespaceFor("task-", "task_ABC_9")).toBe("task-abc-9");
});

test("the skill names the namespace, URL and evidence convention", () => {
  const skill = renderSkill({ namespace: "task-7f3a", appUrl: "https://task-7f3a.1.2.3.4.sslip.io", environmentName: "devspace:task-7f3a", evidenceDir: "/work/home/evidence", taskId: "task_7f3a", notes: "", deployCommand: "devspace deploy --namespace task-7f3a" });
  expect(skill).toMatch(/^---\nname: factory-environment\n/);
  expect(skill).toContain("devspace deploy --namespace task-7f3a");
  expect(skill).toContain("/work/home/evidence/manifest.json");
  expect(skill).toContain('"environment": "devspace:task-7f3a"');
  expect(skill).not.toContain("Notes for this repo");
});
