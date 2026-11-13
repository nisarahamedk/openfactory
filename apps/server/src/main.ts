/**
 * The factory server: one process that takes signals, runs task jobs, and
 * serves the API, evidence and benchmarks. Configured only by env vars.
 */
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { captureOptionsFrom, createBenchRoutes, defaultCaptureOptions, FileBenchStore, GitHubPullRequestSource, parseCheckSpec } from "@openfactory/bench";
import { GitHubBundlePusher, GitHubChat, GitHubClient, GitHubCodeForge, GitHubPollingSource, parseWebhook } from "@openfactory/github";
import type { AgentHarness, MetricsSink, Signal } from "@openfactory/contracts";
import { FOREMAN_PROVIDER, proxyProvider } from "@openfactory/foreman";
import { openPostgresLedger } from "@openfactory/ledger";
import { DxFakeSink } from "@openfactory/metrics-dxfake";
import { factScorers } from "@openfactory/scoring";
import { TaskJobs } from "@openfactory/task-job";
import { fileEvidenceStore, createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { liteLlmModelKeys } from "./model-keys.js";
import { loadAgent, loadEnvironment, loadWorkspace } from "./plugins.js";

const log = (msg: string, fields: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...fields }));

async function main() {
  const cfg = loadConfig(process.env);
  const { ledger, close: closeDb } = await openPostgresLedger(cfg.DATABASE_URL);

  const gh = new GitHubClient({ token: () => cfg.GITHUB_TOKEN });
  const tokenLogin = await gh.whoami().catch(() => null);
  const botLogins = [...cfg.BOT_LOGINS.split(",").map((s) => s.trim()).filter(Boolean)];
  log("github identity", { login: tokenLogin, botLogins });

  const models = createModels();
  if (cfg.MODEL_PROXY_URL && cfg.MODEL_PROXY_KEY) {
    models.setProvider(
      proxyProvider({ baseUrl: cfg.MODEL_PROXY_URL, apiKey: cfg.MODEL_PROXY_KEY, modelId: cfg.FOREMAN_MODEL, cost: { input: cfg.FOREMAN_COST_IN, output: cfg.FOREMAN_COST_OUT } }),
    );
  } else {
    log("no model proxy configured: the foreman uses canned replies");
    const faux = fauxProvider({ provider: FOREMAN_PROVIDER, models: [{ id: cfg.FOREMAN_MODEL }] });
    faux.setResponses(Array.from({ length: 1000 }, () => fauxAssistantMessage("Noted. The worker is on it; I'll post here when the PR is ready.")));
    models.setProvider(faux.provider);
  }

  const pluginEnv = { ...process.env, WORKER_MODEL: cfg.WORKER_MODEL };
  const [agent, workspace, environment] = await Promise.all([
    loadAgent(cfg.AGENT_PLUGIN, pluginEnv),
    loadWorkspace(cfg.WORKSPACE_PLUGIN, pluginEnv),
    loadEnvironment(cfg.ENV_PLUGIN, pluginEnv),
  ]);
  const sinks: MetricsSink[] = cfg.DXFAKE_URL && cfg.DXFAKE_TOKEN ? [new DxFakeSink({ baseUrl: cfg.DXFAKE_URL, token: cfg.DXFAKE_TOKEN })] : [];
  const evidence = fileEvidenceStore(join(cfg.DATA_DIR, "evidence"), cfg.PUBLIC_URL);
  const chat = new GitHubChat(gh);
  const codeForge = new GitHubCodeForge(gh, { token: () => cfg.GITHUB_TOKEN });

  const jobs = new TaskJobs(
    {
      ledger,
      rules: { label: cfg.FACTORY_LABEL, botLogins, maxTaskUsd: cfg.MAX_TASK_USD, maxReviewRounds: cfg.MAX_REVIEW_ROUNDS },
      chat,
      codeForge,
      agent,
      workspace,
      environment,
      evidence,
      pusher: new GitHubBundlePusher({ token: () => cfg.GITHUB_TOKEN }),
      modelKeys:
        cfg.LITELLM_ADMIN_URL && cfg.LITELLM_MASTER_KEY
          ? liteLlmModelKeys({
              adminUrl: cfg.LITELLM_ADMIN_URL,
              masterKey: cfg.LITELLM_MASTER_KEY,
              maxBudgetUsd: cfg.MAX_TASK_USD,
              models: cfg.TASK_KEY_MODELS.split(",").map((m) => m.trim()),
              envNames: { key: "ANTHROPIC_API_KEY" },
            })
          : null,
      scorers: factScorers,
      sinks,
      config: { baseBranch: cfg.BASE_BRANCH, workerImage: cfg.WORKER_IMAGE ?? null, agentEnv: cfg.agentEnv, maxNudges: cfg.MAX_NUDGES, branchPrefix: "factory/" },
      log,
    },
    {
      dataDir: cfg.DATA_DIR,
      models,
      foremanModel: { provider: FOREMAN_PROVIDER, modelId: cfg.FOREMAN_MODEL },
      factoryVersion: () => cfg.FACTORY_VERSION,
      harnessInfo: { name: agent.name, model: agent.model },
    },
  );
  log("resumed tasks", { count: await jobs.resumeAll() });

  // One signal at a time: the job only records and schedules, so this stays quick.
  let chain: Promise<unknown> = Promise.resolve();
  const onSignal = (s: Signal) => {
    const next = chain.then(() => jobs.handle(s));
    chain = next.catch((e) => log("signal failed", { id: s.id, type: s.type, error: String(e) }));
    return next;
  };

  /** A harness for another model (benchmark arms), built on first use from the same plugin. */
  const agentFor = (model: string): AgentHarness => {
    let loaded: Promise<AgentHarness> | null = null;
    return {
      name: agent.name,
      model,
      openSession: async (input) => (await (loaded ??= loadAgent(cfg.AGENT_PLUGIN, { ...pluginEnv, WORKER_MODEL: model }))).openSession(input),
    };
  };

  const bench = cfg.BENCH_DIR
    ? createBenchRoutes({
        ledger,
        prs: new GitHubPullRequestSource(async () => cfg.GITHUB_TOKEN),
        store: new FileBenchStore(cfg.BENCH_DIR),
        captureOptions: cfg.BENCH_CHECK_JSON ? captureOptionsFrom(parseCheckSpec(cfg.BENCH_CHECK_JSON)) : defaultCaptureOptions,
        armFor: (spec) => ({
          label: spec.label,
          factoryVersion: spec.factoryVersion,
          harness: agentFor(spec.model),
          workspace,
          systemPrompt: spec.systemPrompt || "You are a careful software engineer. Do the task, with tests.",
          env: { ...cfg.agentEnv, ANTHROPIC_MODEL: spec.model },
        }),
        maxCostUsdPerRun: cfg.BENCH_MAX_USD_PER_RUN,
        now: () => new Date().toISOString(),
      })
    : null;

  const app = createApp({
    ledger,
    onSignal,
    evidence,
    apiToken: cfg.FACTORY_API_TOKEN,
    webhook: cfg.GITHUB_WEBHOOK_SECRET && cfg.SIGNALS !== "poll" ? (h, b) => parseWebhook(cfg.GITHUB_WEBHOOK_SECRET!, h, b) : null,
    bench,
    log,
  });
  const server = serve({ fetch: app.fetch, port: cfg.PORT }, (i) => log("listening", { port: i.port }));

  const poller =
    cfg.SIGNALS !== "webhook"
      ? await new GitHubPollingSource(gh, { repos: cfg.repos, intervalMs: cfg.POLL_INTERVAL_MS, lookbackMs: cfg.POLL_LOOKBACK_MS, log }).start(async (s) => {
          await onSignal(s);
        })
      : null;

  const shutdown = async () => {
    log("shutting down");
    await poller?.stop();
    server.close();
    await jobs.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
