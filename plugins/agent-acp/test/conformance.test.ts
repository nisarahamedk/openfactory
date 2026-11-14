/** The real Claude Code ACP adapter, against a mock model that plays the conformance model. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { conformanceReply, describeAgentHarnessConformance, makeOriginRepo } from "@openfactory/conformance";
import { LocalWorkspace } from "@openfactory/workspace-local";
import { claudeCodeHarness } from "../src/index.js";
import { startMockAnthropic } from "../src/mock-anthropic.js";

const adapterBin = resolve(import.meta.dirname, "../node_modules/.bin/claude-agent-acp");

describeAgentHarnessConformance(
  "agent-acp (Claude Code, mock model)",
  async () => {
    const mock = await startMockAnthropic([(req) => [{ type: "text", text: conformanceReply(`${req.system}\n${req.transcript}`) }]]);
    const origin = makeOriginRepo();
    const root = mkdtempSync(join(tmpdir(), "of-acp-cf-"));
    const workspace = await new LocalWorkspace({ root, cloneUrl: () => origin.path, baseEnv: {} }).create({
      taskId: "task_cfacp",
      repo: { host: "github", owner: "acme", name: "app" },
      branch: "factory/cf",
      image: null,
    });
    return {
      subject: claudeCodeHarness({
        model: "claude-sonnet-5-5",
        modelProxyUrl: mock.url,
        modelProxyKey: "mock-key",
        configDir: null,
        command: [adapterBin],
        log: () => undefined,
      }),
      workspace,
      cwd: workspace.repoPath,
      cleanup: async () => {
        await mock.close();
        origin.cleanup();
        // The agent process can still be writing its config files as it exits; retrying waits it out (ENOTEMPTY in CI).
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  },
  { timeoutMs: 120_000 },
);
