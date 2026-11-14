import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentHarness, Environment, LedgerReader, TaskRecord, Workspace, WorkspaceHandle } from "@openfactory/contracts";
import { captureBenchmarkTask, compareArms, createBenchRoutes, defaultCaptureOptions, FileBenchStore, runAB, runAttempt, type ArmResult, type PullRequestSource } from "./index.js";

// A tiny repo: add.js is broken at the start commit; the "merged PR" fixed it and added a test.
function makeOrigin(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "bench-origin-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "add.js"), "module.exports = (a, b) => a - b;\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return { dir, base: git("rev-parse", "HEAD") };
}
const HIDDEN_TEST = "const add = require('../add.js'); if (add(2, 3) !== 5) { console.error('add broken'); process.exit(1); }\n";

/** Workspace double: a local clone in a temp dir; exec runs real processes. */
function localWorkspace(origin: string): Workspace & { live: number } {
  const ws = {
    name: "local",
    live: 0,
    async create(): Promise<WorkspaceHandle> {
      const root = mkdtempSync(join(tmpdir(), "bench-ws-"));
      const repoPath = join(root, "repo");
      cpSync(origin, repoPath, { recursive: true });
      ws.live++;
      return {
        id: root,
        repoPath,
        async exec(cmd, opts) {
          const [bin = "", ...args] = cmd;
          const r = spawnSync(bin, args, { cwd: opts?.cwd ?? repoPath, encoding: "utf8", env: { ...process.env, ...opts?.env } });
          return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
        },
        async spawn() {
          throw new Error("not needed");
        },
        async writeFile(path, content) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content);
        },
        async sleep() {},
        async wake() {},
        async destroy() {
          rmSync(root, { recursive: true, force: true });
          ws.live--;
        },
      };
    },
    async get() {
      return null;
    },
  };
  return ws;
}

/** Harness double: "good" fixes add.js, "lazy" does nothing. Each turn costs a fixed amount. */
function harness(kind: "good" | "lazy", cost: number): AgentHarness {
  return {
    name: "mock",
    model: kind,
    async openSession({ cwd }) {
      return {
        sessionId: "s",
        async prompt() {
          if (kind === "good") writeFileSync(join(cwd, "add.js"), "module.exports = (a, b) => a + b;\n");
          return { stopReason: "end_turn", summary: "done", usage: { inputTokens: 10, outputTokens: 5, costUsd: cost } };
        },
        async cancel() {},
        async close() {},
      };
    },
  };
}

function mergedRecord(): TaskRecord {
  return {
    id: "task_abc",
    factoryVersion: "fv_1",
    source: { kind: "github_issue", repo: { host: "github", owner: "acme", name: "app" }, issueNumber: 4, url: null },
    title: "Fix add",
    ask: "add() subtracts; make it add.",
    status: "merged",
    harness: { name: "claude-code", model: "sonnet" },
    harnessSessionId: null,
    environment: null,
    workspace: null,
    branch: null,
    pr: { number: 9, url: "u", headSha: "h" },
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    people: { comments: 0, reviewRounds: 0 },
    evidence: [],
    scores: [],
    outcomes: [],
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
  };
}

function ledgerWith(r: TaskRecord): LedgerReader {
  return { getTask: async (id) => (id === r.id ? r : null), listTasks: async () => [r], events: async () => [] };
}

function prSource(base: string): PullRequestSource {
  return {
    mergedPullRequest: async () => ({
      baseSha: base,
      mergeSha: "m",
      files: [
        { path: "add.js", status: "modified", contentAtMerge: "module.exports = (a, b) => a + b;\n" },
        { path: "tests/add.test.js", status: "added", contentAtMerge: HIDDEN_TEST },
      ],
    }),
  };
}

const options = { ...defaultCaptureOptions, checkCommand: (files: string[]) => ["node", ...files] };

describe("add to benchmark", () => {
  it("captures only test files as the hidden check and writes a Harbor folder", async () => {
    const { base } = makeOrigin();
    const task = await captureBenchmarkTask("task_abc", { ledger: ledgerWith(mergedRecord()), prs: prSource(base), options, now: "2026-11-13T02:00:00Z" });
    expect(task.startCommit).toBe(base);
    expect(Object.keys(task.check.files)).toEqual(["tests/add.test.js"]);
    expect(task.check.command).toEqual(["node", "tests/add.test.js"]);

    const root = mkdtempSync(join(tmpdir(), "bench-store-"));
    const files = await new FileBenchStore(root).saveTask(task);
    expect(files).toContain("task.toml");
    expect(files).toContain("tests/hidden/tests/add.test.js");
    const toml = readFileSync(join(root, "tasks", task.id, "task.toml"), "utf8");
    expect(toml).toMatch(/^schema_version = "1.4"/);
    expect(toml).toContain(`start_commit = "${base}"`);
    expect(readFileSync(join(root, "tasks", task.id, "tests/test.sh"), "utf8")).toContain("/logs/verifier/reward.txt");
    expect(await new FileBenchStore(root).getTask(task.id)).toEqual(task);
  });

  it("refuses tasks that weren't merged", async () => {
    const r = { ...mergedRecord(), status: "awaiting_review" as const };
    await expect(captureBenchmarkTask("task_abc", { ledger: ledgerWith(r), prs: prSource("x"), options, now: "n" })).rejects.toMatchObject({ code: "TASK_NOT_MERGED" });
  });
});

