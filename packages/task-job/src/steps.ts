/**
 * The steps of a task's life. Each is safe to run again after a crash: it
 * checks the ledger and the outside world before acting.
 */
import { Evidence, TestUser, type EnvironmentHandle, type RepoRef, type TaskId, type TaskRecord, type WorkspaceHandle, type WorldCheck } from "@openfactory/contracts";
import { DEFAULT_RISK, mergeRisk, readyForReview } from "@openfactory/rules";
import { mergeScores, runScorers } from "@openfactory/scoring";
import { z } from "zod";
import { branchFor, issueTarget, type JobDeps } from "./deps.js";
import { systemPrompt } from "./prompts.js";
import { applyBundle, bundleMcp } from "./bundle.js";
import { TranscriptRecorder } from "./transcript.js";
import type { ErrorKind } from "./errors.js";

/**
 * A readable message for anything thrown, including non-Error values such as Kubernetes client
 * ApiExceptions ({ code, body }) that would otherwise print as "[object Object]".
 */
export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const extra = e as Error & { code?: unknown; statusCode?: unknown; body?: unknown };
    const status = extra.code ?? extra.statusCode;
    const body = typeof extra.body === "string" ? extra.body : extra.body ? JSON.stringify(extra.body) : "";
    return [e.message, status !== undefined ? `(status ${String(status)})` : "", body.slice(0, 500)].filter(Boolean).join(" ");
  }
  if (typeof e === "object" && e !== null) {
    try {
      return JSON.stringify(e).slice(0, 1000);
    } catch {
      return Object.prototype.toString.call(e);
    }
  }
  return String(e);
}

export async function mustTask(deps: JobDeps, taskId: TaskId): Promise<TaskRecord> {
  const r = await deps.ledger.getTask(taskId);
  if (!r) throw new Error(`task ${taskId} not in ledger`);
  return r;
}

/** Bring up (or reattach) the environment and workspace for a task. */
export async function prepare(deps: JobDeps, taskId: TaskId): Promise<void> {
  let record = await mustTask(deps, taskId);
  record = await deps.ledger.setStatus(taskId, "preparing");
  const branch = branchFor(deps, record);
  if (!record.branch) await deps.ledger.append(taskId, "branch_set", { branch });

  // A retry after a failure or cancel finds both asleep (pod deleted, disk kept): wake them before use.
  let env: EnvironmentHandle | null = record.environment ? await deps.environment.get(record.environment.name) : null;
  if (env) await env.wake();
  else {
    env = await deps.environment.create({ taskId, repo: record.source.repo });
    await deps.ledger.append(taskId, "environment_attached", { plugin: deps.environment.name, name: env.name });
  }
  let ws: WorkspaceHandle | null = record.workspace ? await deps.workspace.get(record.workspace.id) : null;
  if (ws) await ws.wake();
  else {
    ws = await deps.workspace.create({ taskId, repo: record.source.repo, branch, image: deps.config.workerImage });
    await deps.ledger.append(taskId, "workspace_attached", { plugin: deps.workspace.name, id: ws.id });
  }
  for (const f of await env.credentialsForWorkspace()) await ws.writeFile(f.path, f.content);
}

async function homeOf(ws: WorkspaceHandle): Promise<string> {
  const r = await ws.exec(["sh", "-c", 'printf %s "$HOME"']);
  return r.stdout.trim() || "/root";
}

/**
 * Give the agent a GitHub token for this task's repo only (CodeForge.mintPushToken: short-lived where the forge
 * supports it). The agent pushes its branch, opens the PR and comments with git and gh. Called before every turn,
 * so an expired token is replaced. The sandbox's egress allowlist is the main control on what it can reach.
 */
export async function giveGitAccess(deps: JobDeps, record: TaskRecord, ws: WorkspaceHandle): Promise<Record<string, string>> {
  const home = await homeOf(ws);
  const scope = scopeRepos(record);
  const { token } = await deps.codeForge.mintPushToken(record.source.repo);
  // One credential line per repo (credential.useHttpPath), so each repo gets its own scoped token.
  const lines = [`https://x-access-token:${token}@github.com/${record.source.repo.owner}/${record.source.repo.name}.git`];
  for (const repo of scope.slice(1)) {
    const t = await deps.codeForge.mintPushToken(repo);
    lines.push(`https://x-access-token:${t.token}@github.com/${repo.owner}/${repo.name}.git`);
  }
  await ws.writeFile(`${home}/.git-credentials`, `${lines.join("\n")}\n`);
  await ws.exec(["git", "config", "--global", "credential.helper", `store --file=${home}/.git-credentials`]);
  await ws.exec(["git", "config", "--global", "credential.useHttpPath", "true"]);
  return { GH_TOKEN: token, GH_REPO: `${record.source.repo.owner}/${record.source.repo.name}` };
}

