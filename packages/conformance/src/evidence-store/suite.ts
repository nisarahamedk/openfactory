import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceStore } from "@openfactory/contracts";
import type { Subject } from "../harness.js";

/**
 * Conformance for an EvidenceStore: byte-exact round trips (binary and large files),
 * overwrite by name, null for missing or invalid keys, isolation between tasks,
 * refusal of names that could escape a task's folder, and url(key) matching put().
 */
export function describeEvidenceStoreConformance(label: string, make: () => Promise<Subject<EvidenceStore>>): void {
  describe(`EvidenceStore conformance: ${label}`, () => {
    let current: Subject<EvidenceStore> | null = null;
    const open = async () => (current = await make()).subject;
    afterEach(async () => {
      await current?.cleanup();
      current = null;
    });

    it("round-trips binary bytes and the content type", async () => {
      const s = await open();
      const bytes = new Uint8Array([0, 255, 10, 13, 0, 1, 2, 128]);
      const { key, url } = await s.put("task_e1", "shot.png", bytes, "image/png");
      expect(key).toBe("task_e1/shot.png");
      expect(url).toBe(s.url(key));
      const got = await s.get(key);
      expect(got?.contentType).toBe("image/png");
      expect(Array.from(got?.bytes ?? [])).toEqual(Array.from(bytes));
    });

    it("stores a 2 MB file intact", async () => {
      const s = await open();
      const big = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 31) % 256);
      const { key } = await s.put("task_e1", "video.webm", big, "video/webm");
      const got = await s.get(key);
      expect(got?.bytes.length).toBe(big.length);
      expect(Buffer.from(got?.bytes ?? []).equals(Buffer.from(big))).toBe(true);
    });

    it("overwrites a file put again under the same name", async () => {
      const s = await open();
      await s.put("task_e1", "log.txt", new TextEncoder().encode("one"), "text/plain");
      const { key } = await s.put("task_e1", "log.txt", new TextEncoder().encode("two"), "text/plain; charset=utf-8");
      const got = await s.get(key);
      expect(new TextDecoder().decode(got?.bytes)).toBe("two");
      expect(got?.contentType).toBe("text/plain; charset=utf-8");
    });

    it("returns null for missing and invalid keys", async () => {
      const s = await open();
      expect(await s.get("task_e1/nothing.png")).toBeNull();
      expect(await s.get("../etc/passwd")).toBeNull();
      expect(await s.get("task_e1/../../x")).toBeNull();
      expect(await s.get("")).toBeNull();
    });

    it("keeps tasks apart", async () => {
      const s = await open();
      await s.put("task_e1", "a.txt", new TextEncoder().encode("1"), "text/plain");
      expect(await s.get("task_e2/a.txt")).toBeNull();
    });

    it("refuses names that could escape the task folder", async () => {
      const s = await open();
      for (const [t, n] of [["task_e1", "../x"], ["task_e1", "a/b"], ["..", "x"], ["task_e1", ""], ["task_e1", ".."]] as const) {
        await expect(s.put(t, n, new Uint8Array([1]), "text/plain")).rejects.toThrow();
      }
    });
  });
}
