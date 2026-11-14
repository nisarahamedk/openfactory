import { TaskId, type Signal, type TaskRecord, type Team } from "@openfactory/contracts";
import { personFor, type Actor } from "../domain/actor.js";
import { errors, fail } from "../domain/errors.js";
import { assertApprovable, chooseRepo, issueForAsk, mentionFor, mergeTeams } from "../domain/rules.js";
import type { CoreDeps } from "../ports/index.js";
import type { Registry } from "./capability.js";

const repoName = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;

/** Every team: the directory's (factory.yaml wins on a slug clash) plus those made in the app. */
export async function allTeams(deps: CoreDeps): Promise<Team[]> {
  return mergeTeams(await deps.directory.teams(), await deps.org.teams());
}

async function taskOrFail(deps: CoreDeps, id: TaskId): Promise<TaskRecord> {
  return (await deps.tasks.getTask(id)) ?? fail(errors.taskNotFound(id));
}

/** The input for asking for work, from any surface (the app, REST, MCP, a Slack ask via CloudEvents). */
export type AskInput = {
  ask: string;
  repo: string | null;
  requestedBy: string | null | undefined;
  origin: { label: string; url: string | null } | null | undefined;
  labels: string[] | undefined;
  team: string | null;
};

/** Ask for a task: open a labelled issue where the work belongs, then start it. */
export async function ask(deps: CoreDeps, actor: Actor, input: AskInput): Promise<{ issueUrl: string; repo: string; issueNumber: number }> {
  const person = personFor(actor, input.requestedBy);
  const repo = chooseRepo({ repo: input.repo, team: input.team, person }, deps.config.repos().map(repoName), await allTeams(deps));
  const issue = issueForAsk({ ask: input.ask, person, origin: input.origin ?? null, labels: input.labels ?? [] }, deps.config.factoryLabel, mentionFor(deps.config.mentions));
  const opened = await deps.codeHost.openIssue(repo, issue);
  await deps.runner.signal({
    type: "issue_labeled",
    id: `app-new:${repoName(repo)}#${opened.number}`,
    repo,
    at: deps.now(),
    actor: { login: person, isBot: false },
    issueNumber: opened.number,
    label: deps.config.factoryLabel,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
  });
  return { issueUrl: opened.url, repo: repoName(repo), issueNumber: opened.number };
}

/** Task operations. */
export const taskCapabilities: Pick<
  Registry,
  "listTasks" | "getTask" | "listTaskEvents" | "createTask" | "cancelTask" | "retryTask" | "approveTask" | "postTaskMessage" | "postSignal" | "postEgress"
> = {
  listTasks: {
    audience: "viewer",
    risk: "read",
    mcp: true,
    target: null,
    run: async ({ deps }, i) => ({ tasks: await deps.tasks.listTasks({ ...(i.status !== undefined ? { status: i.status } : {}), limit: i.limit ?? 100 }) }),
  },
  getTask: { audience: "viewer", risk: "read", mcp: true, target: (i) => i.id, run: async ({ deps }, i) => ({ task: await taskOrFail(deps, i.id) }) },
  listTaskEvents: {
    audience: "viewer",
    risk: "read",
    mcp: true,
    target: (i) => i.id,
    run: async ({ deps }, i) => {
      await taskOrFail(deps, i.id);
      return { events: await deps.tasks.events(i.id) };
    },
  },
  // External: opens an issue on the code host and spends model money.
  createTask: {
    audience: "engineer",
    risk: "external",
    mcp: true,
    target: (i) => i.repo,
    run: ({ deps, actor }, i) => ask(deps, actor, { ask: i.ask, repo: i.repo, requestedBy: i.requestedBy, origin: i.origin, labels: i.labels, team: null }),
  },
  // Reversible: a later comment or a retry resumes the task.
  cancelTask: {
    audience: "engineer",
    risk: "reversible",
    mcp: true,
    target: (i) => i.id,
    run: async ({ deps, actor }, i) => ({ task: (await deps.runner.cancel(i.id, personFor(actor, i.by), i.reason ?? null)) ?? fail(errors.taskNotFound(i.id)) }),
  },
  // External: runs the agent again, which spends model money.
  retryTask: {
    audience: "engineer",
    risk: "external",
    mcp: true,
    target: (i) => i.id,
    run: async ({ deps, actor }, i) => ({ task: (await deps.runner.retry(i.id, personFor(actor, i.by))) ?? fail(errors.taskNotFound(i.id)) }),
  },
  // External: posts the approval on the PR. Merging stays a person's call on the code host.
  approveTask: {
    audience: "engineer",
    risk: "external",
    mcp: true,
    target: (i) => i.id,
    run: async ({ deps, actor }, i) => {
      const t = await taskOrFail(deps, i.id);
      assertApprovable(t);
      const by = personFor(actor, i.by);
      const head = t.pr.headSha;
      const mention = mentionFor(deps.config.mentions);
      await deps.codeHost.comment({ repo: t.source.repo, issueOrPr: t.pr.number }, `**${mention(by)}** approved${head ? ` \`${head.slice(0, 7)}\`` : ""} in the factory app.${i.note ? `\n\n${i.note}` : ""}`);
      await deps.runner.signal({ type: "pr_approved", id: `app-approve:${t.id}:${by}:${head ?? "nohead"}`, repo: t.source.repo, at: deps.now(), actor: { login: by, isBot: false }, prNumber: t.pr.number, headSha: head, via: "app" });
      return { task: await taskOrFail(deps, i.id) };
    },
  },
  // External: posted on the PR or issue, and handed to the agent like a comment.
  postTaskMessage: {
    audience: "engineer",
    risk: "external",
    mcp: true,
    target: (i) => i.id,
    run: async ({ deps, actor }, i) => {
      const t = await taskOrFail(deps, i.id);
      const author = personFor(actor, i.author);
      const target = t.pr?.number ?? t.source.issueNumber;
      const mention = mentionFor(deps.config.mentions);
      const url = target !== null ? (await deps.codeHost.comment({ repo: t.source.repo, issueOrPr: target }, `**${mention(author)}** wrote in the factory app:\n\n${i.text}`)).url : null;
      const at = deps.now();
      const mid = `app:${t.id}:${Date.parse(at).toString(36)}`;
      await deps.tasks.recordMessage(t.id, { author, text: i.text, url }, `msg:${mid}`);
      if (target !== null) await deps.runner.signal({ type: "issue_comment", id: mid, repo: t.source.repo, at, actor: { login: author, isBot: false }, issueNumber: target, body: i.text });
      return { task: await taskOrFail(deps, i.id), url };
    },
  },
  postSignal: {
    audience: "admin",
    risk: "external",
    mcp: false,
    target: (s: Signal) => s.id,
    run: async ({ deps }, s) => ({ result: await deps.runner.signal(s) }),
  },
  // The egress collector's reports: unknown tasks are skipped, a repeated window is recorded once.
  postEgress: {
    audience: "admin",
    risk: "reversible",
    mcp: false,
    target: null,
    run: async ({ deps }, i) => {
      let recorded = 0;
      for (const { taskId, ...entry } of i.entries) {
        const id = TaskId.safeParse(taskId);
        const t = id.success ? await deps.tasks.getTask(id.data) : null;
        if (t === null) continue;
        if (await deps.tasks.recordEgress(t.id, entry)) recorded++;
      }
      return { recorded };
    },
  },
};
