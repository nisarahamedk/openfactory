import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempDirWorkspace } from "./fake.js";
import { makeOriginRepo } from "./origin.js";
import { describeWorkspaceConformance } from "./suite.js";

describeWorkspaceConformance("TempDirWorkspace (fake)", async () => {
  const origin = makeOriginRepo();
  const root = mkdtempSync(join(tmpdir(), "of-ws-"));
  return {
    subject: new TempDirWorkspace({ root, cloneUrl: () => origin.path, baseEnv: {} }),
    repo: { host: "github", owner: "acme", name: "app" },
    olderCommit: origin.olderCommit,
    cleanup: async () => {
      origin.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
});