/** The task's repos, primary first. */
export function scopeRepos(record: TaskRecord): RepoRef[] {
  const extra = (record.repos ?? []).map((x) => x.repo).filter((r) => `${r.owner}/${r.name}`.toLowerCase() !== `${record.source.repo.owner}/${record.source.repo.name}`.toLowerCase());
  return [record.source.repo, ...extra];
}

/** Where a secondary repo is checked out in the workspace. */
export function repoPath(home: string, repo: RepoRef): string {
  return `${home}/repos/${repo.owner}-${repo.name}`;
}

/** Clone the task's other repos next to the primary checkout, on the task branch (idempotent). */
export async function cloneScope(deps: JobDeps, record: TaskRecord, ws: WorkspaceHandle): Promise<void> {
  const home = await homeOf(ws);
  const branch = branchFor(deps, record);
  for (const repo of scopeRepos(record).slice(1)) {
    const dir = repoPath(home, repo);
    const url = `https://github.com/${repo.owner}/${repo.name}.git`;
    const script = `set -e
if [ ! -d "${dir}/.git" ]; then mkdir -p "$(dirname "${dir}")"; git clone --quiet "${url}" "${dir}"; fi
cd "${dir}"
git fetch --quiet origin "${branch}" 2>/dev/null && git checkout --quiet -B "${branch}" "origin/${branch}" || git checkout --quiet -B "${branch}" "origin/${deps.config.baseBranch}" 2>/dev/null || git checkout --quiet -B "${branch}"`;
    const r = await ws.exec(["sh", "-c", script]);
    if (r.exitCode !== 0) throw new Error(`could not check out ${repo.owner}/${repo.name}: ${r.stderr.slice(0, 500)}`);
  }
}

export async function attach(deps: JobDeps, record: TaskRecord): Promise<{ ws: WorkspaceHandle; env: EnvironmentHandle }> {
  const ws = record.workspace ? await deps.workspace.get(record.workspace.id) : null;
  const env = record.environment ? await deps.environment.get(record.environment.name) : null;
  if (!ws || !env) throw new Error(`task ${record.id}: workspace or environment missing`);
  return { ws, env };
}

export async function wakeAll(deps: JobDeps, taskId: TaskId): Promise<void> {
  const record = await mustTask(deps, taskId);
  const { ws, env } = await attach(deps, record);
  await ws.wake();
  await env.wake();
  for (const f of await env.credentialsForWorkspace()) await ws.writeFile(f.path, f.content);
}

export async function sleepAll(deps: JobDeps, taskId: TaskId): Promise<void> {
  const record = await mustTask(deps, taskId);
  try {
    const { ws, env } = await attach(deps, record);
    await env.sleep();
    await ws.sleep();
  } catch (e) {
    deps.log("sleep failed", { taskId, error: describeError(e) });
  }
}

/**
 * Record a PR head nobody in the factory pushed (a person pushed between turns).
 * Called before every turn and at finalize, so the next factory push is not blamed on a person.
 */
export async function notePushesByOthers(deps: JobDeps, taskId: TaskId): Promise<void> {
  const record = await mustTask(deps, taskId);
  if (!record.pr || !record.branch) return;
  try {
    const pr = await deps.codeForge.findPullRequestForBranch(record.source.repo, record.branch);
    if (pr?.headSha && pr.headSha !== record.pr.headSha) {
      await deps.ledger.append(taskId, "pushed", { sha: pr.headSha, byFactory: false }, { dedupeKey: `pushed:${taskId}:${pr.headSha}` });
      await recordPrStats(deps, taskId);
    }
  } catch (e) {
    deps.log("push check failed", { taskId, error: describeError(e) });
  }
}