describe("A vs B replay", () => {
  it("runs both arms through the worker contracts, judges with the hidden test and cleans up", async () => {
    const { dir, base } = makeOrigin();
    const task = await captureBenchmarkTask("task_abc", { ledger: ledgerWith(mergedRecord()), prs: prSource(base), options, now: "n" });
    const ws = localWorkspace(dir);
    const results: ArmResult[] = [];
    const out = await runAB(
      {
        tasks: [task],
        arms: [
          { label: "A", factoryVersion: "fv_lazy", harness: harness("lazy", 0.1), workspace: ws, systemPrompt: "", env: {} },
          { label: "B", factoryVersion: "fv_good", harness: harness("good", 0.3), workspace: ws, systemPrompt: "", env: {} },
        ],
        repeats: 4,
        maxCostUsd: 100,
        checkTimeoutMs: 10_000,
      },
      async (r, arm) => void results.push({ ...r, arm }),
    );
    expect(out.stoppedForBudget).toBe(false);
    expect(ws.live).toBe(0);
    expect(results.filter((r) => r.arm === "A").every((r) => !r.passed)).toBe(true);
    expect(results.filter((r) => r.arm === "B").every((r) => r.passed)).toBe(true);
    const report = compareArms(results, "A", "B");
    expect(report.verdict).toBe("b_better");
    expect(report.passRateDiff.estimate).toBe(1);
    expect(report.costDiffUsd).toBeCloseTo(0.2);
    expect(report.flips).toHaveLength(1);
  });

  it("stops scheduling at the budget", async () => {
    const { dir, base } = makeOrigin();
    const task = await captureBenchmarkTask("task_abc", { ledger: ledgerWith(mergedRecord()), prs: prSource(base), options, now: "n" });
    const ws = localWorkspace(dir);
    const arm = (l: string) => ({ label: l, factoryVersion: l, harness: harness("good", 1), workspace: ws, systemPrompt: "", env: {} });
    let n = 0;
    const out = await runAB({ tasks: [task], arms: [arm("A"), arm("B")], repeats: 10, maxCostUsd: 3, checkTimeoutMs: 10_000 }, async () => void n++);
    expect(out.stoppedForBudget).toBe(true);
    expect(n).toBe(4);
  });

  it("noise: identical arms are reported as too close to call", () => {
    const mk = (arm: string, passed: boolean, i: number): ArmResult => ({
      arm, benchmarkTaskId: `b${i % 3}`, factoryVersion: arm, attempt: i, passed, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, durationMs: 1, notes: "",
    });
    const rs = [...Array(12).keys()].flatMap((i) => [mk("A", i % 2 === 0, i), mk("B", i % 3 !== 0, i)]);
    expect(compareArms(rs, "A", "B").verdict).toBe("too_close");
  });
});

describe("bench API", () => {
  it("add-to-benchmark → start run → report, end to end over HTTP", async () => {
    const { dir, base } = makeOrigin();
    const root = mkdtempSync(join(tmpdir(), "bench-api-"));
    const ws = localWorkspace(dir);
    const app = createBenchRoutes({
      ledger: ledgerWith(mergedRecord()),
      prs: prSource(base),
      store: new FileBenchStore(root),
      captureOptions: options,
      armFor: (s) => ({ label: s.label, factoryVersion: s.factoryVersion, harness: harness(s.model === "good" ? "good" : "lazy", 0.1), workspace: ws, systemPrompt: s.systemPrompt, env: {} }),
      maxCostUsdPerRun: 5,
      now: () => new Date().toISOString(),
    });
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

    expect((await post("/tasks/task_nope/benchmark", {})).status).toBe(404);
    const cap = await post("/tasks/task_abc/benchmark", {});
    expect(cap.status).toBe(201);
    const benchId = ((await cap.json()) as { task: { id: string } }).task.id;

    const start = await post("/bench/runs", {
      taskIds: [benchId],
      arms: [{ label: "A", factoryVersion: "fv_1", model: "lazy" }, { label: "B", factoryVersion: "fv_2", model: "good" }],
      repeats: 2,
      maxCostUsd: 50,
    });
    expect(start.status).toBe(202);
    const { run } = (await start.json()) as { run: { id: string; maxCostUsd: number } };
    expect(run.maxCostUsd).toBe(5);

    let final: { status: string; report: { verdict: string } | null } | null = null;
    for (let i = 0; i < 100 && final?.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      final = ((await (await app.request(`/bench/runs/${run.id}`)).json()) as { run: typeof final }).run;
    }
    expect(final?.status).toBe("done");
    expect(final?.report?.verdict).toBeDefined();
    expect(existsSync(join(root, "runs", `${run.id}.json`))).toBe(true);
  });
});

