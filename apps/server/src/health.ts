/**
 * Start-up checks: is the factory set up so a task can succeed? Run at start and every few minutes, shown at
 * GET /v1/health and in the app, and run again for each new task before any environment is made, so a setup
 * mistake (a model the gateway key can't use, a token without repo access) stops the task in seconds with a
 * fix, instead of failing minutes in with a raw error.
 */
import type { RepoRef, TaskRecord } from "@openfactory/contracts";

export type Check = { name: string; ok: boolean; detail: string; fix: string | null };

export type HealthDeps = {
  /** GET a code-host path with the factory's token (e.g. "/user", "/repos/o/n"). Throws on non-2xx. */
  forgeGet: (path: string) => Promise<unknown>;
  /** Who the factory is on the code host (a login, or "<app>[bot]"). Throws when the credential is refused. */
  identity: () => Promise<string>;
  /** How agents get their push token: a GitHub App (scoped, 1 h), a Secrets provider, or the server's own token. */
  pushTokens: "app" | "secrets" | "shared";
  repos: RepoRef[];
  /** OpenAI-compatible gateway base URL (".../v1") and the key tasks and the foreman use. Null: no gateway. */
  gateway: { baseUrl: string; key: string } | null;
  /** Models the factory may route to (worker default, routes, version routes, foreman). */
  models: string[];
  /** Models each per-task key is allowed (TASK_KEY_MODELS), when per-task keys are on. */
  taskKeyModels: string[] | null;
  fetch?: typeof fetch;
  now?: () => Date;
};

export class Health {
  private last: { at: string; checks: Check[] } | null = null;
  private available: Set<string> | null = null;
  private running: Promise<Check[]> | null = null;
  /** A hung code host must not hold up start-up: every code-host call here gives up after 10 s. */
  private readonly calls: Pick<HealthDeps, "forgeGet" | "identity"> = { forgeGet: (p) => within(this.d.forgeGet(p)), identity: () => within(this.d.identity()) };

  constructor(private readonly d: HealthDeps) {}

  /** The latest results, running the checks first if they never ran. */
  async current(): Promise<{ at: string; ok: boolean; checks: Check[] }> {
    if (!this.last) await this.run();
    const last = this.last!;
    return { at: last.at, ok: last.checks.every((c) => c.ok), checks: last.checks };
  }

  /** Run every check now (one run at a time). */
  run(): Promise<Check[]> {
    this.running ??= this.runAll().finally(() => (this.running = null));
    return this.running;
  }

  /** The checks a new task needs: the latest org checks, plus whether its own model is reachable. */
  async forTask(task: TaskRecord): Promise<Check[]> {
    const { checks } = await this.current();
    return [...checks.filter((c) => c.name !== "models"), this.modelCheck(task.harness.model)];
  }

  private async runAll(): Promise<Check[]> {
    const checks = [await this.forge(), this.pushTokenCheck(), ...(await this.forgeRepos()), await this.gateway()];
    checks.push(this.allModels());
    this.last = { at: (this.d.now?.() ?? new Date()).toISOString(), checks };
    return checks;
  }

  private async forge(): Promise<Check> {
    try {
      return { name: "code host", ok: true, detail: `signed in as ${await this.calls.identity()}`, fix: null };
    } catch (e) {
      return { name: "code host", ok: false, detail: `the credential was refused: ${short(e)}`, fix: "Check the GitHub App (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, installed on the repos) or the token in GITHUB_TOKEN." };
    }
  }

  /** Not a blocker, but said plainly: with a shared token, a token leaked from a sandbox reaches every repo the factory can. */
  private pushTokenCheck(): Check {
    const detail = {
      app: "each task gets a GitHub App token for its own repos, valid 1 hour",
      secrets: "each task gets a token from the secrets provider",
      shared: "agents get the factory's own token, not a per-task one. Keep it limited to the factory's repos, or set up a GitHub App",
    }[this.d.pushTokens];
    return { name: "agent push tokens", ok: true, detail, fix: null };
  }

  private async forgeRepos(): Promise<Check[]> {
    return Promise.all(
      this.d.repos.map(async (r): Promise<Check> => {
        const name = `repo ${r.owner}/${r.name}`;
        try {
          const repo = (await this.calls.forgeGet(`/repos/${r.owner}/${r.name}`)) as { permissions?: { push?: boolean } };
          if (repo.permissions && repo.permissions.push === false)
            return { name, ok: false, detail: "the token can read it but not push", fix: `Give the token Contents, Issues and Pull requests write access to ${r.owner}/${r.name}.` };
          return { name, ok: true, detail: "reachable", fix: null };
        } catch (e) {
          return { name, ok: false, detail: `not reachable: ${short(e)}`, fix: `Give the token access to ${r.owner}/${r.name}, or remove it from FACTORY_REPOS.` };
        }
      }),
    );
  }

  private async gateway(): Promise<Check> {
    const g = this.d.gateway;
    if (!g) {
      this.available = null;
      return { name: "model gateway", ok: true, detail: "not configured; agents use their own keys", fix: null };
    }
    try {
      const res = await (this.d.fetch ?? fetch)(`${g.baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${g.key}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      this.available = new Set((body.data ?? []).map((m) => m.id));
      return { name: "model gateway", ok: true, detail: `${this.available.size} models available to the factory key`, fix: null };
    } catch (e) {
      this.available = null;
      return { name: "model gateway", ok: false, detail: `unreachable or refused the key: ${short(e)}`, fix: "Check the gateway is up and MODEL_PROXY_KEY is valid." };
    }
  }

  private modelCheck(model: string): Check {
    const name = `model ${model}`;
    const allowed = this.d.taskKeyModels;
    if (allowed && !allowed.includes(model))
      return { name, ok: false, detail: "per-task keys aren't allowed this model", fix: `Add ${model} to TASK_KEY_MODELS, or route this task to another model.` };
    if (this.available && !this.available.has(model))
      return { name, ok: false, detail: "the gateway key can't use this model", fix: `Add ${model} to the gateway key's models (LiteLLM key settings), or route this task to another model.` };
    return { name, ok: true, detail: "available", fix: null };
  }

  private allModels(): Check {
    const bad = [...new Set(this.d.models)].map((m) => this.modelCheck(m)).filter((c) => !c.ok);
    if (bad.length === 0) return { name: "models", ok: true, detail: `${new Set(this.d.models).size} routed models available`, fix: null };
    return { name: "models", ok: false, detail: bad.map((b) => `${b.name.slice("model ".length)}: ${b.detail}`).join("; "), fix: bad.map((b) => b.fix).join(" ") };
  }
}

const TIMEOUT_MS = 10_000;

function within<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

function short(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}