/** PR size at its current head, once per head. Never throws. */
export async function recordPrStats(deps: JobDeps, taskId: TaskId): Promise<void> {
  if (!deps.codeForge.pullRequestStats) return;
  try {
    const record = await mustTask(deps, taskId);
    if (!record.pr) return;
    const { files: _files, ...st } = await deps.codeForge.pullRequestStats(record.source.repo, record.pr.number);
    await deps.ledger.append(taskId, "pr_stats", st, { dedupeKey: `pr_stats:${taskId}:${st.headSha}` });
  } catch (e) {
    deps.log("pr stats failed", { taskId, error: describeError(e) });
  }
}

/** Save one turn's transcript to the EvidenceStore and point to it from the ledger. Never throws. */
async function saveTranscript(deps: JobDeps, taskId: TaskId, turn: number, t: TranscriptRecorder): Promise<void> {
  try {
    const key = `transcript-${turn}.jsonl`;
    const { url } = await deps.evidence.put(taskId, key, Buffer.from(t.toJsonl(), "utf8"), "application/x-ndjson");
    await deps.ledger.append(taskId, "transcript_saved", { turn, key, url, lines: t.size }, { dedupeKey: `transcript:${taskId}:${turn}` });
  } catch (e) {
    deps.log("transcript save failed", { taskId, turn, error: describeError(e) });
  }
}

/**
 * The turn's cost as the model gateway billed it: the key's total spend minus what earlier turns recorded
 * (so a gateway that books spend a little late is corrected on the next turn). Falls back to the agent's
 * own estimate, which depends on the agent knowing the model's price.
 */
async function billedUsage(deps: JobDeps, taskId: TaskId, reported: { inputTokens: number; outputTokens: number; costUsd: number }) {
  if (!deps.modelKeys?.spend) return reported;
  try {
    const total = await deps.modelKeys.spend(taskId);
    if (total === null) return reported;
    const earlier = (await deps.ledger.events(taskId)).reduce((sum, e) => {
      if (e.type === "turn_finished") return sum + ((e.data as { usage?: { costUsd?: number } }).usage?.costUsd ?? 0);
      if (e.type === "cost_adjusted") return sum + ((e.data as { deltaUsd?: number }).deltaUsd ?? 0);
      return sum;
    }, 0);
    return { ...reported, costUsd: Math.max(0, Math.round((total - earlier) * 1e6) / 1e6) };
  } catch (e) {
    deps.log("gateway spend failed", { taskId, error: describeError(e) });
    return reported;
  }
}

/** One agent turn on the task's single harness session (resumed across review rounds). */
export async function runTurn(
  deps: JobDeps,
  taskId: TaskId,
  reason: "intake" | "review" | "steer",
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  await notePushesByOthers(deps, taskId);
  const record = await mustTask(deps, taskId);
  const { ws, env } = await attach(deps, record);
  const skill = await env.skill();
  const bundle = deps.config.versionBundles?.[record.factoryVersion] ?? null;
  if (bundle) {
    const applied = await applyBundle(ws, ws.repoPath, bundle).catch((e) => ({ ok: false, stderr: describeError(e) }));
    if (!applied.ok) deps.log("version bundle not fully applied", { taskId, version: record.factoryVersion, stderr: applied.stderr.slice(0, 500) });
  }
  const session = await deps.agent.openSession({
    workspace: ws,
    cwd: ws.repoPath,
    systemPrompt: systemPrompt(record, branchFor(deps, record), skill, deps.config.baseBranch, {
      otherRepos: scopeRepos(record).slice(1).map((r) => ({ name: `${r.owner}/${r.name}`, path: repoPath("$HOME", r) })),
      versionNote: [deps.config.versionPrompts?.[record.factoryVersion], bundle?.prompt].filter(Boolean).join("\n\n"),
    }),
    resumeSessionId: record.harnessSessionId,
    model: record.harness.model,
    ...(bundle ? { mcpServers: bundleMcp(bundle), ...(bundle.effort ? { effort: bundle.effort } : {}) } : {}),
    env: {
      ...(await env.envVars()),
      ...deps.config.agentEnv,
      ...(deps.modelKeys ? await deps.modelKeys.forTask(taskId) : {}),
      ...(await giveGitAccess(deps, record, ws)),
    },
  });
  await cloneScope(deps, record, ws);
  if (session.sessionId !== record.harnessSessionId)
    await deps.ledger.append(taskId, "session_started", { sessionId: session.sessionId });
  const turn = (await deps.ledger.events(taskId)).filter((e) => e.type === "turn_started").length + 1;
  await deps.ledger.append(taskId, "turn_started", { reason });
  const transcript = new TranscriptRecorder();
  transcript.prompt(prompt);
  const onAbort = () => void session.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await session.prompt(prompt, (u) => {
      transcript.update(u);
      if (u.kind === "tool_call" && (u.status === "completed" || u.status === "failed")) deps.log("tool", { taskId, title: u.title, status: u.status });
    });
    const usage = await billedUsage(deps, taskId, result.usage);
    transcript.result(result.stopReason, usage);
    await deps.ledger.append(taskId, "turn_finished", {
      reason,
      usage,
      stopReason: result.stopReason,
      summary: result.summary.slice(0, 4000),
    });
    return result.summary;
  } catch (e) {
    transcript.error(describeError(e));
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await saveTranscript(deps, taskId, turn, transcript);
    await session.close().catch((e) => deps.log("session close failed", { taskId, error: describeError(e) }));
  }
}

