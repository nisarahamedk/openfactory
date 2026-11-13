import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A local git repo with two commits on `main`, to clone in workspace tests. */
export function makeOriginRepo(): { path: string; olderCommit: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), "of-origin-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", path, "-c", "user.email=cf@example.com", "-c", "user.name=cf", ...args]).toString().trim();
  execFileSync("git", ["init", "-q", "-b", "main", path]);
  writeFileSync(join(path, "README.md"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "v1");
  const olderCommit = git("rev-parse", "HEAD");
  writeFileSync(join(path, "README.md"), "v2\n");
  git("commit", "-qam", "v2");
  return { path, olderCommit, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
