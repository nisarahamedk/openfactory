import { z } from "zod";
import type { BenchmarkTask, LedgerReader, RepoRef, TaskId } from "@openfactory/contracts";

/** What benchmark capture needs to know about a merged pull request. */
export interface MergedPullRequest {
  /** Commit the PR branched from: the replay starts here. */
  baseSha: string;
  mergeSha: string;
  /** Files the PR changed, with their content at the merge commit (null when deleted). */
  files: Array<{ path: string; status: string; contentAtMerge: string | null }>;
}

/** Reads merged PRs from the code host. A port, so tests and other hosts can swap it. */
export interface PullRequestSource {
  mergedPullRequest(repo: RepoRef, number: number): Promise<MergedPullRequest>;
}

/** An expected capture failure, with a code the API translates to a status. */
export class CaptureError extends Error {
  constructor(
    readonly code: "TASK_NOT_FOUND" | "TASK_NOT_MERGED" | "NO_CHECK",
    message: string,
  ) {
    super(message);
  }
}

export interface CaptureOptions {
  /** Which changed files are the hidden check. Default: *.test.*, *.spec.*, e2e/, tests/, __tests__/. */
  isTestFile: (path: string) => boolean;
  /** Command that runs the hidden test files inside the workspace. Exit code 0 = pass. */
  checkCommand: (testFiles: string[]) => string[];
  /** Used when the PR changed no test files. Null makes such tasks uncapturable. */
  fallbackCheckCommand: string[] | null;
  /**
   * World check: which changed files are tests that need the running product (e.g. e2e),
   * and the command that deploys the attempt and runs them. Those files are kept out of
   * the repo check. Undefined or null: no world check.
   */
  world?: { isTestFile: (path: string) => boolean; command: (testFiles: string[]) => string[] } | null;
}

const TEST_FILE = /(^|\/)(e2e|tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Defaults: vitest/playwright-style test file names, run with `pnpm exec vitest run <files>`. */
export const defaultCaptureOptions: CaptureOptions = {
  isTestFile: (p) => TEST_FILE.test(p),
  checkCommand: (files) => ["pnpm", "exec", "vitest", "run", ...files],
  fallbackCheckCommand: null,
};

/** Stable benchmark id derived from the source task, so capturing twice is idempotent. */
export function benchmarkIdFor(taskId: TaskId): string {
  return `bench_${taskId.replace(/^task_/, "")}`;
}

/**
 * "Add to benchmark": turn a merged task into a replayable benchmark task.
 * Start point = the PR's base commit. Hidden check = the test files from the merged
 * PR, run against whatever the replaying agent wrote.
 */
export async function captureBenchmarkTask(
  taskId: TaskId,
  deps: { ledger: LedgerReader; prs: PullRequestSource; options: CaptureOptions; now: string },
): Promise<BenchmarkTask> {
  const record = await deps.ledger.getTask(taskId);
  if (record === null) throw new CaptureError("TASK_NOT_FOUND", `task ${taskId} not found`);
  if (record.status !== "merged" || record.pr === null)
    throw new CaptureError("TASK_NOT_MERGED", `task ${taskId} is ${record.status}; only merged tasks can become benchmarks`);

  const pr = await deps.prs.mergedPullRequest(record.source.repo, record.pr.number);
  const present = pr.files.filter((f) => f.contentAtMerge !== null);
  const worldOpt = deps.options.world ?? null;
  const worldTests = worldOpt === null ? [] : present.filter((f) => worldOpt.isTestFile(f.path));
  const tests = present.filter((f) => deps.options.isTestFile(f.path) && !worldTests.includes(f));
  const files = Object.fromEntries(tests.map((f) => [f.path, f.contentAtMerge ?? ""]));
  const world =
    worldOpt !== null && worldTests.length > 0
      ? { command: worldOpt.command(worldTests.map((t) => t.path)), files: Object.fromEntries(worldTests.map((f) => [f.path, f.contentAtMerge ?? ""])) }
      : null;

  let check: BenchmarkTask["check"];
  if (tests.length > 0) {
    check = { kind: "tests_from_merged_pr", command: deps.options.checkCommand(tests.map((t) => t.path)), files, world };
  } else if (deps.options.fallbackCheckCommand !== null) {
    check = { kind: "command", command: deps.options.fallbackCheckCommand, files: {}, world };
  } else {
    throw new CaptureError("NO_CHECK", `PR #${record.pr.number} changed no test files and no fallback check command is set`);
  }

  return {
    id: benchmarkIdFor(taskId),
    sourceTaskId: taskId,
    repo: record.source.repo,
    startCommit: pr.baseSha,
    ask: `${record.title}\n\n${record.ask}`.trim(),
    check,
    createdAt: deps.now,
  };
}

// ─────────────────────────── GitHub implementation ───────────────────────────

const GhPull = z.object({
  merged: z.boolean(),
  merge_commit_sha: z.string().nullable(),
  base: z.object({ sha: z.string() }),
});
const GhFiles = z.array(z.object({ filename: z.string(), status: z.string() }));

/** PullRequestSource over the GitHub REST API with a token that can read the repo. */
export class GitHubPullRequestSource implements PullRequestSource {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  private async get(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: { authorization: `Bearer ${await this.token()}`, accept, "x-github-api-version": "2022-11-28", "user-agent": "openfactory-bench" },
    });
    if (!res.ok) throw new Error(`GitHub GET ${path} failed with ${res.status}`);
    return res;
  }

  async mergedPullRequest(repo: RepoRef, number: number): Promise<MergedPullRequest> {
    const base = `/repos/${repo.owner}/${repo.name}`;
    const pull = GhPull.parse(await (await this.get(`${base}/pulls/${number}`)).json());
    if (!pull.merged || pull.merge_commit_sha === null) throw new CaptureError("TASK_NOT_MERGED", `PR #${number} is not merged`);
    const mergeSha = pull.merge_commit_sha;
    const listed: Array<{ filename: string; status: string }> = [];
    for (let page = 1; page <= 30; page++) {
      const batch = GhFiles.parse(await (await this.get(`${base}/pulls/${number}/files?per_page=100&page=${page}`)).json());
      listed.push(...batch);
      if (batch.length < 100) break;
    }
    const files = await Promise.all(
      listed.map(async (f) => ({
        path: f.filename,
        status: f.status,
        contentAtMerge:
          f.status === "removed"
            ? null
            : await (await this.get(`${base}/contents/${encodeURI(f.filename)}?ref=${mergeSha}`, "application/vnd.github.raw")).text(),
      })),
    );
    return { baseSha: pull.base.sha, mergeSha, files };
  }
}