/** Find the PR for the task branch, opening it if the branch was pushed. Records pr_opened / pushed. */
export async function ensurePr(deps: JobDeps, taskId: TaskId, summary: string): Promise<TaskRecord> {
  let record = await mustTask(deps, taskId);
  const branch = branchFor(deps, record);
  let pr = await deps.codeForge.findPullRequestForBranch(record.source.repo, branch);
  if (!pr && !record.pr) {
    try {
      const issue = record.source.issueNumber;
      const opened = await deps.codeForge.openPullRequest({
        repo: record.source.repo,
        head: branch,
        base: deps.config.baseBranch,
        title: record.title,
        body: `${summary.slice(0, 6000)}\n\n---\n${issue ? `Closes #${issue}. ` : ""}Opened by the factory for task \`${record.id}\` (factory version \`${record.factoryVersion}\`). Comment on this PR to request changes; the same agent session picks them up.`,
      });
      pr = await deps.codeForge.findPullRequestForBranch(record.source.repo, branch);
      if (!pr) pr = { ...opened, headSha: "" };
    } catch (e) {
      deps.log("open PR failed (branch not pushed?)", { taskId, error: describeError(e) });
      return record;
    }
  }
  if (!pr) return record;
  let moved = false;
  if (!record.pr || record.pr.number !== pr.number) {
    record = (await deps.ledger.append(taskId, "pr_opened", { number: pr.number, url: pr.url, headSha: pr.headSha || null })).record;
    moved = true;
  } else if (pr.headSha && pr.headSha !== record.pr.headSha) {
    record = (await deps.ledger.append(taskId, "pushed", { sha: pr.headSha, byFactory: true }, { dedupeKey: `pushed:${taskId}:${pr.headSha}` })).record;
    moved = true;
  }
  if (moved) await recordPrStats(deps, taskId);
  return ensureOtherPrs(deps, taskId);
}

/** Record the PRs the agent opened in the task's other repos (one per repo; the agent opens them). */
async function ensureOtherPrs(deps: JobDeps, taskId: TaskId): Promise<TaskRecord> {
  let record = await mustTask(deps, taskId);
  const branch = branchFor(deps, record);
  for (const repo of scopeRepos(record).slice(1)) {
    try {
      const pr = await deps.codeForge.findPullRequestForBranch(repo, branch);
      if (!pr) continue;
      const known = (record.repos ?? []).find((x) => x.repo.owner === repo.owner && x.repo.name === repo.name)?.pr ?? null;
      if (!known || known.number !== pr.number)
        record = (await deps.ledger.append(taskId, "pr_opened", { number: pr.number, url: pr.url, headSha: pr.headSha || null, repo })).record;
      else if (pr.headSha && pr.headSha !== known.headSha)
        record = (await deps.ledger.append(taskId, "pushed", { sha: pr.headSha, byFactory: true, repo }, { dedupeKey: `pushed:${taskId}:${repo.owner}/${repo.name}:${pr.headSha}` })).record;
    } catch (e) {
      deps.log("other repo PR check failed", { taskId, repo: `${repo.owner}/${repo.name}`, error: describeError(e) });
    }
  }
  return record;
}

