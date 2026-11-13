/**
 * Plugins are chosen by name at start. Each plugin package exports
 * `fromEnv(env)` and reads its own settings, so the server never needs to
 * know a vendor's options. Packages load lazily: a deployment only needs the
 * plugins it uses.
 */
import type { AgentHarness, Environment, EnvironmentHandle, Workspace } from "@openfactory/contracts";

type Env = Record<string, string | undefined>;

const PACKAGES = {
  agent: { acp: "@openfactory/agent-acp" },
  workspace: { k8s: "@openfactory/workspace-k8s", local: "@openfactory/workspace-local" },
  environment: { devspace: "@openfactory/env-devspace" },
} as const;

async function load<T>(kind: keyof typeof PACKAGES, name: string, env: Env): Promise<T> {
  const pkg = (PACKAGES[kind] as Record<string, string>)[name];
  if (!pkg) throw new Error(`Unknown ${kind} plugin "${name}". Known: ${Object.keys(PACKAGES[kind]).join(", ")}`);
  const mod = (await import(pkg)) as { fromEnv?: (env: Env) => T | Promise<T> };
  if (typeof mod.fromEnv !== "function") throw new Error(`${pkg} does not export fromEnv(env)`);
  return mod.fromEnv(env);
}

export const loadAgent = (name: string, env: Env) => load<AgentHarness>("agent", name, env);
export const loadWorkspace = (name: string, env: Env) => load<Workspace>("workspace", name, env);

/** ENV_PLUGIN=none: no running product; the agent tests in its workspace only. */
export function noEnvironment(): Environment {
  const handle = (name: string): EnvironmentHandle => ({
    name,
    credentialsForWorkspace: async () => [],
    envVars: async () => ({}),
    skill: async () =>
      "There is no deployed environment for this task. Validate in your workspace: run the app and its e2e tests locally, and name the environment `workspace` in your evidence.",
    sleep: async () => {},
    wake: async () => {},
    destroy: async () => {},
  });
  return { name: "none", create: async ({ taskId }) => handle(`workspace:${taskId}`), get: async (name) => handle(name) };
}

export async function loadEnvironment(name: string, env: Env): Promise<Environment> {
  return name === "none" ? noEnvironment() : load<Environment>("environment", name, env);
}
