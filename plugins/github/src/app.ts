/**
 * GitHub App auth: the factory signs in as its own app, not as a person.
 *
 * - The server's own calls (polling, comments, PRs) use an installation token for the org, cached and
 *   refreshed 5 minutes before it expires (GitHub gives them 1 hour).
 * - Each task's agent gets its own installation token, narrowed to the task's repos and to contents,
 *   pull requests and issues. It expires in an hour and is minted again before every turn.
 *
 * So a token that leaks from a sandbox can reach only that task's repos, only for an hour, and never
 * merges past branch protection. With a PAT (the fallback) the agent holds the factory's own token.
 *
 * Set up: create a GitHub App with Contents, Issues and Pull requests (read and write), Metadata (read),
 * Checks and Commit statuses (read); install it on the repos; give the server GITHUB_APP_ID and
 * GITHUB_APP_PRIVATE_KEY (the PEM). Docs: docs/self-host.md.
 */
import { createSign } from "node:crypto";
import type { RepoRef } from "@openfactory/contracts";

export type GitHubAppOptions = {
  appId: string;
  /** PEM private key of the app. Literal "\n" sequences are turned into newlines (env vars often carry them). */
  privateKey: string;
  /** A repo whose installation the server's own calls use (usually the first of FACTORY_REPOS). */
  home: { owner: string; name: string };
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

type Cached = { token: string; expiresAt: number };

/** What each task's token may do. Enough to push a branch, open and comment on a PR, and read the issue. */
export const TASK_TOKEN_PERMISSIONS = { contents: "write", pull_requests: "write", issues: "write", metadata: "read" } as const;

const REFRESH_MS = 5 * 60_000;

export class GitHubAppAuth {
  private readonly api: string;
  private readonly f: typeof fetch;
  private readonly key: string;
  private readonly installations = new Map<string, Promise<number>>();
  private server: Cached | null = null;
  private slug: string | null = null;

  constructor(private readonly opts: GitHubAppOptions) {
    this.api = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
    this.key = opts.privateKey.includes("\\n") ? opts.privateKey.replace(/\\n/g, "\n") : opts.privateKey;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A short-lived JWT that proves we are the app (RS256, 9 minutes, backdated 60 s for clock drift). */
  jwt(): string {
    const iat = Math.floor(this.now() / 1000) - 60;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat, exp: iat + 9 * 60, iss: this.opts.appId })}`;
    const sig = createSign("RSA-SHA256").update(body).sign(this.key).toString("base64url");
    return `${body}.${sig}`;
  }

  private async call<T>(method: string, path: string, auth: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${auth}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "openfactory",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** The installation id for an owner's repos (cached). */
  installationFor(owner: string, repo: string): Promise<number> {
    let p = this.installations.get(owner);
    if (!p) {
      p = this.call<{ id: number }>("GET", `/repos/${owner}/${repo}/installation`, this.jwt()).then((i) => i.id);
      p.catch(() => this.installations.delete(owner));
      this.installations.set(owner, p);
    }
    return p;
  }

  private async mint(installation: number, body?: object): Promise<Cached> {
    const t = await this.call<{ token: string; expires_at: string }>("POST", `/app/installations/${installation}/access_tokens`, this.jwt(), body);
    return { token: t.token, expiresAt: Date.parse(t.expires_at) };
  }

  /** The server's own token: the owner's installation, all repos the app is installed on. */
  async serverToken(): Promise<string> {
    if (this.server && this.server.expiresAt - this.now() > REFRESH_MS) return this.server.token;
    this.server = await this.mint(await this.installationFor(this.opts.home.owner, this.opts.home.name));
    return this.server.token;
  }

  /** A token for one task: only these repos (same owner), only contents, pull requests and issues. */
  async taskToken(repos: RepoRef[], permissions: Record<string, "read" | "write"> = TASK_TOKEN_PERMISSIONS): Promise<{ token: string; expiresAt: string }> {
    const first = repos[0];
    if (!first) throw new Error("taskToken needs at least one repo");
    const owners = new Set(repos.map((r) => r.owner));
    if (owners.size > 1) throw new Error(`one task token covers one owner; got ${[...owners].join(", ")}`);
    const t = await this.mint(await this.installationFor(first.owner, first.name), {
      repositories: repos.map((r) => r.name),
      permissions,
    });
    return { token: t.token, expiresAt: new Date(t.expiresAt).toISOString() };
  }

  /** The app's bot login, e.g. "acme-factory[bot]" (what its comments are posted as). */
  async botLogin(): Promise<string> {
    this.slug ??= (await this.call<{ slug: string }>("GET", "/app", this.jwt())).slug;
    return `${this.slug}[bot]`;
  }
}

/** A GitHub App from env (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY; the server's installation is the first FACTORY_REPOS repo's), else null. */
export function githubAppFromEnv(env: Record<string, string | undefined>, extra: Partial<GitHubAppOptions> = {}): GitHubAppAuth | null {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  const [owner, name] = ((env.FACTORY_REPOS ?? "").split(",")[0] ?? "").trim().split("/");
  if (!owner || !name) throw new Error("GitHub App: FACTORY_REPOS must name at least one owner/name");
  return new GitHubAppAuth({ appId, privateKey, home: { owner, name }, ...extra });
}
