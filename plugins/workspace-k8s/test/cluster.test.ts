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
  (r) => { appendFileSync("/work/mock/requests.log", JSON.stringify({ tools: r.hasTools, toolResult: r.lastIsToolResult, last: r.lastUserText.slice(-200), n: r.messages.length }) + String.fromCharCode(10)); return null; },
  // Each round: the prompt gets one tool call, anything after it gets a summary.
  (r) => r.lastUserText.includes("ROUND1") && !r.transcript.includes("ROUND2")
    ? [{ type: "tool_use", name: "Bash", input: { command: "kubectl get pods -o name > pods.txt; kubectl -n default get pods > forbidden.txt 2>&1; echo r1 > round.txt", description: "check env" } }] : null,
  (r) => r.lastUserText.includes("ROUND2")
    ? [{ type: "tool_use", name: "Bash", input: { command: "echo r2 >> round.txt", description: "round 2" } }] : null,
  (r) => r.transcript.includes("ROUND2")
    ? [{ type: "text", text: r.transcript.includes("ROUND1") ? "remembered ROUND1" : "forgot ROUND1" }] : null,
  (r) => [{ type: "text", text: "round done" }],
], 18080).then(() => console.log("mock ready"));
`;
}

/** Waits until the mock model answers inside the pod. */
async function waitForMock(ws: { exec(cmd: string[]): Promise<{ exitCode: number }> }): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const probe = await ws.exec(["curl", "-fsS", "-o", "/dev/null", "-X", "POST", "http://127.0.0.1:18080/v1/messages/count_tokens", "-d", "{}"]);
    if (probe.exitCode === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The mock model did not start in the workspace pod");
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
    // Secrets listed in ENV_COPY_SECRETS are in the task namespace, readable by the agent.
    for (const item of (env.ENV_COPY_SECRETS ?? "").split(",").filter((v) => v.trim() !== "")) {
      const name = item.trim().split("/")[1] ?? "";
      const copied = await ws.exec(["kubectl", "--kubeconfig", "/work/home/.kube/config", "get", "secret", name, "-o", "name"]);
      expect(copied.stdout.trim(), copied.stderr).toBe(`secret/${name}`);
    }
    const skill = await ws.exec(["cat", "/work/home/.claude/skills/factory-environment/SKILL.md"]);
    expect(skill.stdout).toContain(environment.name);

    await ws.writeFile("/work/mock/mock.mjs", mockRunner());
    const mock = await ws.spawn(["sh", "-c", "exec node /work/mock/mock.mjs >>/work/mock/mock.log 2>&1"], { cwd: "/work/mock" });
    await waitForMock(ws);

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
    const mock2 = await ws.spawn(["sh", "-c", "exec node /work/mock/mock.mjs >>/work/mock/mock.log 2>&1"], { cwd: "/work/mock" });
    await waitForMock(ws);

    // The transcript must have survived the pod being deleted and recreated.
    const transcript = await ws.exec(["sh", "-c", `ls /work/home/.claude/projects/*/${sessionId}.jsonl`]);
    expect(transcript.exitCode, transcript.stderr).toBe(0);
    const s2 = await harness.openSession({ workspace: ws, cwd: ws.repoPath, systemPrompt: "itest", resumeSessionId: sessionId, env: envVars });
    const t2 = await s2.prompt("ROUND2", () => undefined);
    await s2.close();
    await mock2.kill();
    expect(t2.summary).toContain("remembered ROUND1");
    expect((await ws.exec(["cat", "round.txt"])).stdout).toBe("r1\nr2\n");
  } catch (error) {
    // Show what the model saw, so a failure in the pod can be read from the job log.
    console.log("mock requests:\n" + (await ws.exec(["sh", "-c", "echo --- mock.log; cat /work/mock/mock.log 2>&1; echo --- requests.log; cat /work/mock/requests.log 2>&1; echo --- transcripts; ls -la /work/home/.claude/projects/* 2>&1; echo --- node; node -v; which claude-agent-acp"])).stdout);
    throw error;
  } finally {
    if (env.ITEST_KEEP !== "1") {
      await ws.destroy();
      await environment.destroy();
    }
  }
});