// ─────────────────────────── configurable check ───────────────────────────

/**
 * How a repo runs a chosen set of test files, as plain config (e.g. from an env var).
 *  - "append-files": the runner takes file arguments (`vitest run a.test.ts b.test.ts`).
 *  - "delete-others": the runner has no file filter and runs every `<testDir>/*<testSuffix>`,
 *    so the check deletes the other top-level test files in the (throwaway) replay
 *    workspace first, then runs it.
 */
export const CheckSpec = z.object({
  testFilePattern: z.string().min(1),
  run: z.array(z.string()).min(1),
  filter: z.enum(["append-files", "delete-others"]),
  testDir: z.string().default("tests"),
  testSuffix: z.string().default(".test.ts"),
  fallbackRun: z.array(z.string()).nullable().default(null),
  /**
   * World check, run in a fresh DevEnvironment. `deploy` and `run` are shell; the hidden
   * world test files are appended to `run`. The environment's variables are set
   * (FACTORY_ENV_URL, FACTORY_ENV_DEPLOY, KUBECONFIG...).
   * Example (Playwright e2e): {"testFilePattern":"^tests/e2e/.+\\.spec\\.ts$","run":"STAGE_URL=\"$FACTORY_ENV_URL\" pnpm exec playwright test"}
   */
  world: z
    .object({
      testFilePattern: z.string().min(1),
      deploy: z.string().min(1).default('eval "$FACTORY_ENV_DEPLOY"'),
      run: z.string().min(1),
    })
    .nullable()
    .default(null),
});
export type CheckSpec = z.infer<typeof CheckSpec>;

/** Parse a CheckSpec from JSON text (an env var); throws with the Zod issues on bad config. */
export function parseCheckSpec(json: string): CheckSpec {
  return CheckSpec.parse(JSON.parse(json));
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build capture options from a CheckSpec. */
export function captureOptionsFrom(spec: CheckSpec): CaptureOptions {
  const pattern = new RegExp(spec.testFilePattern);
  return {
    isTestFile: (p) => pattern.test(p),
    fallbackCheckCommand: spec.fallbackRun,
    checkCommand: (files) => {
      if (spec.filter === "append-files") return [...spec.run, ...files];
      const dirPrefix = `${spec.testDir.replace(/\/$/, "")}/`;
      const keep = files.filter((f) => f.startsWith(dirPrefix)).map((f) => f.slice(dirPrefix.length));
      const script =
        `cd ${sh(spec.testDir)} && for f in *${sh(spec.testSuffix)}; do case " ${keep.map((k) => k.replace(/[^A-Za-z0-9._-]/g, "")).join(" ")} " in ` +
        `*" $f "*) ;; *) rm -f -- "$f" ;; esac; done && cd - >/dev/null && exec "$@"`;
      return ["bash", "-c", script, "bench-check", ...spec.run];
    },
    world:
      spec.world === null
        ? null
        : (() => {
            const w = spec.world;
            const wp = new RegExp(w.testFilePattern);
            return { isTestFile: (p: string) => wp.test(p), command: (files: string[]) => ["bash", "-c", `set -e\n${w.deploy}\n${w.run} ${files.map(sh).join(" ")}`] };
          })(),
  };
}
