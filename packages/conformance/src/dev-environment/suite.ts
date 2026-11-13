import { afterEach, describe, expect, it } from "vitest";
import type { DevEnvironment, EnvironmentHandle, RepoRef } from "@openfactory/contracts";
import type { Subject } from "../harness.js";

/** A DevEnvironment under test, and a repo it can make an environment for. */
export interface DevEnvironmentSubject extends Subject<DevEnvironment> {
  repo: RepoRef;
}

export interface DevEnvironmentConformanceOptions {
  /** Per-test timeout; real clusters are slow. */
  timeoutMs?: number;
}

let seq = 0;
const taskId = () => `task_cfenv${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * Conformance for a DevEnvironment: one environment per task, found again by
 * name after a restart; it hands the agent files, env vars and a skill that
 * say how to use it; sleep, wake and destroy are safe to repeat.
 */
export function describeDevEnvironmentConformance(
  label: string,
  make: () => Promise<DevEnvironmentSubject>,
  options: DevEnvironmentConformanceOptions = {},
): void {
  const timeout = options.timeoutMs ?? 120_000;
  describe(`DevEnvironment conformance: ${label}`, () => {
    let current: { s: DevEnvironmentSubject; handles: EnvironmentHandle[] } | null = null;
    const open = async () => {
      current = { s: await make(), handles: [] };
      return current;
    };
    const create = async (id = taskId()) => {
      const c = current ?? (await open());
      const handle = await c.s.subject.create({ taskId: id, repo: c.s.repo });
      c.handles.push(handle);
      return handle;
    };
    afterEach(async () => {
      if (current === null) return;
      for (const h of current.handles) await h.destroy();
      await current.s.cleanup();
      current = null;
    });

    it("has a name", async () => {
      expect((await open()).s.subject.name).toMatch(/\S/);
    });

    it("create is idempotent per task and different tasks get different environments", { timeout }, async () => {
      const id = taskId();
      const a = await create(id);
      const again = await create(id);
      const other = await create();
      expect(a.name).toMatch(/\S/);
      expect(again.name).toBe(a.name);
      expect(other.name).not.toBe(a.name);
    });

    it("get finds an environment by name, and returns null for an unknown one", { timeout }, async () => {
      const env = await create();
      const found = await current!.s.subject.get(env.name);
      expect(found?.name).toBe(env.name);
      expect(await current!.s.subject.get(`cf-missing-${Date.now().toString(36)}`)).toBeNull();
    });

    it("gives the agent absolute file paths, string env vars and a skill", { timeout }, async () => {
      const env = await create();
      const files = await env.credentialsForWorkspace();
      for (const f of files) {
        expect(f.path.startsWith("/"), `${f.path} is absolute`).toBe(true);
        expect(typeof f.content).toBe("string");
      }
      expect(new Set(files.map((f) => f.path)).size).toBe(files.length);
      const vars = await env.envVars();
      for (const [k, v] of Object.entries(vars)) {
        expect(k).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        expect(typeof v).toBe("string");
      }
      expect((await env.skill()).trim().length).toBeGreaterThan(0);
    });

    it("sleep and wake can repeat, and the environment is still there after", { timeout }, async () => {
      const env = await create();
      await env.sleep();
      await env.sleep();
      await env.wake();
      await env.wake();
      expect((await current!.s.subject.get(env.name))?.name).toBe(env.name);
      expect((await env.skill()).trim().length).toBeGreaterThan(0);
    });

    it("destroy removes it and can repeat", { timeout }, async () => {
      const env = await create();
      await env.destroy();
      await env.destroy();
      expect(await current!.s.subject.get(env.name)).toBeNull();
    });
  });
}
