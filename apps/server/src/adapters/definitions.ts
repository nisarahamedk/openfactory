/**
 * Factories as code on GitHub. Each factory is a folder `<dir>/<slug>/` in the definitions repo (format:
 * factory-folder.ts). Changes made through the API open one pull request with one commit; the sync reads the
 * default branch, so a folder becomes a new factory version once its PR is merged.
 */
import { OrgFactory, type RepoRef } from "@openfactory/contracts";
import type { DefinitionRepo, OrgStore, Proposed } from "@openfactory/core";
import type { GitHubClient } from "@openfactory/github";
import { parseDocument } from "yaml";
import { readFolder, resolveFolders, type FactoryFolder } from "./factory-folder.js";

export type DefinitionsConfig = { repo: RepoRef; branch: string; dir: string };
type Gh = Pick<GitHubClient, "request">;
type Tree = { tree: Array<{ path: string; type: string; sha: string }>; truncated: boolean };

/** JSON with keys sorted at every level, so two equal records compare equal whatever order they were written in. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}` : JSON.stringify(v);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Reads folders off the default branch, keeping blobs by sha so a repeated read only fetches what changed. */
export class DefinitionsReader {
  private readonly blobs = new Map<string, string>();
  constructor(
    private readonly gh: Gh,
    readonly cfg: DefinitionsConfig,
  ) {}

  private get base() {
    return `/repos/${this.cfg.repo.owner}/${this.cfg.repo.name}`;
  }

  /** Every folder under the definitions dir, slug → path → content. */
  async folders(): Promise<Record<string, Record<string, string>>> {
    const tree = await this.gh.request<Tree>("GET", `${this.base}/git/trees/${encodeURIComponent(this.cfg.branch)}?recursive=1`);
    if (tree.truncated) throw new Error("the definitions repo's tree is too large for one read; keep it to factory folders");
    const prefix = `${this.cfg.dir}/`;
    const out: Record<string, Record<string, string>> = {};
    for (const item of tree.tree) {
      if (item.type !== "blob" || !item.path.startsWith(prefix)) continue;
      const [slug, ...rest] = item.path.slice(prefix.length).split("/");
      if (!slug || rest.length === 0 || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) continue;
      let text = this.blobs.get(item.sha);
      if (text === undefined) {
        const blob = await this.gh.request<{ content: string }>("GET", `${this.base}/git/blobs/${item.sha}`);
        text = Buffer.from(blob.content, "base64").toString("utf8");
        this.blobs.set(item.sha, text);
      }
      (out[slug] ??= {})[rest.join("/")] = text;
    }
    return out;
  }
}

export function githubDefinitions(gh: Gh, cfg: DefinitionsConfig, now: () => string = () => new Date().toISOString()): DefinitionRepo {
  const base = `/repos/${cfg.repo.owner}/${cfg.repo.name}`;
  const where = `${cfg.repo.owner}/${cfg.repo.name}`;
  const reader = new DefinitionsReader(gh, cfg);

  /** One branch, one commit with every change, one pull request. */
  async function propose(slug: string, changes: Record<string, string | null>, by: string, title: string): Promise<Proposed> {
    const branch = `factory/${slug}-${now().replace(/[^0-9]/g, "").slice(0, 14)}`;
    try {
      const head = await gh.request<{ object: { sha: string } }>("GET", `${base}/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
      const commit = await gh.request<{ tree: { sha: string } }>("GET", `${base}/git/commits/${head.object.sha}`);
      const tree = await gh.request<{ sha: string }>("POST", `${base}/git/trees`, {
        base_tree: commit.tree.sha,
        tree: Object.entries(changes).map(([path, content]) => ({ path: `${cfg.dir}/${slug}/${path}`, mode: "100644", type: "blob", ...(content === null ? { sha: null } : { content }) })),
      });
      const made = await gh.request<{ sha: string }>("POST", `${base}/git/commits`, { message: title, tree: tree.sha, parents: [head.object.sha] });
      await gh.request("POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: made.sha });
      const pr = await gh.request<{ number: number; html_url: string }>("POST", `${base}/pulls`, {
        title,
        head: branch,
        base: cfg.branch,
        body: `Proposed in the factory by ${by}. Once merged, the factory reads \`${cfg.dir}/${slug}/\` as a new version; set it live or as a candidate under Factories > Versions.`,
      });
      return { ok: true, number: pr.number, url: pr.html_url };
    } catch (e) {
      return { ok: false, reason: message(e) };
    }
  }

  return {
    where: () => where,
    async files(slug) {
      try {
        return { ok: true, files: (await reader.folders())[slug] ?? null };
      } catch (e) {
        return { ok: false, reason: message(e) };
      }
    },
    async proposeFactory(def, by) {
      // Only the settings change: the rest of factory.yaml (comments, models, effort, label) stays as written.
      let current: string | undefined;
      try {
        current = (await reader.folders())[def.slug]?.["factory.yaml"];
      } catch (e) {
        return { ok: false, reason: message(e) };
      }
      const doc = parseDocument(current ?? `# The ${def.slug} factory. See docs/architecture.md for the folder format.\n`);
      const { slug: _slug, createdBy: _by, createdAt: _at, ...settings } = def;
      for (const [k, v] of Object.entries(settings)) doc.set(k, v);
      return propose(def.slug, { "factory.yaml": doc.toString() }, by, `${current === undefined ? "Add" : "Change"} the ${def.slug} factory`);
    },
    proposeFiles: propose,
  };
}

export type SyncResult = { factories: string[]; versions: FactoryFolder["version"][]; problems: Record<string, string[]> };

/**
 * Read every folder on the default branch: write changed factories into OrgStore and return every version, so
 * the caller can register them. A folder with problems is skipped and reported, never hiding the others.
 */
export async function syncDefinitions(reader: Pick<DefinitionsReader, "folders">, org: Pick<OrgStore, "factories" | "putFactory">, now: () => string): Promise<SyncResult> {
  const resolved = resolveFolders(await reader.folders());
  const known = new Map((await org.factories()).map((f) => [f.slug, f]));
  const out: SyncResult = { factories: [], versions: [], problems: {} };
  for (const [slug, files] of Object.entries(resolved)) {
    const r = readFolder(slug, files);
    if (!r.ok) {
      out.problems[slug] = r.problems;
      continue;
    }
    out.versions.push(r.folder.version);
    // The org default is factory.yaml's; its folder only contributes a version.
    if (slug === "default") continue;
    const prev = known.get(slug);
    const next = OrgFactory.parse({ ...r.folder.factory, createdBy: prev?.createdBy ?? null, createdAt: prev?.createdAt ?? now() });
    const same = prev && canonical({ ...prev, createdBy: null, createdAt: "" }) === canonical({ ...next, createdBy: null, createdAt: "" });
    if (same) continue;
    await org.putFactory(next);
    out.factories.push(slug);
  }
  return out;
}