/** Assess and label merge risk for the primary PR's head (once per head). Never throws. */
export async function assessRisk(deps: JobDeps, taskId: TaskId): Promise<void> {
  try {
    const record = await mustTask(deps, taskId);
    if (!record.pr?.headSha || !deps.codeForge.pullRequestStats) return;
    if (record.risk?.headSha === record.pr.headSha) return;
    const st = await deps.codeForge.pullRequestStats(record.source.repo, record.pr.number);
    const events = await deps.ledger.events(taskId);
    const ci = events
      .filter((e) => e.type === "ci_completed" && (e.data as { headSha?: string }).headSha === st.headSha)
      .map((e) => String((e.data as { conclusion?: string }).conclusion));
    const head = st.headSha;
    const risk = mergeRisk(
      {
        headSha: head,
        additions: st.additions,
        deletions: st.deletions,
        files: st.files ?? [],
        ci,
        evidenceForHead: record.evidence.some((e) => head.startsWith(e.commitSha) || e.commitSha.startsWith(head)),
        reviewRounds: record.people.reviewRounds,
      },
      (record.factory && deps.factories?.[record.factory]?.risk) || deps.config.risk || DEFAULT_RISK,
    );
    await deps.ledger.append(taskId, "merge_risk", risk, { dedupeKey: `merge_risk:${taskId}:${head}` });
    await deps.codeForge.setPrefixedLabels?.(record.source.repo, record.pr.number, "risk:", [`risk:${risk.level}`]);
  } catch (e) {
    deps.log("merge risk failed", { taskId, error: describeError(e) });
  }
}

const ManifestEntry = z.object({
  kind: Evidence.shape.kind,
  title: z.string(),
  file: z.string().optional(),
  url: z.string().optional(),
  commitSha: z.string(),
  environment: z.string(),
  testUser: TestUser.optional(),
  repo: z.string().optional(),
});

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webm: "video/webm",
  mp4: "video/mp4",
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
};

/** Copy new evidence out of the sandbox ($HOME/evidence/manifest.json) into the evidence store and the ledger. */
export async function collectEvidence(deps: JobDeps, taskId: TaskId): Promise<number> {
  const record = await mustTask(deps, taskId);
  const { ws } = await attach(deps, record);
  const home = await homeOf(ws);
  const dir = `${home}/evidence`;
  const raw = await ws.exec(["cat", `${dir}/manifest.json`]);
  if (raw.exitCode !== 0) return 0;
  let entries: z.infer<typeof ManifestEntry>[] = [];
  try {
    const parsed = JSON.parse(raw.stdout);
    entries = (Array.isArray(parsed) ? parsed : []).flatMap((x) => {
      const r = ManifestEntry.safeParse(x);
      return r.success ? [r.data] : [];
    });
  } catch {
    return 0;
  }
  let added = 0;
  for (const e of entries) {
    if (e.kind === "test-user" && !e.testUser) continue;
    let url = e.kind === "test-user" ? (e.testUser?.loginUrl ?? "") : (e.url ?? "");
    if (e.file && e.kind !== "test-user") {
      const path = e.file.startsWith("/") ? e.file : `${dir}/${e.file}`;
      const name = `${e.commitSha.slice(0, 12)}-${path.split("/").pop()}`;
      if (record.evidence.some((x) => x.url.endsWith(`/${name}`))) continue;
      const b64 = await ws.exec(["base64", "-w0", path]);
      if (b64.exitCode !== 0) continue;
      const ext = (name.split(".").pop() ?? "").toLowerCase();
      url = (await deps.evidence.put(taskId, name, Buffer.from(b64.stdout.trim(), "base64"), CONTENT_TYPES[ext] ?? "application/octet-stream")).url;
    } else if (record.evidence.some((x) => x.url === url && x.commitSha === e.commitSha)) continue;
    if (!url) continue;
    await deps.ledger.append(taskId, "evidence_added", {
      evidence: {
        kind: e.kind,
        title: e.title,
        url,
        commitSha: e.commitSha,
        environment: e.environment,
        createdAt: new Date().toISOString(),
        ...(e.testUser ? { testUser: e.testUser } : {}),
        ...(e.repo ? { repo: e.repo } : {}),
      },
    });
    added++;
  }
  return added;
}

export function evidenceMarkdown(record: TaskRecord): string {
  const head = record.pr?.headSha;
  const rows = record.evidence.filter((e) => !head || head.startsWith(e.commitSha) || e.commitSha.startsWith(head));
  const list = rows.length ? rows : record.evidence;
  return list
    .map((e) => {
      const tag = `\`${e.commitSha.slice(0, 7)}\` on \`${e.environment}\``;
      if (e.kind === "test-user" && e.testUser) return `- **Log in as ${e.testUser.role}** (${e.testUser.state}): [sign in](${e.url}) (${tag})`;
      return e.kind === "screenshot" ? `**${e.title}** (${tag})\n\n![${e.title}](${e.url})` : `- [${e.title}](${e.url}) (${e.kind}, ${tag})`;
    })
    .join("\n\n");
}

