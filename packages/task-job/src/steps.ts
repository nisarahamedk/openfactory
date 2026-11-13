/**
 * The steps of a task's life. Each is safe to run again after a crash: it
 * checks the ledger and the outside world before acting.
 */
import { Evidence, type EnvironmentHandle, type TaskId, type TaskRecord, type WorkspaceHandle } from "@openfactory/contracts";
import { readyForReview } from "@openfactory/rules";
import { mergeScores, runScorers } from "@openfactory/scoring";
import { z } from "zod";
import { branchFor, issueTarget, type JobDeps } from "./deps.js";
import { systemPrompt } from "./prompts.js";

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

  let env: EnvironmentHandle | null = record.environment ? await deps.environment.get(record.environment.name) : null;
  if (!env) {
    env = await deps.environment.create({ taskId, repo: record.source.repo });
    await deps.ledger.append(taskId, "environment_attached", { plugin: deps.environment.name, name: env.name });
  }
  let ws: WorkspaceHandle | null = record.workspace ? await deps.workspace.get(record.workspace.id) : null;
  if (!ws) {
    ws = await deps.workspace.create({ taskId, repo: record.source.repo, branch, image: deps.config.workerImage });
    await deps.ledger.append(taskId, "workspace_attached", { plugin: deps.workspace.name, id: ws.id });
  }
  for (const f of await env.credentialsForWorkspace()) await ws.writeFile(f.path, f.content);
  await refreshPushToken(deps, record, ws);
}

async function homeOf(ws: WorkspaceHandle): Promise<string> {
  const r = await ws.exec(["sh", "-c", 'printf %s "$HOME"']);
  return r.stdout.trim() || "/root";
}

export async function refreshPushToken(deps: JobDeps, record: TaskRecord, ws: WorkspaceHandle): Promise<void> {
  const { token } = await deps.codeHost.mintPushToken(record.source.repo);
  const home = await homeOf(ws);
  await ws.writeFile(`${home}/.git-credentials`, `https://x-access-token:${token}@github.com\n`);
  await ws.exec(["git", "config", "--global", "credential.helper", `store --file=${home}/.git-credentials`]);
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
  await refreshPushToken(deps, record, ws);
}

export async function sleepAll(deps: JobDeps, taskId: TaskId): Promise<void> {
  const record = await mustTask(deps, taskId);
  try {
    const { ws, env } = await attach(deps, record);
    await env.sleep();
    await ws.sleep();
  } catch (e) {
    deps.log("sleep failed", { taskId, error: String(e) });
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
  const record = await mustTask(deps, taskId);
  const { ws, env } = await attach(deps, record);
  const skill = await env.skill();
  const session = await deps.agent.openSession({
    workspace: ws,
    cwd: ws.repoPath,
    systemPrompt: systemPrompt(record, branchFor(deps, record), skill, deps.config.baseBranch),
    resumeSessionId: record.harnessSessionId,
    env: { ...(await env.envVars()), ...deps.config.agentEnv },
  });
  if (session.sessionId !== record.harnessSessionId)
    await deps.ledger.append(taskId, "session_started", { sessionId: session.sessionId });
  await deps.ledger.append(taskId, "turn_started", { reason });
  const onAbort = () => void session.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await session.prompt(prompt, (u) => {
      if (u.kind === "tool_call" && (u.status === "completed" || u.status === "failed")) deps.log("tool", { taskId, title: u.title, status: u.status });
    });
    await deps.ledger.append(taskId, "turn_finished", {
      reason,
      usage: result.usage,
      stopReason: result.stopReason,
      summary: result.summary.slice(0, 4000),
    });
    return result.summary;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await session.close().catch((e) => deps.log("session close failed", { taskId, error: String(e) }));
  }
}

