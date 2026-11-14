import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionBundle } from "@openfactory/contracts";
import { expect, it } from "vitest";
import { bundleMcp, bundleScript } from "./bundle.js";

it("writes skills and AGENTS.md guidance into the checkout, excluded from git, and is idempotent", () => {
  const repo = mkdtempSync(join(tmpdir(), "bundle-"));
  execFileSync("git", ["init", "-q", repo]);
  const b = VersionBundle.parse({ agentsMd: "Keep PRs small. Don't touch 'pricing'.", skills: [{ name: "faq-links", description: "How FAQ anchors work: \"#q-slug\"", body: "Use slug ids." }] });
  for (let i = 0; i < 2; i++) execFileSync("sh", ["-c", bundleScript(repo, b)]);
  expect(readFileSync(join(repo, ".claude/skills/faq-links/SKILL.md"), "utf8")).toBe('---\nname: faq-links\ndescription: "How FAQ anchors work: \\"#q-slug\\""\n---\n\nUse slug ids.\n');
  expect(readFileSync(join(repo, "CLAUDE.local.md"), "utf8")).toContain("Don't touch 'pricing'.");
  expect(readFileSync(join(repo, ".git/info/exclude"), "utf8").split("\n").filter((l) => !l.startsWith("#") && l)).toEqual([".claude/skills/faq-links/", "CLAUDE.local.md"]);
  expect(execFileSync("git", ["-C", repo, "status", "--porcelain"]).toString()).toBe("");
});

it("CodeGraph adds its MCP server ahead of the version's own", () => {
  const b = VersionBundle.parse({ codegraph: true, mcp: [{ name: "docs", command: "npx", args: ["docs-mcp"] }] });
  expect(bundleMcp(b).map((m) => m.name)).toEqual(["codegraph", "docs"]);
  expect(bundleScript("/w/r", b)).toContain("codegraph init");
});
