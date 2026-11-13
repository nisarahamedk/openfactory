/**
 * The Workspace conformance suite on a real cluster (same settings as cluster.test.ts):
 *   RUN_CLUSTER_TESTS=1 WORKER_IMAGE=... WORKSPACE_NAMESPACE=... pnpm --filter @openfactory/workspace-k8s test
 * ITEST_OLDER_COMMIT names a non-head commit of the test repo to check startRef.
 */
import { test } from "vitest";
import { describeWorkspaceConformance } from "@openfactory/conformance";
import { fromEnv } from "../src/index.js";

const env = process.env;
if (env.RUN_CLUSTER_TESTS === "1") {
  describeWorkspaceConformance(
    "workspace-k8s",
    async () => ({
      subject: fromEnv(env),
      repo: { host: "github", owner: env.ITEST_REPO_OWNER ?? "octocat", name: env.ITEST_REPO_NAME ?? "Hello-World" },
      olderCommit: env.ITEST_OLDER_COMMIT ?? null,
      cleanup: async () => {},
    }),
    { timeoutMs: 600_000 },
  );
} else {
  test.skip("Workspace conformance on a cluster (set RUN_CLUSTER_TESTS=1)", () => {});
}