/** Find the PR for the task branch, opening it if the branch was pushed. Records pr_opened / pushed. */
export async function ensurePr(deps: JobDeps, taskId: TaskId, summary: string): Promise<TaskRecord> {
  let record = await mustTask(deps, taskId);
  const branch = branchFor(deps, record);
  let pr = await deps.codeHost.findPullRequestForBranch(record.source.repo, branch);
  if (!pr && !record.pr) {
    try {
      const issue = record.source.issueNumber;
      const opened = await deps.codeHost.openPullRequest({
        repo: record.source.repo,
        head: branch,
        base: deps.config.baseBranch,
        title: record.title,
        body: `${summary.slice(0, 6000)}\n\n---\n${issue ? `Closes #${issue}. ` : ""}Opened by the factory for task \`${record.id}\` (factory version \`${record.factoryVersion}\`). Comment on this PR to request changes; the same agent session picks them up.`,
      });
      pr = await deps.codeHost.findPullRequestForBranch(record.source.repo, branch);
      if (!pr) pr = { ...opened, headSha: "" };
    } catch (e) {
      deps.log("open PR failed (branch not pushed?)", { taskId, error: String(e) });
      return record;
    }
  }
  if (!pr) return record;
  if (!record.pr || record.pr.number !== pr.number)
    record = (await deps.ledger.append(taskId, "pr_opened", { number: pr.number, url: pr.url, headSha: pr.headSha || null })).record;
  else if (pr.headSha && pr.headSha !== record.pr.headSha) record = (await deps.ledger.append(taskId, "pushed", { sha: pr.headSha })).record;
  return record;
}

const ManifestEntry = z.object({
  kind: Evidence.shape.kind,
  title: z.string(),
  file: z.string().optional(),
  url: z.string().optional(),
  commitSha: z.string(),
  environment: z.string(),
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
    let url = e.url ?? "";
    if (e.file) {
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
      evidence: { kind: e.kind, title: e.title, url, commitSha: e.commitSha, environment: e.environment, createdAt: new Date().toISOString() },
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
  if (ready.ok) return { kind: "ready" };
  if (nudges < deps.config.maxNudges)
    return {
      kind: "nudge",
      prompt: `The factory can't send this to review yet: ${ready.reason}\nPush your branch \`${branchFor(deps, record)}\`, run the e2e tests against your environment, and write evidence for the pushed HEAD commit to $HOME/evidence/manifest.json as described in your instructions. Then stop.`,
    };
  return { kind: "give_up", reason: ready.reason };
}

export async function announceReview(deps: JobDeps, taskId: TaskId, summary: string, round: number): Promise<void> {
  const record = await deps.ledger.setStatus(taskId, "awaiting_review");
  if (!record.pr) return;
  const header = round === 0 ? "Ready for review." : `Review round ${round} addressed.`;
  await deps.chat.post(
    { repo: record.source.repo, issueOrPr: record.pr.number },
    `${header} Head \`${record.pr.headSha?.slice(0, 7) ?? "?"}\`, environment \`${record.environment?.name ?? "?"}\`.\n\n${summary.slice(0, 3000)}\n\n### Evidence\n\n${evidenceMarkdown(record)}\n\n<sub>factory task \`${record.id}\` · cost so far $${record.usage.costUsd.toFixed(2)}</sub>`,
  );
}

export async function fail(deps: JobDeps, taskId: TaskId, stage: string, message: string): Promise<void> {
  await deps.ledger.append(taskId, "error", { stage, message: message.slice(0, 2000) });
  const record = await deps.ledger.setStatus(taskId, "failed", stage);
  const target = record.pr ? { repo: record.source.repo, issueOrPr: record.pr.number } : issueTarget(record);
  if (target) await deps.chat.post(target, `The factory stopped this task at **${stage}**: ${message.slice(0, 1000)}\n\nComment again to retry.`).catch(() => {});
}

/** Score the record and push it to every metrics sink. Never throws. */
export async function scoreAndExport(deps: JobDeps, taskId: TaskId): Promise<void> {
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
    for (const sink of deps.sinks) await sink.writeTasks([fresh]).catch((e) => deps.log("sink failed", { sink: sink.name, error: String(e) }));
  } catch (e) {
    deps.log("scoring failed", { taskId, error: String(e) });
  }
}
