/**
 * A factory version's bundle, put in place in the agent's checkout before each turn: skills under
 * .claude/skills/, extra AGENTS.md guidance in CLAUDE.local.md, and a CodeGraph index. None of it is
 * committed: every path goes into .git/info/exclude. Safe to run again (it rewrites the same files).
 */
import type { McpServer, VersionBundle, WorkspaceHandle } from "@openfactory/contracts";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The skill file Claude Code reads: YAML front matter (name, description) and the body. */
export function skillFile(s: VersionBundle["skills"][number]): string {
  return `---\nname: ${s.name}\ndescription: ${JSON.stringify(s.description)}\n---\n\n${s.body.trim()}\n`;
}

/** The shell script that writes the bundle into `repo`. Pure, so it's testable without a workspace. */
export function bundleScript(repo: string, b: VersionBundle): string {
  const lines = ["set -e", `cd ${q(repo)}`, "mkdir -p .git/info", "touch .git/info/exclude"];
  const exclude = (p: string) => lines.push(`grep -qxF ${q(p)} .git/info/exclude || echo ${q(p)} >> .git/info/exclude`);
  for (const s of b.skills) {
    lines.push(`mkdir -p .claude/skills/${s.name}`, `printf %s ${q(skillFile(s))} > .claude/skills/${s.name}/SKILL.md`);
    exclude(`.claude/skills/${s.name}/`);
  }
  if (b.agentsMd) {
    lines.push(`printf %s ${q(`# Factory version guidance\n\n${b.agentsMd.trim()}\n`)} > CLAUDE.local.md`);
    exclude("CLAUDE.local.md");
  }
  if (b.codegraph) {
    // Index once; later turns reuse it (the MCP server keeps it in sync as the agent edits).
    lines.push("if command -v codegraph >/dev/null 2>&1; then [ -d .codegraph ] || codegraph init >/dev/null 2>&1 || echo 'codegraph init failed' >&2; else echo 'codegraph is not installed in this workspace' >&2; fi");
    exclude(".codegraph/");
  }
  return lines.join("\n");
}

/** The MCP servers a bundle gives the session. */
export function bundleMcp(b: VersionBundle): McpServer[] {
  return [...(b.codegraph ? [{ name: "codegraph", command: "codegraph", args: ["serve", "--mcp"], env: {} }] : []), ...b.mcp];
}

export async function applyBundle(ws: WorkspaceHandle, repo: string, b: VersionBundle): Promise<{ ok: boolean; stderr: string }> {
  if (!b.skills.length && !b.agentsMd && !b.codegraph) return { ok: true, stderr: "" };
  const r = await ws.exec(["sh", "-c", bundleScript(repo, b)], { timeoutMs: 10 * 60_000 });
  return { ok: r.exitCode === 0, stderr: r.stderr };
}
