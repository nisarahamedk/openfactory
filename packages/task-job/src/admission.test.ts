import type { TaskId, Workspace, WorkspaceHandle } from "@openfactory/contracts";
import { describe, expect, it } from "vitest";
import { admitted, WorkSlots } from "./admission.js";

const fakeWs = (): Workspace => {
  const handle = (id: string): WorkspaceHandle =>
    ({ id, repoPath: "/r", exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), spawn: async () => { throw new Error("no"); }, writeFile: async () => {}, sleep: async () => {}, wake: async () => {}, destroy: async () => {} }) as WorkspaceHandle;
  return { name: "fake", create: async (i) => handle(`ws-${i.taskId}`), get: async (id) => handle(id) };
};
const id = (s: string) => s as TaskId;

describe("admission", () => {
  it("queues the third workspace until one sleeps, even through a re-fetched handle", async () => {
    const slots = new WorkSlots(2);
    const queued: Array<[string, number]> = [];
    const ws = admitted(fakeWs(), slots, (t, p) => void queued.push([t, p]));
    const a = await ws.create({ taskId: id("task_a"), repo: { host: "github", owner: "o", name: "r" }, branch: "b", image: null });
    await ws.create({ taskId: id("task_b"), repo: { host: "github", owner: "o", name: "r" }, branch: "b", image: null });
    let third = false;
    const c = ws.create({ taskId: id("task_c"), repo: { host: "github", owner: "o", name: "r" }, branch: "b", image: null }).then(() => (third = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(third).toBe(false);
    expect(queued).toEqual([["task_c", 1]]);
    await (await ws.get(a.id))!.sleep();
    await c;
    expect(third).toBe(true);
    expect(slots.inUse).toBe(2);
    // Waking the slept one now waits; destroying another frees a slot for it.
    const again = (await ws.get(a.id))!;
    let woke = false;
    const w = again.wake().then(() => (woke = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(woke).toBe(false);
    await (await ws.get("ws-task_b"))!.destroy();
    await w;
    expect(woke).toBe(true);
  });
});
