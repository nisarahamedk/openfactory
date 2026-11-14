import { RepoRef } from "@openfactory/contracts";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_URL: z.string().url(), // where reviewers open evidence, e.g. https://factory.1-2-3-4.sslip.io
  DATABASE_URL: z.string(),
  DATA_DIR: z.string().default("/data"),
  /** Where durable task jobs keep their state: "postgres" (any server can carry a task on) or "files" (SQLite per task under DATA_DIR). */
  JOB_STATE: z.enum(["postgres", "files"]).default("postgres"),
  FACTORY_API_TOKEN: z.string().optional(), // bearer for /v1; unset = open (dev only)
  FACTORY_VERSION: z.string().default("fv_dev"),
  /** factory.yaml with `providers:`; env vars below fill anything it leaves out. */
  FACTORY_FILE: z.string().optional(),
  FACTORY_LABEL: z.string().default("factory"),
  /**
   * Factories as code: "owner/name" of the repo holding team factory definitions. Saving a factory in the app
   * opens a PR there, and merged definitions are synced every minute. Unset = saved straight to the database.
   */
  FACTORY_DEFINITIONS_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  FACTORY_DEFINITIONS_BRANCH: z.string().default("main"),
  FACTORY_DEFINITIONS_DIR: z.string().regex(/^[\w./-]+$/).default("factories"),
  FACTORY_REPOS: z.string(), // "owner/name,owner/name"
  BASE_BRANCH: z.string().default("main"),
  BOT_LOGINS: z.string().default(""),
  MAX_TASK_USD: z.coerce.number().default(8),
  MAX_REVIEW_ROUNDS: z.coerce.number().default(4),
  MAX_NUDGES: z.coerce.number().default(2),

  /** A fine-grained PAT. Without a GitHub App, the agent gets this same token (see GITHUB_APP_*). */
  GITHUB_TOKEN: z.string().optional(),
  /** A GitHub App: the server uses an installation token, each task gets one scoped to its repos for 1 hour. */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  SIGNALS: z.enum(["poll", "webhook", "both"]).default("poll"),
  POLL_INTERVAL_MS: z.coerce.number().default(20_000),
  POLL_LOOKBACK_MS: z.coerce.number().default(15 * 60_000),

  MODEL_PROXY_URL: z.string().optional(), // OpenAI-compatible base, e.g. http://litellm:4000/v1
  MODEL_PROXY_KEY: z.string().optional(),
  FOREMAN_MODEL: z.string().default("claude-haiku"),
  FOREMAN_COST_IN: z.coerce.number().default(1),
  FOREMAN_COST_OUT: z.coerce.number().default(5),
  WORKER_MODEL: z.string().default("claude-sonnet"),
  /** With these, each task gets its own LiteLLM key capped at MAX_TASK_USD (the shared key stays out of sandboxes). */
  LITELLM_ADMIN_URL: z.string().optional(),
  LITELLM_MASTER_KEY: z.string().optional(),
  TASK_KEY_MODELS: z.string().default("claude-sonnet,claude-haiku"),

  AGENT_PLUGIN: z.string().default("acp"),
  WORKSPACE_PLUGIN: z.string().default("k8s"),
  ENV_PLUGIN: z.string().default("devspace"),
  WORKER_IMAGE: z.string().optional(),
  /** JSON object of extra env for every agent process. */
  AGENT_ENV_JSON: z.string().default("{}"),

  DXFAKE_URL: z.string().optional(),
  DXFAKE_TOKEN: z.string().optional(),
  BENCH_DIR: z.string().optional(),
  BENCH_MAX_USD_PER_RUN: z.coerce.number().default(5),
  /** How the repo runs a chosen set of test files (packages/bench CheckSpec, JSON). Unset = vitest with file args. */
  BENCH_CHECK_JSON: z.string().optional(),
});
export type Config = z.infer<typeof Env> & { repos: RepoRef[]; agentEnv: Record<string, string>; definitions: { repo: RepoRef; branch: string; dir: string } | null };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = Env.parse(env);
  if (!c.GITHUB_TOKEN && !(c.GITHUB_APP_ID && c.GITHUB_APP_PRIVATE_KEY))
    throw new Error("Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (a GitHub App, recommended), or GITHUB_TOKEN (a PAT).");
  const repos = c.FACTORY_REPOS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [owner, name] = s.split("/");
      return RepoRef.parse({ host: "github", owner, name });
    });
  const agentEnv = z.record(z.string(), z.string()).parse(JSON.parse(c.AGENT_ENV_JSON));
  const [dOwner, dName] = c.FACTORY_DEFINITIONS_REPO?.split("/") ?? [];
  const definitions = dOwner && dName ? { repo: RepoRef.parse({ host: "github", owner: dOwner, name: dName }), branch: c.FACTORY_DEFINITIONS_BRANCH, dir: c.FACTORY_DEFINITIONS_DIR.replace(/\/+$/, "") } : null;
  return { ...c, repos, agentEnv, definitions };
}
