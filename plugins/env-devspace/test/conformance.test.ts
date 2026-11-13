/**
 * The DevEnvironment conformance suite on a real cluster:
 *   RUN_CLUSTER_TESTS=1 ENV_APP_URL_TEMPLATE=https://{namespace}.example.dev pnpm --filter @openfactory/env-devspace test
 */
import { test } from "vitest";
import { describeDevEnvironmentConformance } from "@openfactory/conformance";
import { fromEnv } from "../src/index.js";

const env = process.env;
if (env.RUN_CLUSTER_TESTS === "1") {
  describeDevEnvironmentConformance(
    "env-devspace",
    async () => ({
      subject: fromEnv({ ...env, ENV_APP_URL_TEMPLATE: env.ENV_APP_URL_TEMPLATE ?? "http://{namespace}.invalid" }),
      repo: { host: "github", owner: "acme", name: "app" },
      cleanup: async () => {},
    }),
    { timeoutMs: 300_000 },
  );
} else {
  test.skip("DevEnvironment conformance on a cluster (set RUN_CLUSTER_TESTS=1)", () => {});
}
