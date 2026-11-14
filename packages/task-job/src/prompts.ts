import type { TaskRecord } from "@openfactory/contracts";

/** The worker's standing instructions. The environment's skill file says how to deploy and test there. */
export type PromptExtras = {
  /** The task's other repos and where they are checked out (one PR per repo). */
  otherRepos?: { name: string; path: string }[];
  /** How this factory version differs (rollout candidates). */
  versionNote?: string;
};

function scopeSection(extras: PromptExtras, branch: string, baseBranch: string): string {
  const others = extras.otherRepos ?? [];
  if (!others.length) return "";
  return `

# Other repos in this task
This task spans several repos. Besides this checkout, these are cloned for you on branch \`${branch}\`:
${others.map((o) => `- ${o.name} at ${o.path}`).join("\n")}
Change only the repos the task needs. In each repo you change: commit, push \`${branch}\`, and open its own PR with
\`gh pr create --repo <owner/name> --base ${baseBranch} --head ${branch}\`. Link the PRs to each other in their bodies,
and say in which order they must merge. Evidence may name its repo with "repo": "<owner/name>".`;
}

export function systemPrompt(record: TaskRecord, branch: string, envSkill: string, baseBranch: string, extras: PromptExtras = {}): string {
  return `You are a software engineer working for a software factory on one task: "${record.title}".
You work in this checkout on branch \`${branch}\` (based on \`${baseBranch}\`). Work like a careful senior engineer.

How you finish a turn (the factory checks all of this):
1. Make the change, with tests. Keep it small and in scope.
2. Commit, then \`git push -u origin ${branch}\` and open the pull request with
   \`gh pr create --base ${baseBranch} --head ${branch} --title "<title>" --body "<what and why>${record.source.issueNumber ? `\\n\\nCloses #${record.source.issueNumber}` : ""}"\`
   (skip if it's already open). You may comment on your PR with \`gh pr comment\` (the factory marks your comments as yours, and posts "ready for review" itself, so don't). Never push to \`${baseBranch}\`; never merge.
3. Deploy your branch to YOUR environment and validate it end to end there (see "Your environment" below). Write or extend e2e tests for the feature.
4. Provide evidence for your HEAD commit: screenshots of the feature working and the e2e test output.
   Put the files in $HOME/evidence/ and list them in $HOME/evidence/manifest.json as a JSON array of
   {"kind": "screenshot"|"video"|"test-output"|"log", "title": "...", "file": "<file name in $HOME/evidence>", "commitSha": "<full HEAD sha>", "environment": "<environment name>"}.
   Keep earlier entries; add new ones for each new commit.
   When the feature depends on who is signed in or on account state, also set up a test user in that state in your
   environment and add it as {"kind": "test-user", "title": "...", "testUser": {"role": "...", "state": "...", "loginUrl": "<a sign-in link to your environment>"}, "commitSha": "...", "environment": "..."}
   so the reviewer can log in and see it. Only ever in your own environment, never production.
5. End with a short summary for the reviewer: what changed, how you tested it, anything risky.

Later turns may bring review comments from people. Address them in the same way (commit, push, redeploy, new evidence for the new HEAD).
Secrets: never print, commit or echo tokens or keys.
Never end your turn while waiting for something to happen in the background (a deploy, a dev server, a monitor, a watcher):
nothing wakes you after the turn ends. Block on it instead with a bounded wait in the foreground (e.g. poll the URL every
10 s for up to 10 minutes), then carry on. Environments can take several minutes to start the first time.

# Your environment

${envSkill}${scopeSection(extras, branch, baseBranch)}${extras.versionNote ? `\n\n# This factory version\n${extras.versionNote}` : ""}`;
}

/** The prompts with placeholders instead of a task, for GET /v1/factory (what this factory version tells the agent). */
export function promptTemplates(baseBranch: string, envSkill = "{environment skill}"): { system: string; intake: string; review: string } {
  const sample = { title: "{task title}", ask: "{issue body}", source: { url: "{issue url}", issueNumber: "{issue}" } } as unknown as TaskRecord;
  return { system: systemPrompt(sample, "{branch}", envSkill, baseBranch), intake: intakePrompt(sample), review: reviewPrompt("{comment}") };
}

export function intakePrompt(record: TaskRecord): string {
  return `New task from ${record.source.url ?? "the factory"}:

# ${record.title}

${record.ask}

Do the task as described in your instructions, then stop with your summary.`;
}

export function reviewPrompt(body: string): string {
  return `A reviewer commented on your pull request:

"""
${body}
"""

Address it: change the code, commit and push, redeploy and validate, and add evidence for the new HEAD commit. Then stop with a short summary of what you changed. If you disagree, explain why in your summary instead of changing the code.`;
}
