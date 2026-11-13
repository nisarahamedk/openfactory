import { afterEach, describe, expect, it } from "vitest";
import type { RepoRef, Workspace, WorkspaceHandle } from "@openfactory/contracts";
import type { Subject } from "../harness.js";

/** A Workspace under test, and a repo it can clone. */
export interface WorkspaceSubject extends Subject<Workspace> {
  repo: RepoRef;
  /** A commit in `repo` that is not the default branch's head, to test `startRef`; null to skip. */
  olderCommit: string | null;
}

export interface WorkspaceConformanceOptions {
  /** Per-test timeout; real sandboxes start slowly. */
  timeoutMs?: number;
}

let seq = 0;
const taskId = () => `task_cf${Date.now().toString(36)}${(seq++).toString(36)}`;

async function sh(ws: WorkspaceHandle, script: string, opts: { cwd?: string; env?: Record<string, string> } = {}) {
  return ws.exec(["sh", "-c", script], opts);
}

/**
 * Conformance for a Workspace: the agent's tools run inside it with the repo
 * checked out on the task branch; exec, spawn and writeFile behave like a
 * shell; sleep/wake keeps the disk; create and get find the same workspace.
 */
export function describeWorkspaceConformance(label: string, make: () => Promise<WorkspaceSubject>, options: WorkspaceConformanceOptions = {}): void {
  const timeout = options.timeoutMs ?? 120_000;
  describe(`Workspace conformance: ${label}`, () => {
    let current: { s: WorkspaceSubject; handles: WorkspaceHandle[] } | null = null;
    const open = async () => {
      current = { s: await make(), handles: [] };
      return current;
    };
    const create = async (input: { branch?: string; startRef?: string | null } = {}) => {
      const c = current ?? (await open());
      const handle = await c.s.subject.create({
        taskId: taskId(),
        repo: c.s.repo,
        branch: input.branch ?? `factory/cf-${seq}`,
        image: null,
        ...(input.startRef === undefined ? {} : { startRef: input.startRef }),
      });
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

    it("create checks the repo out on the task branch", { timeout }, async () => {
      const ws = await create({ branch: "factory/cf-branch" });
      expect(ws.id).toMatch(/\S/);
      expect(ws.repoPath.startsWith("/")).toBe(true);
      const branch = await ws.exec(["git", "branch", "--show-current"], { cwd: ws.repoPath });
      expect(branch.exitCode).toBe(0);
      expect(branch.stdout.trim()).toBe("factory/cf-branch");
    });

    it("create with startRef starts the branch at that commit", { timeout }, async () => {
      const s = (await open()).s;
      if (s.olderCommit === null) return;
      const ws = await create({ startRef: s.olderCommit });
      expect((await ws.exec(["git", "rev-parse", "HEAD"], { cwd: ws.repoPath })).stdout.trim()).toBe(s.olderCommit);
    });

    it("exec reports exit code, stdout and stderr, and honours cwd and env", { timeout }, async () => {
      const ws = await create();
      const ok = await sh(ws, 'echo "$CF_VAR"; echo err >&2; pwd', { cwd: ws.repoPath, env: { CF_VAR: "hello world" } });
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toBe(`hello world\n${ws.repoPath}\n`);
      expect(ok.stderr).toBe("err\n");
      const failed = await sh(ws, "exit 7");
      expect(failed.exitCode).toBe(7);
      const missing = await ws.exec(["cf-no-such-command-xyz"]);
      expect(missing.exitCode).not.toBe(0);
    });

    it("exec stops a command at its time limit", { timeout }, async () => {
      const ws = await create();
      const started = Date.now();
      const slow = await ws.exec(["sleep", "30"], { timeoutMs: 1500 });
      expect(slow.exitCode).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(20_000);
    });

    it("writeFile takes absolute and repo-relative paths and creates folders", { timeout }, async () => {
      const ws = await create();
      await ws.writeFile("cf-dir/a.txt", "line 1\nline 2 ✓\n");
      expect((await ws.exec(["cat", "cf-dir/a.txt"], { cwd: ws.repoPath })).stdout).toBe("line 1\nline 2 ✓\n");
      const home = (await sh(ws, 'printf %s "$HOME"')).stdout;
      expect(home.startsWith("/")).toBe(true);
      await ws.writeFile(`${home}/cf/deep/b.txt`, "b");
      expect((await ws.exec(["cat", `${home}/cf/deep/b.txt`])).stdout).toBe("b");
    });

    it("spawn gives a live process with stdin and stdout, and kill ends it", { timeout }, async () => {
      const ws = await create();
      const proc = await ws.spawn(["cat"], { cwd: ws.repoPath });
      const writer = proc.stdin.getWriter();
      const reader = proc.stdout.getReader();
      await writer.write(new TextEncoder().encode("ping\n"));
      let got = "";
      while (!got.includes("ping\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        got += new TextDecoder().decode(value);
      }
      expect(got).toBe("ping\n");
      reader.releaseLock();
      await proc.kill();
      await expect(Promise.race([proc.exited.then(() => "exited"), new Promise((r) => setTimeout(() => r("still running"), 15_000))])).resolves.toBe("exited");
    });

    it("sleep and wake keep the disk: the repo, uncommitted work and $HOME", { timeout: timeout * 2 }, async () => {
      const ws = await create();
      await ws.writeFile("cf-work.txt", "unsaved");
      const home = (await sh(ws, 'printf %s "$HOME"')).stdout;
      await ws.writeFile(`${home}/cf-session.json`, "{}");
      await ws.sleep();
      await ws.wake();
      expect((await ws.exec(["cat", "cf-work.txt"], { cwd: ws.repoPath })).stdout).toBe("unsaved");
      expect((await ws.exec(["cat", `${home}/cf-session.json`])).stdout).toBe("{}");
    });

    it("get finds a created workspace by id, and nothing for an unknown id", { timeout }, async () => {
      const ws = await create();
      const again = await current!.s.subject.get(ws.id);
      expect(again?.id).toBe(ws.id);
      expect(again?.repoPath).toBe(ws.repoPath);
      expect(await current!.s.subject.get("ws-cf-does-not-exist")).toBeNull();
    });

    it("destroy removes it", { timeout }, async () => {
      const ws = await create();
      await ws.destroy();
      current!.handles.pop();
      expect(await current!.s.subject.get(ws.id)).toBeNull();
    });
  });
}
