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
import { teamFor, type RepoRef, type AgentHarness, type CodeForge, type Directory, type MetricsSink, type OutcomeSource, type Signal, type Team, type TaskId, type WorldCheck } from "@openfactory/contracts";
import { globToRegex } from "@openfactory/rules";
import { FOREMAN_INSTRUCTIONS, FOREMAN_PROVIDER, proxyProvider } from "@openfactory/foreman";
import { openPostgresLedger } from "@openfactory/ledger";
import { factScorers } from "@openfactory/scoring";
import { promptTemplates, scoreAndExport, TaskJobs, watchOutcomes, type JobDeps } from "@openfactory/task-job";
import { fileEvidenceStore, createApp } from "./app.js";
import { otlpFromEnv } from "@openfactory/telemetry-otlp";
import { loadConfig } from "./config.js";
import { Health } from "./health.js";
import { cachedDirectory, configDirectory, factoryViews, loadOrgConfig } from "./org.js";
import { loadFactoryExtras, loadModelRouting, loadOutcomeConfig, loadSelections, ProviderRegistry } from "./registry.js";

const log = (msg: string, fields: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...fields }));

async function main() {
  const cfg = loadConfig(process.env);
  const { ledger, app: store, close: closeDb } = await openPostgresLedger(cfg.DATABASE_URL);

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
  const modelRouting = loadModelRouting(pluginEnv, cfg.FACTORY_FILE);
  log("model routing", { routing: modelRouting });
  const extras = loadFactoryExtras(cfg.FACTORY_VERSION, cfg.FACTORY_FILE);
  log("rollout", { rollout: extras.rollout });
  const world = extras.world
    ? { check: await registry.buildOptional<WorldCheck>("worldCheck", { name: extras.world.provider, options: extras.world.options }), world: extras.world.name, simDays: extras.world.simDays }
    : null;
  log("world check", { world: world ? `${world.world} (${world.simDays} days)` : null });
  const workspace = need(p.workspace, "workspace");
  const environment = need(p.devEnvironment, "devEnvironment");
  const forge = need(p.codeForge, "codeForge");
  // The agent's per-task repo token comes from Secrets when configured (scoped to the task's repo), else the forge.
  const codeForge: CodeForge = {
    name: forge.name,
    openPullRequest: (i) => forge.openPullRequest(i),
    findPullRequestForBranch: (r, b) => forge.findPullRequestForBranch(r, b),
    // Optional forge features must pass through the wrapper, or PR size and the risk label silently go missing.
    ...(forge.pullRequestStats ? { pullRequestStats: (r: RepoRef, n: number) => forge.pullRequestStats!(r, n) } : {}),
    ...(forge.setPrefixedLabels ? { setPrefixedLabels: (r: RepoRef, n: number, p: string, l: string[]) => forge.setPrefixedLabels!(r, n, p, l) } : {}),
    mintPushToken: async (repo) => {
      if (!p.secrets) return forge.mintPushToken(repo);
      const s = await p.secrets.issue({ kind: "git", repo, access: "write" });
      return { token: s.value, expiresAt: s.expiresAt ?? new Date(Date.now() + 3600_000).toISOString() };
    },
  };
  const chat = need(p.chat, "chat");
  const sinks: MetricsSink[] = p.metrics ? [p.metrics] : [];
  // OpenTelemetry: each task as a trace, when OTEL_EXPORTER_OTLP_ENDPOINT is set (standard OTel env vars).
  const otlp = otlpFromEnv(process.env, (id) => ledger.events(id));
  if (otlp) sinks.push(otlp);
  const evidence = fileEvidenceStore(join(cfg.DATA_DIR, "evidence"), cfg.PUBLIC_URL);

  // Team factories (factory.yaml `factories:`): each may name its own world and merge-risk paths.
  const org = loadOrgConfig(cfg.FACTORY_FILE);
  const globs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(globToRegex) : []);
  const teamFactories = Object.fromEntries(
    Object.entries(org.factories).map(([slug, f]) => [
      slug,
      {
        ...(f.world !== undefined ? { world: f.world ? { world: f.world, simDays: extras.world?.simDays ?? 30 } : null } : {}),
        ...(f.mergeRisk
          ? { risk: { ...extras.risk, riskyPaths: [...extras.risk.riskyPaths, ...globs(f.mergeRisk.high)], safePaths: globs(f.mergeRisk.low) } }
          : {}),
      },
    ]),
  );
  const routedModels = [
    cfg.WORKER_MODEL,
    ...(modelRouting ? [modelRouting.default, ...modelRouting.routes.map((r) => r.model)] : []),
    ...Object.values(extras.versionModels ?? {}).flatMap((m) => [m.default, ...m.routes.map((r) => r.model)]),
  ];
  const health = new Health({
    forgeGet: (path) => gh.request("GET", path),
    repos: cfg.repos,
    gateway: cfg.MODEL_PROXY_URL && cfg.MODEL_PROXY_KEY ? { baseUrl: cfg.MODEL_PROXY_URL, key: cfg.MODEL_PROXY_KEY } : null,
    models: cfg.MODEL_PROXY_URL ? [...routedModels, cfg.FOREMAN_MODEL] : [],
    taskKeyModels: cfg.LITELLM_ADMIN_URL && cfg.LITELLM_MASTER_KEY ? cfg.TASK_KEY_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : null,
  });
  const healthRun = async () => {
    const checks = await health.run();
    const bad = checks.filter((c) => !c.ok);
    log(bad.length ? "start-up checks failing" : "start-up checks pass", { failing: bad.map((c) => `${c.name}: ${c.detail}`) });
  };
  await healthRun();
  const healthTimer = setInterval(() => void healthRun().catch(() => {}), 5 * 60_000);
  healthTimer.unref();

  const jobDeps: JobDeps = {
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
            spend: async (taskId: string) => (await p.modelGateway!.spend(taskId as TaskId))?.usd ?? null,
          }
        : null,
      scorers: factScorers,
      world,
      factories: teamFactories,
      sinks,
      preflight: (task) => health.forTask(task),
      config: { baseBranch: cfg.BASE_BRANCH, workerImage: cfg.WORKER_IMAGE ?? null, agentEnv: cfg.agentEnv, maxNudges: cfg.MAX_NUDGES, branchPrefix: "factory/", risk: extras.risk, versionPrompts: extras.versionPrompts },
      log,
  };
  const jobs = new TaskJobs(
    jobDeps,
    {
      dataDir: cfg.DATA_DIR,
      models,
      foremanModel: { provider: FOREMAN_PROVIDER, modelId: cfg.FOREMAN_MODEL },
      factoryVersion: () => cfg.FACTORY_VERSION,
      harnessInfo: { name: agent.name, model: agent.model },
      modelRouting,
      // The app's rollout (Factories > Versions) overrides factory.yaml's, read per new task.
      rollout: async (factory: string) => {
        const r = await store.rollout(factory).catch(() => null);
        if (!r) return extras.rollout;
        return { stable: r.state.live ?? cfg.FACTORY_VERSION, candidate: r.state.candidate, share: r.state.share };
      },
      versionModels: extras.versionModels,
      knownRepos: cfg.repos,
      factoryOf: async (t) => {
        const team = teamFor(await directory.teams(), t);
        return { factory: team?.factory ?? "default", team: team?.slug ?? null };
      },
    },
  );
  log("resumed tasks", { count: await jobs.resumeAll() });

  // Late outcomes: reverts, follow-up fixes, incidents and deploys for tasks merged in the last windowDays.
  const outcomeCfg = loadOutcomeConfig(pluginEnv, cfg.FACTORY_FILE);
  const outcomeSources: OutcomeSource[] = [];
  for (const sel of outcomeCfg?.sources ?? []) {
    try {
      outcomeSources.push(await registry.build("outcomes", sel));
      log("outcome source", { provider: sel.name });
    } catch (e) {
      log("outcome source unavailable", { provider: sel.name, error: String(e) });
    }
  }
  const outcomeWatch =
    outcomeCfg && outcomeSources.length > 0
      ? watchOutcomes(
          { ledger, sources: outcomeSources, rescore: (id) => scoreAndExport(jobDeps, id), log },
          { windowDays: outcomeCfg.windowDays, intervalMs: outcomeCfg.intervalMs },
        )
      : null;

  // One signal at a time: the job only records and schedules, so this stays quick.
  let chain: Promise<unknown> = Promise.resolve();
  const onSignal = (s: Signal) => {
    const next = chain.then(() => jobs.handle(s));
    chain = next.catch((e) => log("signal failed", { id: s.id, type: s.type, error: String(e) }));
    return next;
  };

  // Retries share the signal queue too, for the same reason.
  const onRetry = (id: TaskId, by: string) => {
    const next = chain.then(() => jobs.retry(id, by));
    chain = next.catch((e) => log("retry failed", { id, error: String(e) }));
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
          environment, // world checks deploy each attempt into its own fresh environment
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
    modelRouting,
    rollout: extras.rollout,
    rules: { label: cfg.FACTORY_LABEL, maxTaskUsd: cfg.MAX_TASK_USD, maxReviewRounds: cfg.MAX_REVIEW_ROUNDS, maxNudges: cfg.MAX_NUDGES },
    prompts: { ...promptTemplates(cfg.BASE_BRANCH), foreman: FOREMAN_INSTRUCTIONS },
  });

  // Teams: factory.yaml `teams:` (a list, or a directory provider such as GitHub org teams). Without either,
  // one team holds the factory's repos and everyone who has asked for a task.
  let directory: Directory;
  if (org.teams) directory = configDirectory(org.teams);
  else if (org.directory) directory = cachedDirectory(await registry.build("directory", org.directory));
  else
    directory = cachedDirectory(
      {
        name: "inferred",
        teams: async (): Promise<Team[]> => {
          const tasks = await ledger.listTasks({ limit: 1000 });
          const people = [...new Set(tasks.map((t) => t.requestedBy).filter((x): x is string => typeof x === "string" && !botLogins.includes(x)))].sort();
          return [{ slug: "everyone", name: "Everyone", source: "inferred", members: people.map((login) => ({ login, name: null, role: "member" as const })), repos: cfg.repos.map((r) => `${r.owner}/${r.name}`), factory: "default" }];
        },
      },
      60_000,
    );
  log("teams from", { directory: directory.name });

  /** A person writes to a task from the app: post it where the task lives, record it, and hand it to the job as a comment. */
  const message = async (id: TaskId, author: string, text: string) => {
    const t = await ledger.getTask(id);
    if (!t) return null;
    const target = t.pr?.number ?? t.source.issueNumber;
    let url: string | null = null;
    if (target !== null) url = (await chat.post({ repo: t.source.repo, issueOrPr: target }, `**@${author}** wrote in the factory app:\n\n${text}`)).url;
    const at = new Date().toISOString();
    const mid = `app:${id}:${Date.now().toString(36)}`;
    await ledger.append(id, "message_received", { author, text, url }, { dedupeKey: `msg:${mid}` });
    if (target !== null) await onSignal({ type: "issue_comment", id: mid, repo: t.source.repo, at, actor: { login: author, isBot: false }, issueNumber: target, body: text });
    return { task: (await ledger.getTask(id))!, url };
  };

  /** A person asks for a task in the app: open a labelled issue where the work belongs, then start it. */
  const ask = async (input: { ask: string; repo: string | null; requestedBy: string }) => {
    const known = cfg.repos.map((r) => `${r.owner}/${r.name}`);
    const teamRepo = (await directory.teams()).find((t) => t.members.some((m) => m.login === input.requestedBy))?.repos.find((r) => known.includes(r));
    const repoName = input.repo ?? teamRepo ?? known[0];
    if (!repoName || !known.includes(repoName)) throw new Error(`The factory doesn't work in ${repoName ?? "any repo"} yet. Add it to FACTORY_REPOS.`);
    const [owner, name] = repoName.split("/") as [string, string];
    const repo = { host: "github" as const, owner, name };
    const title = input.ask.split("\n")[0]!.trim().slice(0, 120) || "Task from the factory app";
    const body = `${input.ask}\n\n_Asked by @${input.requestedBy} in the factory app._`;
    const issue = await gh.request<{ number: number; html_url: string }>("POST", `/repos/${owner}/${name}/issues`, { title, body, labels: [cfg.FACTORY_LABEL] });
    await onSignal({ type: "issue_labeled", id: `app-new:${repoName}#${issue.number}`, repo, at: new Date().toISOString(), actor: { login: input.requestedBy, isBot: false }, issueNumber: issue.number, label: cfg.FACTORY_LABEL, title, body, labels: [cfg.FACTORY_LABEL] });
    return { issueUrl: issue.html_url, repo: repoName, issueNumber: issue.number };
  };

  const app = createApp({
    ledger,
    store,
    ask,
    teams: () => directory.teams(),
    factories: async () => factoryViews(org.factories, await directory.teams()),
    message,
    factory: factoryInfo,
    cancel: (id, by, reason) => onCancel(id, by, reason),
    retry: (id, by) => onRetry(id, by),
    health: () => health.current(),
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
    clearInterval(healthTimer);
    await poller?.stop();
    await outcomeWatch?.stop();
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