describe("check spec", () => {
  it("delete-others keeps only the hidden tests, then runs the repo's own runner", async () => {
    const { captureOptionsFrom, parseCheckSpec } = await import("./index.js");
    const dir = mkdtempSync(join(tmpdir(), "bench-spec-"));
    mkdirSync(join(dir, "tests/e2e"), { recursive: true });
    for (const f of ["a.test.ts", "b.test.ts", "c.test.ts"]) writeFileSync(join(dir, "tests", f), "");
    writeFileSync(join(dir, "tests/e2e/x.spec.ts"), "");
    const opts = captureOptionsFrom(
      parseCheckSpec(JSON.stringify({ testFilePattern: "^tests/[^/]+\\.test\\.ts$", run: ["ls", "tests"], filter: "delete-others" })),
    );
    expect(opts.isTestFile("tests/a.test.ts")).toBe(true);
    expect(opts.isTestFile("tests/e2e/x.spec.ts")).toBe(false);
    const [bin = "", ...args] = opts.checkCommand(["tests/a.test.ts", "tests/c.test.ts"]);
    const r = spawnSync(bin, args, { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual(["a.test.ts", "c.test.ts", "e2e"]);
  });
});

describe("world check", () => {
  const WORLD_TEST = "const add = require(process.env.FACTORY_ENV_URL + '/deployed.js'); if (add(2, 3) !== 5) { console.error('deployed add broken'); process.exit(1); }\n";
  const worldPrs = (base: string): PullRequestSource => ({
    mergedPullRequest: async () => ({
      baseSha: base,
      mergeSha: "m",
      files: [
        { path: "add.js", status: "modified", contentAtMerge: "module.exports = (a, b) => a + b;\n" },
        { path: "tests/add.test.js", status: "added", contentAtMerge: HIDDEN_TEST },
        { path: "tests/e2e/add.spec.js", status: "added", contentAtMerge: WORLD_TEST },
      ],
    }),
  });

  /** Environment double: a temp dir stands for the running product; "deploy" copies add.js into it. */
  function fakeEnvironment(deploy: string): Environment & { live: number; created: number } {
    const env = {
      name: "fake",
      live: 0,
      created: 0,
      async create() {
        const dir = mkdtempSync(join(tmpdir(), "bench-world-"));
        env.live++;
        env.created++;
        return {
          name: dir,
          credentialsForWorkspace: async () => [{ path: join(dir, "kubeconfig"), content: "fake" }],
          envVars: async () => ({ FACTORY_ENV_URL: dir, FACTORY_ENV_DEPLOY: deploy.replaceAll("{dir}", dir) }),
          skill: async () => "ENV SKILL: deploy with $FACTORY_ENV_DEPLOY",
          sleep: async () => {},
          wake: async () => {},
          destroy: async () => {
            rmSync(dir, { recursive: true, force: true });
            env.live--;
          },
        };
      },
      get: async () => null,
    };
    return env;
  }

  it("a PR that only changed e2e tests (a UI task) becomes a world-only benchmark", async () => {
    const { captureOptionsFrom, parseCheckSpec } = await import("./index.js");
    const { base } = makeOrigin();
    const prs: PullRequestSource = {
      mergedPullRequest: async () => ({
        baseSha: base,
        mergeSha: "m",
        files: [
          { path: "add.js", status: "modified", contentAtMerge: "module.exports = (a, b) => a + b;\n" },
          { path: "tests/e2e/add.spec.js", status: "added", contentAtMerge: WORLD_TEST },
        ],
      }),
    };
    const spec = parseCheckSpec(
      JSON.stringify({ testFilePattern: "^tests/.+\\.test\\.js$", run: ["node"], filter: "append-files", world: { testFilePattern: "^tests/e2e/", run: "node" } }),
    );
    const task = await captureBenchmarkTask("task_abc", { ledger: ledgerWith(mergedRecord()), prs, options: captureOptionsFrom(spec), now: "n" });
    expect(task.check.command).toEqual(["true"]);
    expect(Object.keys(task.check.world?.files ?? {})).toEqual(["tests/e2e/add.spec.js"]);
  });

  it("capture keeps world tests out of the repo check; replay deploys and runs them in a fresh env", async () => {
    const { captureOptionsFrom, parseCheckSpec } = await import("./index.js");
    const spec = parseCheckSpec(
      JSON.stringify({ testFilePattern: "^tests/.+\\.(test|spec)\\.js$", run: ["node"], filter: "append-files", world: { testFilePattern: "^tests/e2e/", run: "node" } }),
    );
    const { dir, base } = makeOrigin();
    const task = await captureBenchmarkTask("task_abc", { ledger: ledgerWith(mergedRecord()), prs: worldPrs(base), options: captureOptionsFrom(spec), now: "n" });
    expect(Object.keys(task.check.files)).toEqual(["tests/add.test.js"]);
    expect(Object.keys(task.check.world?.files ?? {})).toEqual(["tests/e2e/add.spec.js"]);

    const ws = localWorkspace(dir);
    const good = fakeEnvironment('cp add.js "{dir}/deployed.js"');
    const broken = fakeEnvironment("echo deploy failed >&2; exit 3");
    const prompts: string[] = [];
    const seeing = (h: AgentHarness): AgentHarness => ({ ...h, openSession: async (i) => (prompts.push(i.systemPrompt), h.openSession(i)) });
    const arm = (label: string, environment: Environment | null) => ({ label, factoryVersion: label, harness: seeing(harness("good", 0.1)), workspace: ws, systemPrompt: "", env: {}, environment });

    const ok = await runAttempt(task, arm("A", good), 1, { checkTimeoutMs: 10_000 });
    expect(ok.checks).toEqual({ repo: true, world: true });
    expect(ok.passed).toBe(true);
    expect(prompts[0]).toContain("ENV SKILL");

    const bad = await runAttempt(task, arm("B", broken), 1, { checkTimeoutMs: 10_000 });
    expect(bad.checks).toEqual({ repo: true, world: false });
    expect(bad.passed).toBe(false);
    expect(bad.notes).toContain("deploy failed");

    const none = await runAttempt(task, arm("C", null), 1, { checkTimeoutMs: 10_000 });
    expect(none.checks).toEqual({ repo: true, world: null });
    expect(none.passed).toBe(true);
    expect(none.notes).toContain("world check skipped");

    expect([good.live, broken.live, ws.live]).toEqual([0, 0, 0]);
    expect(good.created + broken.created).toBe(2);
  });

  it("a lazy agent fails the world check too, since the deployed code is the agent's", async () => {
    const { captureOptionsFrom, parseCheckSpec } = await import("./index.js");
    const spec = parseCheckSpec(JSON.stringify({ testFilePattern: "^tests/[^/]+\\.test\\.js$", run: ["node"], filter: "append-files", world: { testFilePattern: "^tests/e2e/", run: "node" } }));
    const { dir, base } = makeOrigin();
    const task = await captureBenchmarkTask("task_abc", { ledger: ledgerWith(mergedRecord()), prs: worldPrs(base), options: captureOptionsFrom(spec), now: "n" });
    const r = await runAttempt(task, { label: "L", factoryVersion: "L", harness: harness("lazy", 0), workspace: localWorkspace(dir), systemPrompt: "", env: {}, environment: fakeEnvironment('cp add.js "{dir}/deployed.js"') }, 1, { checkTimeoutMs: 10_000 });
    expect(r.checks).toEqual({ repo: false, world: false });
  });
});

describe("cost and pass together", () => {
  const mk = (arm: string, passed: boolean, cost: number, i: number): ArmResult => ({
    arm, benchmarkTaskId: `b${i % 3}`, factoryVersion: arm, attempt: i, passed, usage: { inputTokens: 0, outputTokens: 0, costUsd: cost }, durationMs: 1, notes: "",
  });
  it("same pass rate, B clearly dearer: A is better", () => {
    const rs = [...Array(9).keys()].flatMap((i) => [mk("A", true, 0.25 + (i % 3) * 0.01, i), mk("B", true, 0.37 + (i % 3) * 0.01, i)]);
    const r = compareArms(rs, "A", "B");
    expect(r.verdict).toBe("a_better");
    expect(r.costRatio!.low).toBeGreaterThan(1.1);
    expect(r.summary).toMatch(/costs less/);
  });
  it("B passes more but each pass costs more: a trade-off", () => {
    const rs = [...Array(12).keys()].flatMap((i) => [mk("A", i % 2 === 0, 0.1, i), mk("B", true, 0.5, i)]);
    expect(compareArms(rs, "A", "B").verdict).toBe("trade_off");
  });
});
