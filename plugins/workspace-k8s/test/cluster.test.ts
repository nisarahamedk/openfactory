/**
 * Cluster integration test for the worker path: env-devspace + workspace-k8s +
 * agent-acp, with the mock model running INSIDE the workspace pod (so no
 * network path from the test runner to the pod is needed, and no money).
 *
 * Run against a real cluster:
 *   KUBECONFIG=... WORKER_IMAGE=... WORKSPACE_NAMESPACE=factory-workspaces \
 *     RUN_CLUSTER_TESTS=1 pnpm --filter @openfactory/workspace-k8s test
 * In a pod, omit KUBECONFIG to use the service account.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { AcpHarness } from "@openfactory/agent-acp";
import { fromEnv as envFromEnv } from "@openfactory/env-devspace";
import { fromEnv } from "../src/index.js";

const require = createRequire(import.meta.url);
const run = process.env.RUN_CLUSTER_TESTS === "1";
const taskId = `task_itest${Date.now().toString(36)}`;

/** A runner for the mock model, scripted for this test, executed in the pod. */
function mockRunner(): string {
  const mockSource = readFileSync(require.resolve("@openfactory/agent-acp/mock-anthropic"), "utf8");
  return `${mockSource}
import { appendFileSync } from "node:fs";
startMockAnthropic([
  (r) => { appendFileSync("/work/mock/requests.log", JSON.stringify({ tools: r.hasTools, toolResult: r.lastIsToolResult, last: r.lastUserText.slice(-200), n: r.messages.length }) + "\n"); return null; },
  (r) => r.lastUserText.includes("ROUND1") && !r.lastIsToolResult
    ? [{ type: "tool_use", name: "Bash", input: { command: "kubectl get pods -o name > pods.txt; kubectl -n default get pods > forbidden.txt 2>&1; echo r1 > round.txt", description: "check env" } }] : null,
  (r) => r.lastUserText.includes("ROUND2") && !r.lastIsToolResult
    ? [{ type: "tool_use", name: "Bash", input: { command: "echo r2 >> round.txt", description: "round 2" } }] : null,
  (r) => r.lastIsToolResult && r.transcript.includes("ROUND2")
    ? [{ type: "text", text: r.transcript.includes("ROUND1") ? "remembered ROUND1" : "forgot ROUND1" }] : null,
  (r) => r.lastIsToolResult ? [{ type: "text", text: "round done" }] : null,
], 18080).then(() => console.log("mock ready"));
`;
}

test.runIf(run)("worker path on a real cluster: env, workspace, agent, sleep, wake, resume", { timeout: 900_000 }, async () => {
  const env = process.env;
  const environments = envFromEnv({ ...env, ENV_APP_URL_TEMPLATE: env.ENV_APP_URL_TEMPLATE ?? "http://{namespace}.invalid" });
  const workspaces = fromEnv(env);
  const repo = { host: "github" as const, owner: env.ITEST_REPO_OWNER ?? "octocat", name: env.ITEST_REPO_NAME ?? "Hello-World" };

  const environment = await environments.create({ taskId, repo });
  const ws = await workspaces.create({ taskId, repo, branch: `factory/${taskId}`, image: null });
  try {
    for (const file of await environment.credentialsForWorkspace()) await ws.writeFile(file.path, file.content);
    const skill = await ws.exec(["cat", "/work/home/.claude/skills/factory-environment/SKILL.md"]);
    expect(skill.stdout).toContain(environment.name);

    await ws.writeFile("/work/mock/mock.mjs", mockRunner());
    const mock = await ws.spawn(["node", "/work/mock/mock.mjs"], { cwd: "/work/mock" });
    await new Promise((r) => setTimeout(r, 1500));

    const harness = new AcpHarness({
      name: "claude-code",
      model: "claude-sonnet-5-5",
      command: ["claude-agent-acp"],
      modeId: "bypassPermissions",
      log: () => undefined,
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18080", ANTHROPIC_API_KEY: "mock", ANTHROPIC_MODEL: "claude-sonnet-5-5" },
    });
    const envVars = await environment.envVars();
    const s1 = await harness.openSession({ workspace: ws, cwd: ws.repoPath, systemPrompt: "itest", resumeSessionId: null, env: envVars });
    const t1 = await s1.prompt("ROUND1", () => undefined);
    const sessionId = s1.sessionId;
    await s1.close();
    expect(t1.summary).toContain("round done");
    // The agent's kubeconfig reaches its own namespace and nothing else.
    expect((await ws.exec(["cat", "forbidden.txt"])).stdout).toMatch(/forbidden/i);
    expect((await ws.exec(["test", "-f", "pods.txt"])).exitCode).toBe(0);

    // Review wait: workspace and environment sleep, then wake for the next round.
    await mock.kill();
    await environment.sleep();
    await ws.sleep();
    await ws.wake();
    await environment.wake();
    for (const file of await environment.credentialsForWorkspace()) await ws.writeFile(file.path, file.content);
    const mock2 = await ws.spawn(["node", "/work/mock/mock.mjs"], { cwd: "/work/mock" });
    await new Promise((r) => setTimeout(r, 1500));

    // The transcript must have survived the pod being deleted and recreated.
    const transcript = await ws.exec(["sh", "-c", `ls /work/home/.claude/projects/*/${sessionId}.jsonl`]);
    expect(transcript.exitCode, transcript.stderr).toBe(0);
    const s2 = await harness.openSession({ workspace: ws, cwd: ws.repoPath, systemPrompt: "itest", resumeSessionId: sessionId, env: envVars });
    const t2 = await s2.prompt("ROUND2", () => undefined);
    await s2.close();
    await mock2.kill();
    if (!t2.summary.includes("remembered ROUND1")) {
      console.log((await ws.exec(["cat", "/work/mock/requests.log"])).stdout);
    }
    expect(t2.summary).toContain("remembered ROUND1");
    expect((await ws.exec(["cat", "round.txt"])).stdout).toBe("r1\nr2\n");
  } finally {
    if (env.ITEST_KEEP !== "1") {
      await ws.destroy();
      await environment.destroy();
    }
  }
});
