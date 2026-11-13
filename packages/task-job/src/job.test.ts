import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type {
  AgentHarness,
  Chat,
  CodeForge,
  Environment,
  EnvironmentHandle,
  MetricsSink,
  Signal,
  TaskRecord,
  Workspace,
  WorkspaceHandle,
} from "@openfactory/contracts";
import { Ledger } from "@openfactory/ledger";
import { factScorers } from "@openfactory/scoring";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import { TaskJobs } from "./manager.js";

const repo = { host: "github" as const, owner: "acme", name: "app" };
const HOME = "/home/agent";

function world() {
  const files = new Map<string, string>();
  const posts: Array<{ to: number; md: string }> = [];
  const prs = new Map<string, { number: number; url: string; headSha: string }>();
  const sessions: string[] = [];
  const envs: Record<string, string>[] = [];
  const prompts: string[] = [];
  let sha = 0;
  const life: string[] = [];

  const ws: WorkspaceHandle = {
    id: "ws-1",
    repoPath: "/repo",
    async exec(cmd) {
      const [c, ...a] = cmd;
      if (c === "sh") return { exitCode: 0, stdout: HOME, stderr: "" };
      if (c === "git") return { exitCode: 0, stdout: "", stderr: "" };
      if (c === "cat") {
        const f = files.get(a[0]!);
        return f === undefined ? { exitCode: 1, stdout: "", stderr: "nope" } : { exitCode: 0, stdout: f, stderr: "" };
      }
      if (c === "base64") {
        const f = files.get(a[1]!);
        return f === undefined ? { exitCode: 1, stdout: "", stderr: "" } : { exitCode: 0, stdout: Buffer.from(f).toString("base64"), stderr: "" };
      }
      return { exitCode: 127, stdout: "", stderr: "unknown" };
    },
    async spawn() {
      throw new Error("not used");
    },
    async writeFile(p, content) {
      files.set(p, content);
    },
    sleep: async () => void life.push("ws.sleep"),
    wake: async () => void life.push("ws.wake"),
    destroy: async () => void life.push("ws.destroy"),
  };
  const workspace: Workspace = { name: "fake-ws", create: async () => ws, get: async () => ws };
  const envHandle: EnvironmentHandle = {
    name: "task-env",
    credentialsForWorkspace: async () => [{ path: `${HOME}/.kube/config`, content: "kubeconfig" }],
    envVars: async () => ({ KUBECONFIG: `${HOME}/.kube/config` }),
    skill: async () => "Deploy with `devspace deploy`.",
    sleep: async () => void life.push("env.sleep"),
    wake: async () => void life.push("env.wake"),
    destroy: async () => void life.push("env.destroy"),
  };
  const environment: Environment = { name: "fake-env", create: async () => envHandle, get: async () => envHandle };

  /** The fake agent "pushes" a commit and writes evidence for it, like the real one is told to. */
  const agent: AgentHarness = {
    name: "fake-agent",
    model: "fake",
    async openSession(input) {
      envs.push({ ...(input.env ?? {}), MODEL: input.model ?? "" });
      const sessionId = input.resumeSessionId ?? `sess-${sessions.length + 1}`;
      sessions.push(sessionId);
      return {
        sessionId,
        async prompt(text) {
          prompts.push(text);
          sha++;
          const head = `${String(sha).padStart(2, "0")}${"a".repeat(38)}`;
          const branch = "factory/" + (input.systemPrompt.match(/factory\/(task_[a-z0-9]+)/)?.[1] ?? "");
          prs.set(branch, { ...(prs.get(branch) ?? { number: 0, url: "" }), headSha: head } as never);
          files.set(`${HOME}/evidence/shot-${sha}.png`, "PNGDATA");
          const prev = JSON.parse(files.get(`${HOME}/evidence/manifest.json`) ?? "[]");
          prev.push({ kind: "screenshot", title: `Feature at ${sha}`, file: `shot-${sha}.png`, commitSha: head, environment: "task-env" });
          files.set(`${HOME}/evidence/manifest.json`, JSON.stringify(prev));
          return { stopReason: "end_turn", summary: `Did it (${sha}).`, usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.5 } };
        },
        cancel: async () => {},
        close: async () => {},
      };
    },
  };

  let prCounter = 40;
  const codeForge: CodeForge = {
    name: "fake-gh",
    async openPullRequest(i) {
      const existing = prs.get(i.head);
      const n = ++prCounter;
      prs.set(i.head, { number: n, url: `https://gh/pull/${n}`, headSha: existing?.headSha ?? "" });
      return { number: n, url: `https://gh/pull/${n}` };
    },
    async findPullRequestForBranch(_r, branch) {
      const p = prs.get(branch);
      return p && p.number ? p : null;
    },
    mintPushToken: async () => ({ token: "t", expiresAt: "" }),
    async pullRequestStats(_r, n) {
      const p = [...prs.values()].find((x) => x.number === n)!;
      return { headSha: p.headSha, additions: 10, deletions: 2, changedFiles: 3 };
    },
  };
  const chat: Chat = {
    name: "fake-chat",
    async post(t, md) {
      posts.push({ to: t.issueOrPr, md });
      return { url: `https://gh/c/${posts.length}` };
    },
  };
  const sunk: TaskRecord[] = [];
  const sink: MetricsSink = { name: "fake-dx", writeTasks: async (r) => void sunk.push(...r) };
  return { workspace, environment, agent, codeForge, chat, sink, posts, sessions, prompts, life, sunk, files, envs, prs };
}

