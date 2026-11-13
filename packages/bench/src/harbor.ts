import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BenchmarkTask } from "@openfactory/contracts";
import { safeRelativePath } from "./replay.js";

/**
 * Export a benchmark task as a Harbor task folder (schema_version 1.4), so a team's
 * suite also runs in Harbor itself for repo-only tasks:
 *
 *   <dir>/task.toml  instruction.md  environment/Dockerfile
 *        tests/test.sh  tests/hidden/<test files>   benchmark.json (our own record)
 *
 * The Dockerfile clones the repo at the start commit. Private repos need a
 * GIT_TOKEN build secret; nothing secret is written into the folder.
 */
export async function writeHarborTask(dir: string, task: BenchmarkTask, opts: { agentTimeoutSec: number; verifierTimeoutSec: number }): Promise<string[]> {
  const repo = `${task.repo.owner}/${task.repo.name}`;
  const files: Record<string, string> = {
    "task.toml": [
      `schema_version = "1.4"`,
      ``,
      `[task]`,
      `name = ${toml(`${task.repo.owner}/${task.id}`)}`,
      `description = ${toml(firstLine(task.ask))}`,
      ``,
      `[metadata]`,
      `source_task_id = ${toml(task.sourceTaskId)}`,
      `repo = ${toml(repo)}`,
      `start_commit = ${toml(task.startCommit)}`,
      `check_kind = ${toml(task.check.kind)}`,
      `captured_at = ${toml(task.createdAt)}`,
      ``,
      `[agent]`,
      `timeout_sec = ${opts.agentTimeoutSec.toFixed(1)}`,
      ``,
      `[verifier]`,
      `timeout_sec = ${opts.verifierTimeoutSec.toFixed(1)}`,
      ``,
      `[environment]`,
      `workdir = "/workspace/repo"`,
      ``,
    ].join("\n"),
    "instruction.md": `${task.ask}\n`,
    "environment/Dockerfile": [
      `FROM node:22-bookworm`,
      `RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*`,
      `WORKDIR /workspace`,
      `RUN --mount=type=secret,id=GIT_TOKEN,required=false \\`,
      `    TOKEN="$(cat /run/secrets/GIT_TOKEN 2>/dev/null || true)"; \\`,
      `    URL="https://github.com/${repo}.git"; [ -n "$TOKEN" ] && URL="https://x-access-token:$TOKEN@github.com/${repo}.git"; \\`,
      `    git clone "$URL" repo && cd repo && git checkout ${task.startCommit} && git remote remove origin`,
      `WORKDIR /workspace/repo`,
      `RUN pnpm install --frozen-lockfile || npm ci || true`,
      ``,
    ].join("\n"),
    "tests/test.sh": [
      `#!/bin/bash`,
      `# Hidden check: copy the merged PR's tests over the agent's work, then run them.`,
      `set -uo pipefail`,
      `mkdir -p /logs/verifier`,
      `cd /workspace/repo`,
      `cp -r /tests/hidden/. . 2>/dev/null || true`,
      `if ${task.check.command.map(shellQuote).join(" ")}; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi`,
      ``,
    ].join("\n"),
    "benchmark.json": `${JSON.stringify(task, null, 2)}\n`,
  };
  for (const [path, content] of Object.entries(task.check.files)) files[join("tests/hidden", safeRelativePath(path))] = content;

  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, rel.endsWith(".sh") ? { mode: 0o755 } : {});
  }
  return Object.keys(files).sort();
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").slice(0, 200);
}

/** TOML basic string. */
function toml(s: string): string {
  return JSON.stringify(s);
}

/** POSIX single-quote a shell word. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
