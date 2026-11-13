/**
 * Teams from a GitHub organization: each team's members (maintainers marked) and the repos it has
 * write access to. `factories` maps a team slug to the team factory it runs on (default otherwise);
 * `teams` limits which teams are listed.
 */
import type { Directory, Team } from "@openfactory/contracts";
import type { GitHubClient } from "./index.js";

export type GitHubDirectoryOptions = { org: string; teams?: string[]; factories?: Record<string, string> };

type GhTeam = { slug: string; name: string };
type GhMember = { login: string };
type GhRepo = { full_name: string; permissions?: { push?: boolean; admin?: boolean; maintain?: boolean } };

export class GitHubDirectory implements Directory {
  readonly name = "github";
  constructor(
    private readonly gh: GitHubClient,
    private readonly opts: GitHubDirectoryOptions,
  ) {}

  async teams(): Promise<Team[]> {
    const org = this.opts.org;
    const all = await this.all<GhTeam>(`/orgs/${org}/teams`);
    const wanted = this.opts.teams ? all.filter((t) => this.opts.teams!.includes(t.slug)) : all;
    return Promise.all(
      wanted.map(async (t) => {
        const [members, maintainers, repos] = await Promise.all([
          this.all<GhMember>(`/orgs/${org}/teams/${t.slug}/members`),
          this.all<GhMember>(`/orgs/${org}/teams/${t.slug}/members?role=maintainer`),
          this.all<GhRepo>(`/orgs/${org}/teams/${t.slug}/repos`),
        ]);
        const lead = new Set(maintainers.map((m) => m.login));
        return {
          slug: t.slug,
          name: t.name,
          source: `github:${org}/${t.slug}`,
          members: members.map((m) => ({ login: m.login, name: null, role: lead.has(m.login) ? ("maintainer" as const) : ("member" as const) })),
          repos: repos.filter((r) => r.permissions?.push || r.permissions?.maintain || r.permissions?.admin).map((r) => r.full_name),
          factory: this.opts.factories?.[t.slug] ?? "default",
        };
      }),
    );
  }

  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= 10; page++) {
      const items = await this.gh.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }
}
