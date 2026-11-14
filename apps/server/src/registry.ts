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
 *     evidence: { s3: { endpoint: https://<acct>.r2.cloudflarestorage.com, bucket: evidence, region: auto } }
 *
 * A provider name is a short alias (below), `provider-<name>` under @openfactory, or a full package name.
 * The package exports `provider: Provider` (preferred) or, for one abstraction, `fromEnv(env)` (older form).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  ABSTRACTION_KEYS,
  VersionBundle,
  type AbstractionKey,
  type Abstractions,
  type Environment,
  type EnvironmentHandle,
  type Provider,
} from "@openfactory/contracts";
import { DEFAULT_RISK, type ModelRouting, type RiskConfig, type Rollout } from "@openfactory/rules";
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
  disk: "@openfactory/evidence-disk",
  s3: "@openfactory/evidence-s3",
  openworld: "@openfactory/world-openworld",
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

const ModelRoutingFile = z.object({
  models: z
    .object({
      default: z.string().min(1),
      routes: z
        .array(z.object({ model: z.string().min(1), labels: z.array(z.string()).optional(), keywords: z.array(z.string()).optional() }))
        .default([]),
    })
    .optional(),
}).passthrough();

const list = (v: string | undefined, fallback: string) => (v ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Which worker model a new task gets. factory.yaml:
 *
 *   models:
 *     default: claude-sonnet
 *     routes:
 *       - { model: claude-haiku, labels: [ui, small, test, demo, docs] }
 *
 * Without a `models:` block: default WORKER_MODEL; issues labelled CHEAP_LABELS (default ui, small, test, demo, docs)
 * go to CHEAP_MODEL (default claude-haiku). A `model:<name>` label always wins. MODEL_ROUTING=off disables routing.
 */
export function loadModelRouting(env: Record<string, string | undefined>, path?: string): ModelRouting | null {
  if (env.MODEL_ROUTING === "off") return null;
  if (path && existsSync(path)) {
    const m = ModelRoutingFile.parse(parse(readFileSync(path, "utf8")) ?? {}).models;
    if (m) return { default: m.default, routes: m.routes };
  }
  return {
    default: env.WORKER_MODEL ?? "claude-sonnet",
    routes: [{ model: env.CHEAP_MODEL ?? "claude-haiku", labels: list(env.CHEAP_LABELS, "ui,small,test,demo,docs") }],
  };
}

const OutcomesFile = z.object({
  outcomes: z
    .object({
      sources: z.array(SelectionInput).optional(),
      windowDays: z.number().positive().optional(),
      intervalMs: z.number().int().min(10_000).optional(),
    })
    .optional(),
}).passthrough();

export type OutcomeConfig = { sources: Selection[]; windowDays: number; intervalMs: number };

const toSelection = (sel: z.infer<typeof SelectionInput>): Selection => {
  if (typeof sel === "string") return { name: sel, options: {} };
  const [name, options] = Object.entries(sel)[0]!;
  return { name, options: options ?? {} };
};

/**
 * Where late outcomes come from and how often to look. factory.yaml:
 *
 *   outcomes:
 *     sources: [github, { dxfake: { url: https://dx.example } }]
 *     windowDays: 30        # watch each merged task this long
 *     intervalMs: 600000    # every 10 minutes
 *
 * Without it: github, plus dxfake when DXFAKE_URL and DXFAKE_TOKEN are set; OUTCOME_INTERVAL_MS and
 * OUTCOME_WINDOW_DAYS override the timing. OUTCOMES=off turns the watcher off.
 */
export function loadOutcomeConfig(env: Record<string, string | undefined>, path?: string): OutcomeConfig | null {
  if (env.OUTCOMES === "off") return null;
  const file = path && existsSync(path) ? OutcomesFile.parse(parse(readFileSync(path, "utf8")) ?? {}).outcomes : undefined;
  const defaults: Selection[] = [{ name: "github", options: {} }];
  if (env.DXFAKE_URL && env.DXFAKE_TOKEN) defaults.push({ name: "dxfake", options: {} });
  return {
    sources: file?.sources ? file.sources.map(toSelection) : defaults,
    windowDays: file?.windowDays ?? Number(env.OUTCOME_WINDOW_DAYS ?? 30),
    intervalMs: file?.intervalMs ?? Number(env.OUTCOME_INTERVAL_MS ?? 600_000),
  };
}

export const Routing = z.object({
  default: z.string().min(1),
  routes: z.array(z.object({ model: z.string().min(1), labels: z.array(z.string()).optional(), keywords: z.array(z.string()).optional() })).default([]),
});
const ExtrasFile = z
  .object({
    /** A candidate factory version for a share of new tasks. */
    rollout: z.object({ candidate: z.string().min(1).nullable().default(null), share: z.number().min(0).max(1).default(0) }).optional(),
    /** How each version differs: extra prompt text, other model routing. */
    versions: z.record(z.string(), VersionBundle.extend({ label: z.string().optional(), models: Routing.optional() })).default({}),
    /** The world check run against each settled PR head: a provider package that provides `worldCheck`. */
    world: z
      .object({ provider: z.string().min(1), name: z.string().min(1), simDays: z.number().int().positive().default(30), options: z.record(z.string(), z.unknown()).default({}) })
      .optional(),
    /** Merge-risk rules. */
    risk: z.object({ riskyPaths: z.array(z.string()).optional(), mediumLines: z.number().optional(), highLines: z.number().optional() }).optional(),
  })
  .passthrough();

export type FactoryExtras = {
  rollout: Rollout | null;
  versionPrompts: Record<string, string>;
  versionModels: Record<string, ModelRouting>;
  /** Each version's bundle (skills, AGENTS.md guidance, MCP tools, effort, CodeGraph). */
  versionBundles: Record<string, VersionBundle>;
  /** Each version's human label, when factory.yaml gives one. */
  versionLabels: Record<string, string>;
  risk: RiskConfig;
  world: { provider: string; name: string; simDays: number; options: Record<string, unknown> } | null;
};

/**
 * factory.yaml blocks beyond providers and models:
 *
 *   rollout: { candidate: "2026-11-14.1", share: 0.1 }
 *   versions:
 *     "2026-11-14.1":
 *       label: e2e-first
 *       prompt: Write the e2e test before the code.
 *       models: { default: claude-sonnet, routes: [] }      # routing policy is part of the version
 *       effort: low                                          # reasoning effort
 *       agentsMd: Keep PRs under 200 lines.                  # extra AGENTS.md guidance (CLAUDE.local.md)
 *       skills: [{ name: pricing-faq, description: ..., body: ... }]
 *       mcp: [{ name: docs, command: npx, args: [...] }]     # MCP tools
 *       codegraph: true                                      # CodeGraph index + MCP tool
 *   risk: { riskyPaths: ["(^|/)migrations/"], mediumLines: 200, highLines: 800 }
 */
export function loadFactoryExtras(stableVersion: string, path?: string): FactoryExtras {
  const doc = path && existsSync(path) ? ExtrasFile.parse(parse(readFileSync(path, "utf8")) ?? {}) : ExtrasFile.parse({});
  const versionPrompts: Record<string, string> = {};
  const versionModels: Record<string, ModelRouting> = {};
  const versionBundles: Record<string, VersionBundle> = {};
  const versionLabels: Record<string, string> = {};
  for (const [v, spec] of Object.entries(doc.versions)) {
    const { models, label, prompt, ...bundle } = spec;
    if (prompt) versionPrompts[v] = prompt;
    if (models) versionModels[v] = models;
    if (label) versionLabels[v] = label;
    versionBundles[v] = VersionBundle.parse(bundle);
  }
  return {
    rollout: doc.rollout?.candidate ? { stable: stableVersion, candidate: doc.rollout.candidate, share: doc.rollout.share } : null,
    versionPrompts,
    versionModels,
    versionBundles,
    versionLabels,
    risk: { ...DEFAULT_RISK, ...(doc.risk ?? {}) },
    world: doc.world ?? null,
  };
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

  /** A provider for something outside ABSTRACTION_KEYS (e.g. worldCheck), by package or alias. */
  async buildOptional<T>(key: string, sel: Selection): Promise<T> {
    const pkg = ProviderRegistry.packageFor(sel.name);
    const mod = await this.importer(pkg);
    const make = (mod.provider?.provides as Record<string, ((ctx: unknown) => unknown) | undefined> | undefined)?.[key];
    if (!make) throw new Error(`${pkg} does not provide "${key}"`);
    return (await make({ options: sel.options, env: this.env, log: this.log })) as T;
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
