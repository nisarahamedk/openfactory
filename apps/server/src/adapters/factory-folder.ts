/**
 * The factory folder format. A factory is a folder in the definitions repo:
 *
 *   factories/<slug>/
 *     factory.yaml            extends, description, scorers, benchmarks, world, mergeRisk,
 *                             and the version's label, models (routing), effort, codegraph
 *     AGENTS.md               extra guidance for the agent (written as CLAUDE.local.md in the checkout)
 *     skills/<name>/SKILL.md  skills (frontmatter: name, description)
 *     mcp.json                MCP servers, in the standard { "mcpServers": { name: { command, args, env } } } shape
 *     agents/worker.md        extra system prompt for the worker agent
 *
 * A folder `extends` another (default: the `default` folder) file by file: it only holds what it changes. The
 * version is the content hash of the resolved folder, so the same files are always the same version.
 */
import { createHash } from "node:crypto";
import { McpServer, OrgFactory, VersionBundle } from "@openfactory/contracts";
import { parse } from "yaml";
import { z } from "zod";
import { Routing } from "../registry.js";

/** factory.yaml inside a folder. */
export const FolderYaml = OrgFactory.omit({ slug: true, createdBy: true, createdAt: true }).extend({
  label: z.string().max(100).nullable().default(null),
  models: Routing.nullable().default(null),
  effort: VersionBundle.shape.effort,
  codegraph: z.boolean().default(false),
});

const SkillHead = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), description: z.string().min(1).max(1024) });
const McpJson = z.object({ mcpServers: z.record(z.string(), McpServer.omit({ name: true })).default({}) });

export type FactoryFolder = {
  factory: Omit<OrgFactory, "createdBy" | "createdAt">;
  version: { id: string; label: string | null; prompt: string | null; models: z.infer<typeof Routing> | null; bundle: VersionBundle };
};

export type FolderResult = { ok: true; folder: FactoryFolder } | { ok: false; problems: string[] };

/** Files of each folder, with every `extends` applied file by file (the folder's own file wins). */
export function resolveFolders(folders: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const resolve = (slug: string, seen: string[]): Record<string, string> => {
    const own = folders[slug] ?? {};
    if (seen.includes(slug)) return own;
    const head = FolderYaml.pick({ extends: true }).safeParse(safeYaml(own["factory.yaml"]));
    const parent = head.success ? head.data.extends : "default";
    const base = slug !== parent && folders[parent] ? resolve(parent, [...seen, slug]) : {};
    // The parent's factory.yaml settings are inherited key by key, not replaced wholesale.
    const yaml = own["factory.yaml"] !== undefined && base["factory.yaml"] !== undefined ? mergeYaml(base["factory.yaml"], own["factory.yaml"]) : (own["factory.yaml"] ?? base["factory.yaml"]);
    return { ...base, ...own, ...(yaml !== undefined ? { "factory.yaml": yaml } : {}) };
  };
  for (const slug of Object.keys(folders)) out[slug] = resolve(slug, []);
  return out;
}

function safeYaml(text: string | undefined): unknown {
  if (text === undefined) return {};
  try {
    return parse(text) ?? {};
  } catch {
    return {};
  }
}

function mergeYaml(base: string, own: string): string {
  const a = safeYaml(base);
  const b = safeYaml(own);
  const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {});
  return JSON.stringify({ ...obj(a), ...obj(b) });
}

/** The version id of a resolved folder: its content hash. */
export function versionOf(slug: string, files: Record<string, string>): string {
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) h.update(`${path}\0${files[path]}\0`);
  return `fv_${slug}_${h.digest("hex").slice(0, 10)}`;
}

/** Read one resolved folder into a factory and its version. Every problem is reported, so a PR can fix them all. */
export function readFolder(slug: string, files: Record<string, string>): FolderResult {
  const problems: string[] = [];
  let yaml: unknown;
  try {
    yaml = files["factory.yaml"] === undefined ? {} : (parse(files["factory.yaml"]) ?? {});
  } catch (e) {
    problems.push(`factory.yaml isn't valid YAML: ${String(e).slice(0, 200)}`);
  }
  const head = FolderYaml.safeParse(yaml ?? {});
  if (!head.success) problems.push(`factory.yaml: ${head.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);

  const skills: VersionBundle["skills"] = [];
  for (const [path, text] of Object.entries(files)) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (!m) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    const meta = SkillHead.safeParse(fm ? safeYaml(fm[1]) : {});
    if (!fm || !meta.success) {
      problems.push(`${path}: needs frontmatter with name and description`);
      continue;
    }
    if (meta.data.name !== m[1]) problems.push(`${path}: name "${meta.data.name}" should match its folder "${m[1]}"`);
    skills.push({ name: meta.data.name, description: meta.data.description, body: fm[2] ?? "" });
  }

  let mcp: McpServer[] = [];
  if (files["mcp.json"] !== undefined) {
    let json: unknown = null;
    try {
      json = JSON.parse(files["mcp.json"]);
    } catch (e) {
      problems.push(`mcp.json isn't valid JSON: ${String(e).slice(0, 200)}`);
    }
    const parsed = McpJson.safeParse(json);
    if (json !== null && !parsed.success) problems.push(`mcp.json: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    if (parsed.success) mcp = Object.entries(parsed.data.mcpServers).map(([name, s]) => ({ name, ...s }));
  }

  if (problems.length > 0 || !head.success) return { ok: false, problems };
  const { label, models, effort, codegraph, ...factory } = head.data;
  const prompt = files["agents/worker.md"]?.trim() || null;
  const bundle = VersionBundle.parse({ agentsMd: files["AGENTS.md"], skills: skills.sort((a, b) => a.name.localeCompare(b.name)), mcp, effort, codegraph });
  return { ok: true, folder: { factory: { ...factory, slug }, version: { id: versionOf(slug, files), label, prompt, models, bundle } } };
}