export type Gate = { kind: "ready" } | { kind: "nudge"; prompt: string } | { kind: "give_up"; reason: string };

/** After a turn: PR + evidence → review; otherwise nudge the agent, then give up. */
export async function reviewGate(deps: JobDeps, taskId: TaskId, summary: string, nudges: number): Promise<Gate> {
  await ensurePr(deps, taskId, summary);
  await collectEvidence(deps, taskId);
  const record = await ensurePr(deps, taskId, summary);
  const ready = readyForReview(record);
  if (ready.ok) {
    await assessRisk(deps, taskId);
    return { kind: "ready" };
  }
  if (nudges < deps.config.maxNudges)
    return {
      kind: "nudge",
      prompt: `The factory can't send this to review yet: ${ready.reason}\nCommit and push branch \`${branchFor(deps, record)}\`, open the pull request if it isn't open yet, run the e2e tests against your environment, and write evidence for your HEAD commit to $HOME/evidence/manifest.json as described in your instructions. If your environment is still starting, wait for it in the foreground (poll its URL for up to 10 minutes); do not end the turn until the evidence is written.`,
    };
  return { kind: "give_up", reason: ready.reason };
}

export async function announceReview(deps: JobDeps, taskId: TaskId, summary: string, round: number): Promise<void> {
  const record = await deps.ledger.setStatus(taskId, "awaiting_review");
  if (!record.pr) return;
  const header = round === 0 ? "Ready for review." : `Review round ${round} addressed.`;
  await deps.chat.post(
    { repo: record.source.repo, issueOrPr: record.pr.number },
    `${header} Head \`${record.pr.headSha?.slice(0, 7) ?? "?"}\`, environment \`${record.environment?.name ?? "?"}\`.${riskLine(record)}${otherPrsLine(record)}\n\n${summary.slice(0, 3000)}\n\n### Evidence\n\n${evidenceMarkdown(record)}\n\n<sub>factory task \`${record.id}\` · factory \`${record.factoryVersion}\`${record.versionArm === "candidate" ? " (candidate)" : ""} · ${record.harness.model} · cost so far $${record.usage.costUsd.toFixed(2)}</sub>`,
  );
}

function riskLine(record: TaskRecord): string {
  const r = record.risk;
  if (!r || r.headSha !== record.pr?.headSha) return "";
  return `\n\n**Merge risk: ${r.level}.** ${r.reasons.join("; ")}.`;
}

