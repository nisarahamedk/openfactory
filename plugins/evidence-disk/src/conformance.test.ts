import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeEvidenceStoreConformance } from "@openfactory/conformance";
import { expect, it } from "vitest";
import { DiskEvidenceStore } from "./index.js";

describeEvidenceStoreConformance("DiskEvidenceStore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-disk-"));
  return { subject: new DiskEvidenceStore({ dir, publicUrl: "https://factory.example/" }), cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
});

it("never serves its own sidecar files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-disk-"));
  const s = new DiskEvidenceStore({ dir, publicUrl: "https://f.example" });
  await s.put("task_a", "shot.png", new Uint8Array([1]), "image/png");
  expect(await s.get("task_a/shot.png.type")).toBeNull();
  await expect(s.put("task_a", "x.type", new Uint8Array([1]), "text/plain")).rejects.toThrow();
  expect(s.url("task_a/shot.png")).toBe("https://f.example/evidence/task_a/shot.png");
});
