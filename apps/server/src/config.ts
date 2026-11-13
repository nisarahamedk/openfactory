import { RepoRef } from "@openfactory/contracts";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(8080),
  PUBLIC_URL: z.string().url(), // where reviewers open evidence, e.g. https://factory.1-2-3-4.sslip.io
  DATABASE_URL: z.string(),
  DATA_DIR: z.string().default("/data"),
  FACTORY_API_TOKEN: z.string().optional(), // bearer for /v1; unset = open (dev only)
  FACTORY_VERSION: z.string().default("fv_dev"),
  FACTORY_LABEL: z.string().default("factory"),
  FACTORY_REPOS: z.string(), // "owner/name,owner/name"
  BASE_BRANCH: z.string().default("main"),
  BOT_LOGINS: z.string().default(""),
  MAX_TASK_USD: z.coerce.number().default(8),
  MAX_REVIEW_ROUNDS: z.coerce.number().default(4),
  MAX_NUDGES: z.coerce.number().default(1),

  GITHUB_TOKEN: z.string(),
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
export type Config = z.infer<typeof Env> & { repos: RepoRef[]; agentEnv: Record<string, string> };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const c = Env.parse(env);
  const repos = c.FACTORY_REPOS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [owner, name] = s.split("/");
      return RepoRef.parse({ host: "github", owner, name });
    });
  const agentEnv = z.record(z.string(), z.string()).parse(JSON.parse(c.AGENT_ENV_JSON));
  return { ...c, repos, agentEnv };
}
