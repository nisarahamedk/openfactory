/**
 * The factory server: one process that takes signals, runs task jobs, and
 * serves the API, evidence and benchmarks. Providers come from factory.yaml
 * (FACTORY_FILE), with env vars as the fallback.
 */
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { captureOptionsFrom, createBenchRoutes, defaultCaptureOptions, FileBenchStore, GitHubPullRequestSource, parseCheckSpec } from "@openfactory/bench";
import { GitHubClient, parseWebhook } from "@openfactory/github";
import type { AgentHarness, CodeForge, MetricsSink, Signal, TaskId } from "@openfactory/contracts";
import { FOREMAN_INSTRUCTIONS, FOREMAN_PROVIDER, proxyProvider } from "@openfactory/foreman";
import { openPostgresLedger } from "@openfactory/ledger";
import { factScorers } from "@openfactory/scoring";
import { promptTemplates, TaskJobs } from "@openfactory/task-job";
import { fileEvidenceStore, createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadSelections, ProviderRegistry } from "./registry.js";

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
  const registry = new ProviderRegistry(pluginEnv, log);
  const { selections, source } = loadSelections(pluginEnv, cfg.FACTORY_FILE);
  log("providers from", { source });
  const p = await registry.buildAll(selections);
  const need = <T>(v: T | undefined, key: string): T => {
    if (!v) throw new Error(`no provider configured for ${key}`);
    return v;
  };
  const agent = need(p.agent, "agent");
  const workspace = need(p.workspace, "workspace");
  const environment = need(p.devEnvironment, "devEnvironment");
  const forge = need(p.codeForge, "codeForge");
  // The agent's per-task repo token comes from Secrets when configured (scoped to the task's repo), else the forge.
  const codeForge: CodeForge = {
    name: forge.name,
    openPullRequest: (i) => forge.openPullRequest(i),
    findPullRequestForBranch: (r, b) => forge.findPullRequestForBranch(r, b),
    mintPushToken: async (repo) => {
      if (!p.secrets) return forge.mintPushToken(repo);
      const s = await p.secrets.issue({ kind: "git", repo, access: "write" });
      return { token: s.value, expiresAt: s.expiresAt ?? new Date(Date.now() + 3600_000).toISOString() };
    },
  };
  const chat = need(p.chat, "chat");
  const sinks: MetricsSink[] = p.metrics ? [p.metrics] : [];
  const evidence = fileEvidenceStore(join(cfg.DATA_DIR, "evidence"), cfg.PUBLIC_URL);

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
      modelKeys: p.modelGateway
        ? {
            forTask: (taskId: string) => p.modelGateway!.forTask(taskId as TaskId, { usd: cfg.MAX_TASK_USD }),
            revoke: (taskId: string) => p.modelGateway!.revoke(taskId as TaskId),
          }
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

  // Cancels share the signal queue, so a cancel never races a signal for the same task.
  const onCancel = (id: TaskId, by: string, reason?: string) => {
    const next = chain.then(() => jobs.cancel(id, by, reason));
    chain = next.catch((e) => log("cancel failed", { id, error: String(e) }));
    return next;
  };

  /** A harness for another model (benchmark arms), built on first use from the same plugin. */
  const agentFor = (model: string): AgentHarness => {
    let loaded: Promise<AgentHarness> | null = null;
    return {
      name: agent.name,
      model,
      openSession: async (input) => (await (loaded ??= registry.build("agent", selections.agent!, { WORKER_MODEL: model }))).openSession(input),
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

  /** Option names that may hold a secret are never shown, even though factory.yaml should only hold env var names. */
  const SECRETISH = /token|secret|password|passwd|credential|apikey|api_key|(^|[^a-z])key$/i;
  const redact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRETISH.test(k) ? "[redacted]" : v]));
  const factoryInfo = async () => ({
    version: cfg.FACTORY_VERSION,
    providersFrom: source,
    providers: Object.fromEntries(Object.entries(selections).map(([k, s]) => [k, { name: s!.name, options: redact(s!.options) }])),
    agent: { name: agent.name, model: agent.model },
    foreman: { model: cfg.FOREMAN_MODEL },
    rules: { label: cfg.FACTORY_LABEL, maxTaskUsd: cfg.MAX_TASK_USD, maxReviewRounds: cfg.MAX_REVIEW_ROUNDS, maxNudges: cfg.MAX_NUDGES },
    prompts: { ...promptTemplates(cfg.BASE_BRANCH), foreman: FOREMAN_INSTRUCTIONS },
  });

  const app = createApp({
    ledger,
    factory: factoryInfo,
    cancel: (id, by, reason) => onCancel(id, by, reason),
    onSignal,
    evidence,
    apiToken: cfg.FACTORY_API_TOKEN,
    webhook: cfg.GITHUB_WEBHOOK_SECRET && cfg.SIGNALS !== "poll" ? (h, b) => parseWebhook(cfg.GITHUB_WEBHOOK_SECRET!, h, b) : null,
    bench,
    publicUrl: cfg.PUBLIC_URL,
    log,
  });
  const server = serve({ fetch: app.fetch, port: cfg.PORT }, (i) => log("listening", { port: i.port }));

  const poller = p.signals
    ? await p.signals.start(async (s) => {
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
