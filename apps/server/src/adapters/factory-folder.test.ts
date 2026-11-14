import { describe, expect, it } from "vitest";
import { readFolder, resolveFolders, versionOf } from "./factory-folder.js";

const skill = (name: string, description = "How refunds work") => `---\nname: ${name}\ndescription: ${description}\n---\nUse the ledger, never the PSP balance.\n`;

describe("factory folders", () => {
  it("reads factory.yaml, AGENTS.md, skills, mcp.json and the worker prompt into a factory and its version", () => {
    const files = {
      "factory.yaml": "description: Money rules\nscorers: [ledger-balances]\nworld: payments-30d\nlabel: refunds skill\neffort: high\nmodels: { default: claude-sonnet }\n",
      "AGENTS.md": "Keep PRs under 200 lines.\n",
      "skills/refunds/SKILL.md": skill("refunds"),
      "mcp.json": JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["docs-mcp"] } } }),
      "agents/worker.md": "Write the e2e test first.\n",
    };
    const r = readFolder("payments", files);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.folder.factory).toMatchObject({ slug: "payments", extends: "default", scorers: ["ledger-balances"], world: "payments-30d" });
    expect(r.folder.version).toMatchObject({ id: versionOf("payments", files), label: "refunds skill", prompt: "Write the e2e test first.", models: { default: "claude-sonnet", routes: [] } });
    expect(r.folder.version.bundle).toMatchObject({ agentsMd: "Keep PRs under 200 lines.\n", effort: "high", skills: [{ name: "refunds", description: "How refunds work" }], mcp: [{ name: "docs", command: "npx", args: ["docs-mcp"], env: {} }] });
    expect(r.folder.version.id).toMatch(/^fv_payments_[0-9a-f]{10}$/);
  });

  it("the version changes with any file and only then", () => {
    const a = { "factory.yaml": "scorers: []\n", "AGENTS.md": "x" };
    expect(versionOf("p", a)).toBe(versionOf("p", { "AGENTS.md": "x", "factory.yaml": "scorers: []\n" }));
    expect(versionOf("p", a)).not.toBe(versionOf("p", { ...a, "AGENTS.md": "y" }));
  });

  it("reports every problem instead of reading a broken folder", () => {
    const r = readFolder("p", { "factory.yaml": "scorers: nope\n", "skills/a/SKILL.md": "no frontmatter", "skills/b/SKILL.md": skill("c"), "mcp.json": "{" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toHaveLength(4);
  });

  it("a team folder extends the default file by file, and factory.yaml key by key", () => {
    const out = resolveFolders({
      default: { "factory.yaml": "scorers: [tests-pass]\neffort: low\n", "AGENTS.md": "org rules", "skills/review/SKILL.md": skill("review") },
      payments: { "factory.yaml": "effort: high\n", "skills/refunds/SKILL.md": skill("refunds") },
    });
    expect(Object.keys(out.payments ?? {}).sort()).toEqual(["AGENTS.md", "factory.yaml", "skills/refunds/SKILL.md", "skills/review/SKILL.md"]);
    const r = readFolder("payments", out.payments ?? {});
    expect(r.ok && r.folder.factory.scorers).toEqual(["tests-pass"]);
    expect(r.ok && r.folder.version.bundle.effort).toBe("high");
  });
});
