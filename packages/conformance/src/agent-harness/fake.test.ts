import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempDirWorkspace } from "../workspace/fake.js";
import { makeOriginRepo } from "../workspace/origin.js";
import { ScriptedAgentHarness } from "./fake.js";
import { describeAgentHarnessConformance } from "./suite.js";

describeAgentHarnessConformance("ScriptedAgentHarness (fake)", async () => {
  const origin = makeOriginRepo();
  const root = mkdtempSync(join(tmpdir(), "of-agent-"));
  const workspace = await new TempDirWorkspace({ root, cloneUrl: () => origin.path, baseEnv: {} }).create({
    taskId: "task_cfagent",
    repo: { host: "github", owner: "acme", name: "app" },
    branch: "factory/cf",
    image: null,
  });
  return {
    subject: new ScriptedAgentHarness(),
    workspace,
    cwd: workspace.repoPath,
    cleanup: async () => {
      origin.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
});
