/**
 * Faithful fake Workspace: a temp folder per task, commands run for real with
 * a clean env. Same behaviour as plugins/workspace-local, kept here so core
 * packages can test against a Workspace without depending on a provider.
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { RepoRef, TaskId, Workspace, WorkspaceHandle } from "@openfactory/contracts";

export interface TempDirWorkspaceOptions {
  /** Folder that holds one sub-folder per task. */
  root: string;
  /** Where to clone a repo from; may embed a short-lived token. */
  cloneUrl: (repo: RepoRef) => string;
  /** Extra environment for every command (merged under per-call env). */
  baseEnv: Record<string, string>;
}

export class TempDirWorkspace implements Workspace {
  readonly name = "tempdir-fake";

  constructor(private readonly options: TempDirWorkspaceOptions) {}

  async create(input: {
    taskId: TaskId;
    repo: RepoRef;
    branch: string;
    image: string | null;
    startRef?: string | null;
  }): Promise<WorkspaceHandle> {
    const dir = join(this.options.root, input.taskId);
    const repoPath = join(dir, "repo");
    await mkdir(dir, { recursive: true });
    const handle = new TempDirWorkspaceHandle(input.taskId, dir, repoPath, this.options.baseEnv);
    if (await exists(join(repoPath, ".git"))) return handle;
    await handle.mustExec(["git", "clone", this.options.cloneUrl(input.repo), repoPath], { cwd: dir });
    const startRef = input.startRef ?? null;
    if (startRef !== null) {
      // The ref may be a commit not on any branch the clone fetched.
      await handle.exec(["git", "fetch", "origin", startRef], { cwd: repoPath });
      await handle.mustExec(["git", "checkout", "--quiet", "-B", input.branch, startRef], { cwd: repoPath });
      return handle;
    }
    const branchExists = await handle.exec(["git", "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${input.branch}`], {
      cwd: repoPath,
    });
    await handle.mustExec(
      branchExists.exitCode === 0 ? ["git", "checkout", input.branch] : ["git", "checkout", "-B", input.branch],
      { cwd: repoPath },
    );    return handle;
  }

  async get(id: string): Promise<WorkspaceHandle | null> {
    const dir = join(this.options.root, id);
    if (!(await exists(dir))) return null;
    return new TempDirWorkspaceHandle(id, dir, join(dir, "repo"), this.options.baseEnv);
  }
}

/** A command the workspace ran exited non-zero. */
class CommandFailed extends Error {
  readonly code = "command_failed" as const;
  constructor(
    readonly cmd: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`Command failed with exit code ${exitCode}: ${cmd.join(" ")}\n${stderr.slice(-2000)}`);
  }
}

class TempDirWorkspaceHandle implements WorkspaceHandle {
  constructor(
    readonly id: string,
    private readonly dir: string,
    readonly repoPath: string,
    private readonly baseEnv: Record<string, string>,
  ) {}

  async exec(
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [file, ...args] = cmd;
    if (file === undefined) throw new Error("exec needs a command");
    const child = spawnProcess(file, args, {
      cwd: opts.cwd ?? this.repoPath,
      env: { ...hostEnv(this.dir), ...this.baseEnv, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const exitCode = await new Promise<number>((resolve) => {
      // A command that cannot start (not found, not executable) is a failed
      // command, like a shell's 127, not a broken workspace.
      child.on("error", (err) => {
        stderr += String(err);
        resolve(127);
      });
      child.on("close", (code) => resolve(code ?? 1));
    });
    return { exitCode, stdout, stderr };
  }

  async mustExec(cmd: string[], opts: { cwd?: string } = {}): Promise<string> {
    const result = await this.exec(cmd, opts);
    if (result.exitCode !== 0) throw new CommandFailed(cmd, result.exitCode, result.stderr);
    return result.stdout;
  }

  async spawn(
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{
    stdin: WritableStream<Uint8Array>;
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(): Promise<void>;
  }> {
    const [file, ...args] = cmd;
    if (file === undefined) throw new Error("spawn needs a command");
    const child = spawnProcess(file, args, {
      cwd: opts.cwd ?? this.repoPath,
      env: { ...hostEnv(this.dir), ...this.baseEnv, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", () => undefined); // drained so the child never blocks on a full pipe
    const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
    return {
      stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      exited,
      kill: async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        await exited;
      },
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = isAbsolute(path) ? path : join(this.repoPath, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }

  async sleep(): Promise<void> {
    // A folder costs nothing while idle.
  }

  async wake(): Promise<void> {}

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The few host variables a tool needs. The factory's own environment (its
 * keys, its own agent settings) never leaks into the workspace.
 */
function hostEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, LANG: "C.UTF-8" };
  for (const key of ["PATH", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

