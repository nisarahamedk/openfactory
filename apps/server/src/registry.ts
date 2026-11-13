/**
 * Provider registry: factory.yaml says which provider serves each abstraction;
 * env vars are the fallback when there is no factory.yaml.
 *
 *   providers:
 *     codeForge: github
 *     signals: { github: { repos: [acme/app], pollIntervalMs: 20000 } }
 *     chat: github
 *     agent: acp
 *     workspace: { k8s: {} }
 *     devEnvironment: devspace
 *     metrics: dxfake
 *
 * A provider name is a short alias (below), `provider-<name>` under @openfactory, or a full package name.
 * The package exports `provider: Provider` (preferred) or, for one abstraction, `fromEnv(env)` (older form).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  ABSTRACTION_KEYS,
  type AbstractionKey,
  type Abstractions,
  type Environment,
  type EnvironmentHandle,
  type Provider,
} from "@openfactory/contracts";
import { parse } from "yaml";
import { z } from "zod";

/** Short names. Some vendors serve several abstractions with different packages (k8s workspace vs k8s secrets). */
const ALIASES: Record<string, string> = {
  github: "@openfactory/github",
  acp: "@openfactory/agent-acp",
  k8s: "@openfactory/workspace-k8s",
  local: "@openfactory/workspace-local",
  devspace: "@openfactory/env-devspace",
  dxfake: "@openfactory/metrics-dxfake",
  litellm: "@openfactory/models-litellm",
  infisical: "@openfactory/secrets-infisical",
  "secrets:k8s": "@openfactory/secrets-k8s",
};

export type Selection = { name: string; options: Record<string, unknown> };
export type Selections = Partial<Record<AbstractionKey, Selection>>;

const SelectionInput = z.union([z.string(), z.record(z.string(), z.record(z.string(), z.unknown()).nullable()).refine((o) => Object.keys(o).length === 1, "one provider per abstraction")]);
const FactoryFile = z.object({ providers: z.partialRecord(z.enum(ABSTRACTION_KEYS), SelectionInput).default({}) }).passthrough();

export function parseFactoryFile(text: string): Selections {
  const doc = FactoryFile.parse(parse(text) ?? {});
  const out: Selections = {};
  for (const [key, sel] of Object.entries(doc.providers) as [AbstractionKey, z.infer<typeof SelectionInput>][]) {
    if (typeof sel === "string") out[key] = { name: sel, options: {} };
    else {
      const [name, options] = Object.entries(sel)[0]!;
      out[key] = { name, options: options ?? {} };
    }
  }
  return out;
}

/** The pre-factory.yaml configuration, from env vars. */
export function selectionsFromEnv(env: Record<string, string | undefined>): Selections {
  const s: Selections = {
    codeForge: { name: "github", options: {} },
    chat: { name: "github", options: {} },
    agent: { name: env.AGENT_PLUGIN ?? "acp", options: {} },
    workspace: { name: env.WORKSPACE_PLUGIN ?? "k8s", options: {} },
    devEnvironment: { name: env.ENV_PLUGIN ?? "devspace", options: {} },
  };
  if ((env.SIGNALS ?? "poll") !== "webhook") s.signals = { name: "github", options: {} };
  if (env.DXFAKE_URL && env.DXFAKE_TOKEN) s.metrics = { name: "dxfake", options: {} };
  if (env.LITELLM_ADMIN_URL && env.LITELLM_MASTER_KEY) s.modelGateway = { name: "litellm", options: {} };
  if (env.SECRETS_PLUGIN) s.secrets = { name: env.SECRETS_PLUGIN, options: {} };
  return s;
}

/** factory.yaml wins per abstraction; env fills what it leaves out. */
export function loadSelections(env: Record<string, string | undefined>, path?: string): { selections: Selections; source: string } {
  const fromEnv = selectionsFromEnv(env);
  if (!path || !existsSync(path)) return { selections: fromEnv, source: "env" };
  return { selections: { ...fromEnv, ...parseFactoryFile(readFileSync(path, "utf8")) }, source: path };
}

/** devEnvironment "none": no running product; the agent validates in its workspace. */
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

type Mod = { provider?: Provider; fromEnv?: (env: Record<string, string | undefined>) => unknown };
export type Importer = (pkg: string) => Promise<Mod>;

export class ProviderRegistry {
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly log: (m: string, f?: Record<string, unknown>) => void,
    private readonly importer: Importer = (pkg) => import(pkg) as Promise<Mod>,
  ) {}

  static packageFor(name: string, key?: AbstractionKey): string {
    return (key && ALIASES[`${key}:${name}`]) ?? ALIASES[name] ?? (name.includes("/") ? name : `@openfactory/provider-${name}`);
  }

  async build<K extends AbstractionKey>(key: K, sel: Selection, envOverrides: Record<string, string> = {}): Promise<Abstractions[K]> {
    if (key === "devEnvironment" && sel.name === "none") return noEnvironment() as Abstractions[K];
    const pkg = ProviderRegistry.packageFor(sel.name, key);
    const mod = await this.importer(pkg);
    const env = { ...this.env, ...envOverrides };
    const make = mod.provider?.provides[key];
    if (make) return (await make({ options: sel.options, env, log: this.log })) as Abstractions[K];
    if (typeof mod.fromEnv === "function") {
      // Older single-abstraction packages: options become env vars (UPPER_SNAKE) so factory.yaml still configures them.
      const fromOptions = Object.fromEntries(Object.entries(sel.options).map(([k, v]) => [k.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase(), String(v)]));
      return (await mod.fromEnv({ ...env, ...fromOptions })) as Abstractions[K];
    }
    throw new Error(`${pkg} does not provide "${key}" (export provider.provides.${key} or fromEnv)`);
  }

  async buildAll(selections: Selections): Promise<Partial<Abstractions>> {
    const out: Partial<Abstractions> = {};
    for (const key of ABSTRACTION_KEYS) {
      const sel = selections[key];
      if (!sel) continue;
      (out as Record<string, unknown>)[key] = await this.build(key, sel);
      this.log("provider", { abstraction: key, provider: sel.name });
    }
    return out;
  }
}
