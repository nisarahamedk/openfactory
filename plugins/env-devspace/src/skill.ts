/**
 * The skill file the agent reads to use its environment. Plain steps, with
 * the exact names it needs, and the evidence convention the task job reads.
 */
export interface SkillInput {
  namespace: string;
  appUrl: string;
  environmentName: string;
  evidenceDir: string;
  taskId: string;
  notes: string;
  /** The exact command that deploys this repo into the namespace. */
  deployCommand: string;
}

export function renderSkill(input: SkillInput): string {
  return `---
name: factory-environment
description: How to deploy this task's change to its own environment (namespace ${input.namespace}), test it end to end, and leave evidence for the reviewer. Use before saying the work is done.
---

# Your environment: ${input.environmentName}

You have your own copy of the product in the Kubernetes namespace \`${input.namespace}\`.
Nobody else uses it. Your kubeconfig ($KUBECONFIG) can only reach this namespace.

- Product URL: ${input.appUrl}  (also in $FACTORY_ENV_URL)
- Namespace: ${input.namespace}  (also in $FACTORY_ENV_NAMESPACE)

## Deploy

1. Commit your change first. Evidence must name a commit.
2. Deploy from the repo root with DevSpace (the repo's \`devspace.yaml\` says how the product is built and run):

   \`\`\`sh
   ${input.deployCommand}
   \`\`\`

   If the command keeps running (for example \`devspace dev\`, which syncs your edits into the running app),
   start it in the background with its output in a log file, e.g. \`nohup <command> > $HOME/devspace.log 2>&1 &\`,
   and read the log. It keeps syncing while you work; you don't need to redeploy after each edit.

3. Wait until it is up: \`kubectl get pods\`, \`kubectl logs <pod>\`, and \`curl -fsS ${input.appUrl}\`.
   The first start can take a few minutes (dependency install). If it does not come up, read the logs and fix it.
   Do not hand over work you have not seen running.
4. A review round may start after a pause in which your workspace was restarted: check the deploy is still
   running (\`pgrep -fa devspace\`, \`curl -fsS ${input.appUrl}\`) and start it again if not.

## Test end to end

Run the repo's Playwright tests against your environment, not against localhost:

\`\`\`sh
BASE_URL=${input.appUrl} PLAYWRIGHT_BASE_URL=${input.appUrl} npx playwright test
\`\`\`

If the change has no e2e test yet, add one that shows the change working, the way a person would use it.

## Evidence (required before review)

The factory posts your evidence on the pull request. A reviewer will not look at work without it.
Put files in \`${input.evidenceDir}/\` and list them in \`${input.evidenceDir}/manifest.json\`:

\`\`\`json
[
  { "kind": "screenshot", "title": "Settings page with the new toggle", "file": "settings.png", "commitSha": "<git rev-parse HEAD>", "environment": "${input.environmentName}" },
  { "kind": "test-output", "title": "Playwright e2e run", "file": "e2e.txt", "commitSha": "<git rev-parse HEAD>", "environment": "${input.environmentName}" }
]
\`\`\`

- \`kind\` is one of: screenshot, video, test-output, log.
- \`commitSha\` is the commit you deployed and tested. It must be the commit you pushed last; redo the evidence after every new push.
- \`environment\` is always \`${input.environmentName}\`.
- Screenshots: \`await page.screenshot({ path: "${input.evidenceDir}/<name>.png", fullPage: true })\` in the test, or a short script.
- Test output: save the full Playwright output, e.g. \`npx playwright test 2>&1 | tee ${input.evidenceDir}/e2e.txt\`, and say on its first line which commit and environment it ran against.
- Replace the manifest each round; keep only evidence for the current commit.

## Hand over

- Push your branch (\`git push -u origin HEAD\`). Do not open the pull request; the factory opens it and posts your evidence.
- Finish your turn with a short summary: what changed, how you tested it, and anything the reviewer should look at.
- During review rounds, the same environment is still yours: redeploy, retest and refresh the evidence after each fix.
${input.notes === "" ? "" : `\n## Notes for this repo\n\n${input.notes}\n`}`;
}