function otherPrsLine(record: TaskRecord): string {
  const others = (record.repos ?? []).slice(1).filter((x) => x.pr);
  if (!others.length) return "";
  return `\n\nThis task also changed: ${others.map((x) => `[${x.repo.owner}/${x.repo.name}#${x.pr!.number}](${x.pr!.url})`).join(", ")}. Merge them together.`;
}

const KIND_WORDS: Record<ErrorKind, string> = {
  passing: "a passing problem that didn't clear after several tries",
  setup: "a setup problem",
  agent: "the agent didn't produce something reviewable",
  unknown: "an unexpected error",
};

export async function fail(
  deps: JobDeps,
  taskId: TaskId,
  stage: string,
  message: string,
  how: { kind: ErrorKind; fix: string | null; attempts?: number } = { kind: "unknown", fix: null },
): Promise<void> {
  await deps.ledger.append(taskId, "error", { stage, message: message.slice(0, 2000), kind: how.kind, fix: how.fix, attempts: how.attempts ?? 1 });
  const record = await deps.ledger.setStatus(taskId, "failed", stage);
  const target = record.pr ? { repo: record.source.repo, issueOrPr: record.pr.number } : issueTarget(record);
  const fix = how.fix ? `\n\n**What to do:** ${how.fix}` : "";
  if (target)
    await deps.chat
      .post(target, `The factory stopped this task at **${stage}**: ${KIND_WORDS[how.kind]}.\n\n> ${message.slice(0, 800).replace(/\n/g, "\n> ")}${fix}\n\nComment here or press Retry in the factory app to try again.`)
      .catch(() => {});
}

/**
 * Make the record's agent cost equal what the gateway billed the task key. Turn costs are read right after
 * each turn, and gateways book spend late (LiteLLM batches writes), so this runs again whenever the task
 * settles. Never throws.
 */
export async function reconcileCost(deps: JobDeps, taskId: TaskId): Promise<void> {
  if (!deps.modelKeys?.spend) return;
  try {
    const gateway = await deps.modelKeys.spend(taskId);
    if (gateway === null) return;
    const recorded = (await deps.ledger.events(taskId)).reduce((sum, e) => {
      if (e.type === "turn_finished") return sum + ((e.data as { usage?: { costUsd?: number } }).usage?.costUsd ?? 0);
      if (e.type === "cost_adjusted") return sum + ((e.data as { deltaUsd?: number }).deltaUsd ?? 0);
      return sum;
    }, 0);
    const deltaUsd = Math.round((gateway - recorded) * 1e6) / 1e6;
    if (Math.abs(deltaUsd) >= 0.0001) await deps.ledger.append(taskId, "cost_adjusted", { deltaUsd, gatewayUsd: gateway });
  } catch (e) {
    deps.log("cost reconcile failed", { taskId, error: describeError(e) });
  }
}

const worldRuns = new Map<string, Promise<void>>();

/**
 * Run the factory's world check against the primary PR's head, once per head, in the background: a 30-day world
 * can take minutes and must never hold up review. The result lands as a world_check event (and the checks.world
 * score). Returns the running promise (tests await it). Never throws.
 */
export function startWorldCheck(deps: JobDeps, taskId: TaskId): Promise<void> {
  const base = deps.world;
  if (!base) return Promise.resolve();
  const running = worldRuns.get(taskId);
  if (running) return running;
  return (async () => {
    const rec = await deps.ledger.getTask(taskId);
    const team = rec?.factory ? deps.factories?.[rec.factory] : undefined;
    // A team factory names its own world, or none; otherwise the org's.
    const w = team && team.world !== undefined ? (team.world ? { ...base, ...team.world } : null) : base;
    if (!w) return;
    await runWorld(deps, taskId, w);
  })();
}

function runWorld(deps: JobDeps, taskId: TaskId, w: { check: WorldCheck; world: string; simDays: number }): Promise<void> {
  const running = worldRuns.get(taskId);
  if (running) return running; // one world at a time per task; the next settle picks up a newer head
  const run = (async () => {
    const record = await mustTask(deps, taskId);
    const head = record.pr?.headSha;
    if (!head) return;
    const key = `world:${taskId}:${head}`;
    if (await deps.ledger.seen(key)) return;
    const startedAt = new Date().toISOString();
    let result;
    try {
      result = await w.check.run({ task: record, repo: record.source.repo, headSha: head, world: w.world, simDays: w.simDays });
    } catch (e) {
      result = {
        world: w.world,
        headSha: head,
        simDays: w.simDays,
        status: "error" as const,
        startedAt,
        finishedAt: new Date().toISOString(),
        invariants: [{ name: "world ran", ok: false, detail: describeError(e).slice(0, 500) }],
        metrics: [],
        reportUrl: null,
      };
    }
    await deps.ledger.append(taskId, "world_check", result, { dedupeKey: key });
    await scoreAndExport(deps, taskId);
  })().catch((e) => deps.log("world check failed", { taskId, error: describeError(e) }));
  const tracked = run.finally(() => worldRuns.delete(taskId));
  worldRuns.set(taskId, tracked);
  return tracked;
}

/** Score the record and push it to every metrics sink. Never throws. */
export async function scoreAndExport(deps: JobDeps, taskId: TaskId): Promise<void> {
  await reconcileCost(deps, taskId);
  try {
    const record = await mustTask(deps, taskId);
    const events = await deps.ledger.events(taskId);
    const run = runScorers(record, events, new Date().toISOString(), deps.scorers);
    const merged = mergeScores(record.scores, run.scores);
    for (const s of merged) {
      const old = record.scores.find((x) => x.scorer === s.scorer && x.scorerVersion === s.scorerVersion);
      if (!old || old.value !== s.value || old.label !== s.label) await deps.ledger.append(taskId, "score_added", { score: s });
    }
    const fresh = await mustTask(deps, taskId);
    for (const sink of deps.sinks) await sink.writeTasks([fresh]).catch((e) => deps.log("sink failed", { sink: sink.name, error: describeError(e) }));
  } catch (e) {
    deps.log("scoring failed", { taskId, error: describeError(e) });
  }
}
