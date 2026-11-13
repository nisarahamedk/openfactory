import { defineProvider } from "@openfactory/contracts";
import { fromEnv } from "./index.js";
import { envWithOptions } from "./options.js";

/**
 * factory.yaml: `workspace: { local: { root: /var/lib/factory/tasks } }` (env WORKSPACE_ROOT as fallback).
 * The clone token is a secret: WORKSPACE_GIT_TOKEN, or the env var named by `gitTokenEnv`.
 */
export const provider = defineProvider({
  name: "local",
  provides: {
    workspace: (ctx) => fromEnv(envWithOptions("local", ctx, { root: "WORKSPACE_ROOT" }, { gitTokenEnv: "WORKSPACE_GIT_TOKEN" })),
  },
});
