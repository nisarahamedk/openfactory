import type { DevEnvironment, EnvironmentHandle, RepoRef, TaskId } from "@openfactory/contracts";

interface Record_ {
  taskId: TaskId;
  repo: RepoRef;
  asleep: boolean;
}

/**
 * A DevEnvironment that lives in memory: an environment per task, with the
 * same naming, credentials and lifecycle shape as a real one. Nothing runs.
 */
export class InMemoryDevEnvironment implements DevEnvironment {
  readonly name = "in-memory-fake";
  private readonly envs = new Map<string, Record_>();

  constructor(private readonly options: { home: string; appUrl: (name: string) => string } = { home: "/work/home", appUrl: (n) => `http://${n}.env.test` }) {}

  async create(input: { taskId: TaskId; repo: RepoRef }): Promise<EnvironmentHandle> {
    const name = `task-${input.taskId.replace(/^task_/, "").toLowerCase()}`;
    if (!this.envs.has(name)) this.envs.set(name, { taskId: input.taskId, repo: input.repo, asleep: false });
    return this.handle(name);
  }

  async get(name: string): Promise<EnvironmentHandle | null> {
    return this.envs.has(name) ? this.handle(name) : null;
  }

  /** For tests: whether an environment is asleep. */
  isAsleep(name: string): boolean | null {
    return this.envs.get(name)?.asleep ?? null;
  }

  private handle(name: string): EnvironmentHandle {
    const envs = this.envs;
    const { home, appUrl } = this.options;
    return {
      name,
      credentialsForWorkspace: async () => [
        { path: `${home}/.kube/config`, content: `# kubeconfig for ${name}\n` },
        { path: `${home}/.claude/skills/factory-environment/SKILL.md`, content: skillFor(name, appUrl(name)) },
      ],
      envVars: async () => ({ KUBECONFIG: `${home}/.kube/config`, FACTORY_ENV_NAMESPACE: name, FACTORY_ENV_URL: appUrl(name) }),
      skill: async () => skillFor(name, appUrl(name)),
      sleep: async () => {
        const e = envs.get(name);
        if (e !== undefined) e.asleep = true;
      },
      wake: async () => {
        const e = envs.get(name);
        if (e !== undefined) e.asleep = false;
      },
      destroy: async () => {
        envs.delete(name);
      },
    };
  }
}

function skillFor(name: string, url: string): string {
  return `# Your environment: ${name}\n\nDeploy your change, then test it at ${url}.\n`;
}
