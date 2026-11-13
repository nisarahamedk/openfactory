/**
 * Drives the real Claude Code ACP adapter against the mock model: a first turn
 * writes a file, then a second process resumes the SAME session (as a review
 * round would) and the model sees the first turn's history.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { LocalWorkspace } from "@openfactory/workspace-local";
import type { AgentUpdate } from "@openfactory/contracts";
import { claudeCodeHarness } from "../src/index.js";
import { startMockAnthropic, type MockAnthropic } from "../src/mock-anthropic.js";

const adapterBin = resolve(import.meta.dirname, "../node_modules/.bin/claude-agent-acp");
let mock: MockAnthropic;
let root: string;
let origin: string;

beforeAll(async () => {
  mock = await startMockAnthropic([
    // Review round: only answer "remembered" if the first turn is in the history.
    (req) => {
      if (!req.lastUserText.includes("ROUND2")) return null;
      return [{ type: "tool_use", name: "Bash", input: { command: "echo world >> hello.txt", description: "append" } }];
    },
    (req) => {
      if (!req.lastIsToolResult || !req.transcript.includes("ROUND2")) return null;
      return [{ type: "text", text: req.transcript.includes("ROUND1") ? "remembered ROUND1" : "forgot ROUND1" }];
    },
    (req) => {
      if (!req.lastUserText.includes("ROUND1")) return null;
      return [{ type: "tool_use", name: "Bash", input: { command: "echo hello > hello.txt", description: "create" } }];
    },
    (req) => (req.lastIsToolResult && req.transcript.includes("ROUND1") ? [{ type: "text", text: "created hello.txt" }] : null),
  ]);
  root = mkdtempSync(join(tmpdir(), "of-acp-"));
  origin = join(root, "origin");
  execFileSync("git", ["init", "-q", "-b", "main", origin]);
  writeFileSync(join(origin, "README.md"), "demo\n");
  execFileSync("git", ["-C", origin, "add", "."]);
  execFileSync("git", ["-C", origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
});

afterAll(async () => {
  await mock.close();
});

test("a resumed session keeps the conversation", { timeout: 180_000 }, async () => {
  const workspaces = new LocalWorkspace({ root: join(root, "ws"), cloneUrl: () => origin, baseEnv: {} });
  const ws = await workspaces.create({
    taskId: "task_1",
    repo: { host: "github", owner: "acme", name: "demo" },
    branch: "factory/task_1",
    image: null,
  });
  const logs: string[] = [];
  const harness = claudeCodeHarness({
    model: "claude-sonnet-5-5",
    modelProxyUrl: mock.url,
    modelProxyKey: "mock-key",
    configDir: null,
    command: [adapterBin],
    log: (l) => logs.push(l),
  });

  const first = await harness.openSession({ workspace: ws, cwd: ws.repoPath, systemPrompt: "You are a factory worker.", resumeSessionId: null, env: {} });
  const updates: AgentUpdate[] = [];
  const turn1 = await first.prompt("ROUND1: create hello.txt", (u) => updates.push(u));
  const sessionId = first.sessionId;
  await first.close();

  expect(turn1.stopReason).toBe("end_turn");
  expect(turn1.summary).toContain("created hello.txt");
  expect(updates.some((u) => u.kind === "tool_call")).toBe(true);
  expect(readFileSync(join(ws.repoPath, "hello.txt"), "utf8")).toBe("hello\n");

  const second = await harness.openSession({ workspace: ws, cwd: ws.repoPath, systemPrompt: "You are a factory worker.", resumeSessionId: sessionId, env: {} });
  const turn2 = await second.prompt("ROUND2: reviewer asks to add world", () => undefined);
  await second.close();

  expect(second.sessionId).toBe(sessionId);
  expect(turn2.summary).toContain("remembered ROUND1");
  expect(readFileSync(join(ws.repoPath, "hello.txt"), "utf8")).toBe("hello\nworld\n");
  // The system prompt we appended reached the model.
  expect(mock.requests.some((r) => r.system.includes("You are a factory worker."))).toBe(true);
  // Nothing from the host's own agent setup leaks into the worker's context.
  expect(mock.requests.some((r) => r.transcript.includes("claude.ai/code/session_"))).toBe(false);
});