describe("task job", () => {
  it("runs issue → PR with evidence → review round on the same session → merge", async () => {
    const w = world();
    const ledger = new Ledger(drizzle(new PGlite()));
    await ledger.migrate();
    const faux = fauxProvider({ provider: "foreman-faux", models: [{ id: "haiku" }] });
    faux.setResponses([fauxAssistantMessage("On it! A worker is starting."), fauxAssistantMessage("It's in review on the PR.")]);
    const models = createModels();
    models.setProvider(faux.provider);

    const jobs = new TaskJobs(
      {
        ledger,
        rules: { label: "factory", botLogins: ["factory-bot"], maxTaskUsd: 10, maxReviewRounds: 3 },
        chat: w.chat,
        codeForge: w.codeForge,
        agent: w.agent,
        workspace: w.workspace,
        environment: w.environment,
        modelKeys: { forTask: async (t: string) => ({ ANTHROPIC_API_KEY: `key-${t}` }), revoke: async () => {}, spend: async () => 0.5 * w.prompts.length },
        evidence: { put: async (t, name) => ({ url: `https://factory/evidence/${t}/${name}` }) },
        scorers: factScorers,
        world: {
          world: "shop-30d",
          simDays: 30,
          check: {
            name: "fake-world",
            run: async (i) => ({
              world: i.world, headSha: i.headSha, simDays: i.simDays, status: "passed", startedAt: "t0", finishedAt: "t1",
              invariants: [{ name: "money conserved", ok: true, detail: "" }], metrics: [], reportUrl: null,
            }),
          },
        },
        sinks: [w.sink],
        config: { baseBranch: "main", workerImage: null, agentEnv: {}, maxNudges: 1, branchPrefix: "factory/" },
        log: () => {},
      },
      {
        dataDir: mkdtempSync(join(tmpdir(), "jobs-")),
        models,
        foremanModel: { provider: "foreman-faux", modelId: "haiku" },
        factoryVersion: () => "fv_test",
        harnessInfo: { name: "fake-agent", model: "fake" },
        modelRouting: { default: "fake", routes: [{ model: "cheap", labels: ["ui"] }] },
      },
    );

    const actor = { login: "nisar", isBot: false };
    const base = { repo, at: new Date().toISOString(), actor };
    const labeled: Signal = { ...base, id: "d1", type: "issue_labeled", issueNumber: 7, label: "factory", title: "Dark mode", body: "Add it", labels: ["factory", "ui"] };
    const a = await jobs.handle(labeled);
    expect(a.kind).toBe("start_task");
    expect((await jobs.handle(labeled)).kind).toBe("ignore"); // duplicate delivery
    const taskId = a.taskId!;
    await jobs.idle(taskId);

    await new Promise((res) => setTimeout(res, 50)); // the world check runs in the background
    let r = (await ledger.getTask(taskId))!;
    expect(r.status).toBe("awaiting_review");
    expect(r.worldChecks?.map((c) => [c.world, c.status, c.headSha])).toEqual([["shop-30d", "passed", r.pr?.headSha]]);
    expect(r.pr?.number).toBe(41);
    expect(r.evidence).toHaveLength(1);
    expect(r.harnessSessionId).toBe("sess-1");
    expect(w.posts.some((p) => p.to === 7 && p.md.includes("On it"))).toBe(true);
    expect(w.posts.some((p) => p.to === 41 && p.md.includes("Ready for review") && p.md.includes("![Feature at 1]"))).toBe(true);
    expect(w.life).toEqual(["env.sleep", "ws.sleep"]);
    expect(w.envs[0]?.GH_TOKEN).toBe("t");
    expect(w.envs[0]?.MODEL).toBe("cheap");
    expect(r.harness.model).toBe("cheap");
    expect(r.risk?.level).toBe("low"); // small, evidence for head, no sensitive paths
    expect(w.envs[0]?.ANTHROPIC_API_KEY).toBe(`key-${taskId}`);

    // A question in the issue goes to the foreman, not the worker.
    await jobs.handle({ ...base, id: "d2", type: "issue_comment", issueNumber: 7, body: "status?" });
    expect(w.posts.some((p) => p.to === 7 && p.md.includes("in review"))).toBe(true);

    // A review comment resumes the SAME session.
    await jobs.handle({ ...base, id: "d3", type: "pr_review_comment", prNumber: 41, body: "Use the system theme", path: null });
    await jobs.idle(taskId);
    r = (await ledger.getTask(taskId))!;
    expect(w.sessions).toEqual(["sess-1", "sess-1"]);
    expect(w.prompts[1]).toContain("Use the system theme");
    expect(r.status).toBe("awaiting_review");
    expect(r.people.reviewRounds).toBe(1);
    expect(r.evidence).toHaveLength(2);
    expect(r.pr?.headSha?.startsWith("02")).toBe(true);
    expect(w.posts.some((p) => p.md.includes("Review round 1 addressed"))).toBe(true);

    // Our own bot's comment is ignored.
    expect((await jobs.handle({ ...base, id: "d4", type: "pr_review_comment", prNumber: 41, body: "x", path: null, actor: { login: "factory-bot", isBot: true } })).kind).toBe("ignore");

    // A person pushes to the PR branch before merging: recorded as not by the factory.
    for (const p of w.prs.values()) p.headSha = "human1";

    await jobs.handle({ ...base, id: "d5", type: "pr_merged", prNumber: 41, mergeSha: "m1" });
    await jobs.idle(taskId);
    r = (await ledger.getTask(taskId))!;
    expect(r.status).toBe("merged");
    expect(r.outcomes.map((o) => o.kind)).toEqual(["merged"]);
    expect(r.usage.costUsd).toBe(1); // billed by the gateway: 0.5 per turn, two turns
    expect(r.scores.some((s) => s.scorer.includes("merged"))).toBe(true);
    expect(w.sunk.at(-1)?.status).toBe("merged");
    expect(w.life).toContain("ws.destroy");
    const ev = await ledger.events(taskId);
    expect(ev.filter((e) => e.type === "transcript_saved").map((e) => (e.data as { key: string }).key)).toEqual(["transcript-1.jsonl", "transcript-2.jsonl"]);
    const pushes = ev.filter((e) => e.type === "pushed").map((e) => e.data as { sha: string; byFactory?: boolean });
    expect(pushes.at(-1)).toEqual({ sha: "human1", byFactory: false });
    expect(pushes.filter((x) => x.byFactory === true).length).toBeGreaterThan(0);
    expect(ev.filter((e) => e.type === "pr_stats").map((e) => (e.data as { headSha: string }).headSha)).toContain("human1");
    await jobs.close();
  }, 30_000);
});
