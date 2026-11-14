/**
 * Factories as code on GitHub. Each team factory is one file, `<dir>/<slug>.yaml`, in the definitions repo,
 * in the same shape as a `factories:` entry in factory.yaml. Saving in the app opens a pull request; the sync
 * copies the default branch into OrgStore, so a definition takes effect once its PR is merged.
 */
import { OrgFactory, type RepoRef } from "@openfactory/contracts";
import type { DefinitionRepo, OrgStore, Proposed } from "@openfactory/core";
import type { GitHubClient } from "@openfactory/github";
import { parse, stringify } from "yaml";

export type DefinitionsConfig = { repo: RepoRef; branch: string; dir: string };

/** The file body: everything but the slug (the file name) and who made it (git history has that). */
const FileBody = OrgFactory.omit({ slug: true, createdBy: true, createdAt: true });

const notFound = (e: unknown) => e instanceof Error && / → 404:/.test(e.message);
const toBase64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The YAML a definition is written as. */
export function definitionFile(def: OrgFactory): string {
  const body = FileBody.parse(def);
  return `# Team factory "${def.slug}". Changes go through pull requests; the factory picks this up once merged.\n${stringify(body)}`;
}

export function githubDefinitions(gh: Pick<GitHubClient, "request">, cfg: DefinitionsConfig, now: () => string = () => new Date().toISOString()): DefinitionRepo {
  const base = `/repos/${cfg.repo.owner}/${cfg.repo.name}`;
  const where = `${cfg.repo.owner}/${cfg.repo.name}`;
  return {
    where: () => where,
    async proposeFactory(def, by): Promise<Proposed> {
      const path = `${cfg.dir}/${def.slug}.yaml`;
      const branch = `factory/${def.slug}-${now().replace(/[^0-9]/g, "").slice(0, 14)}`;
      try {
        const head = await gh.request<{ object: { sha: string } }>("GET", `${base}/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
        await gh.request("POST", `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.object.sha });
        const existing = await gh.request<{ sha: string }>("GET", `${base}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`).catch((e: unknown) => {
          if (notFound(e)) return null;
          throw e;
        });
        await gh.request("PUT", `${base}/contents/${path}`, {
          message: `${existing ? "Change" : "Add"} the ${def.slug} team factory`,
          content: toBase64(definitionFile(def)),
          branch,
          ...(existing ? { sha: existing.sha } : {}),
        });
        const pr = await gh.request<{ number: number; html_url: string }>("POST", `${base}/pulls`, {
          title: `${existing ? "Change" : "Add"} the ${def.slug} team factory`,
          head: branch,
          base: cfg.branch,
          body: `Proposed in the factory app by ${by}. The factory uses this definition for new tasks once this is merged.`,
        });
        return { ok: true, number: pr.number, url: pr.html_url };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
      }
    },
  };
}

/**
 * Copy the definitions on the default branch into OrgStore. Returns the slugs it wrote. A file that doesn't
 * parse is skipped and reported, so one bad file never hides the others.
 */
export async function syncDefinitions(gh: Pick<GitHubClient, "request">, cfg: DefinitionsConfig, org: Pick<OrgStore, "factories" | "putFactory">, now: () => string, log: (m: string, f?: object) => void): Promise<string[]> {
  const base = `/repos/${cfg.repo.owner}/${cfg.repo.name}`;
  const ref = encodeURIComponent(cfg.branch);
  const files = await gh.request<Array<{ name: string; path: string; type: string }>>("GET", `${base}/contents/${cfg.dir}?ref=${ref}`).catch((e: unknown) => {
    if (notFound(e)) return [];
    throw e;
  });
  const known = new Map((await org.factories()).map((f) => [f.slug, f]));
  const wrote: string[] = [];
  for (const f of files) {
    const slug = /^([a-z0-9][a-z0-9-]{0,39})\.ya?ml$/.exec(f.name)?.[1];
    if (f.type !== "file" || !slug || slug === "default") continue;
    const file = await gh.request<{ content: string }>("GET", `${base}/contents/${f.path}?ref=${ref}`);
    const body = FileBody.safeParse(parse(Buffer.from(file.content, "base64").toString("utf8")) ?? {});
    if (!body.success) {
      log("factory definition skipped", { path: f.path, error: body.error.message.slice(0, 300) });
      continue;
    }
    const prev = known.get(slug);
    const next = OrgFactory.parse({ ...body.data, slug, createdBy: prev?.createdBy ?? null, createdAt: prev?.createdAt ?? now() });
    if (prev && JSON.stringify(FileBody.parse(prev)) === JSON.stringify(body.data)) continue;
    await org.putFactory(next);
    wrote.push(slug);
  }
  return wrote;
}
