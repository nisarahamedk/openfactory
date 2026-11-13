import { defineProvider } from "@openfactory/contracts";
import { fromEnv } from "./index.js";
import { envWithOptions } from "./options.js";

/**
 * factory.yaml:
 *   workspace:
 *     k8s:
 *       namespace: factory-workspaces
 *       image: ghcr.io/org/worker:1
 *       egress: { proxy: http://egress.factory.svc:3128, allow: [github.com, registry.npmjs.org] }
 * Each option falls back to its env var (WORKSPACE_NAMESPACE, WORKER_IMAGE, WORKSPACE_EGRESS_PROXY,
 * WORKSPACE_EGRESS_ALLOW...). The clone token is a secret: WORKSPACE_GIT_TOKEN, or the env var named
 * by `gitTokenEnv`.
 */
export const provider = defineProvider({
  name: "k8s",
  provides: {
    workspace: (ctx) => {
      // `egress` is a nested option; flatten it to the env names before the usual lookup.
      const { egress, ...rest } = ctx.options;
      const flat: Record<string, unknown> = { ...rest };
      if (egress !== undefined && egress !== null) {
        if (typeof egress !== "object" || Array.isArray(egress)) throw new Error("k8s: option egress is { proxy, noProxy, allow }");
        for (const [key, value] of Object.entries(egress)) {
          if (!["proxy", "noProxy", "allow"].includes(key)) throw new Error(`k8s: unknown option "egress.${key}" (known: allow, noProxy, proxy)`);
          flat[`egress.${key}`] = value;
        }
      }
      return fromEnv(
        envWithOptions(
          "k8s",
          { options: flat, env: ctx.env },
          {
            kubeconfig: "KUBECONFIG",
            namespace: "WORKSPACE_NAMESPACE",
            image: "WORKER_IMAGE",
            storage: "WORKSPACE_STORAGE",
            storageClass: "WORKSPACE_STORAGE_CLASS",
            cpu: "WORKSPACE_CPU",
            memory: "WORKSPACE_MEMORY",
            cpuLimit: "WORKSPACE_CPU_LIMIT",
            memoryLimit: "WORKSPACE_MEMORY_LIMIT",
            runtimeClass: "WORKSPACE_RUNTIME_CLASS",
            startTimeoutMs: "WORKSPACE_START_TIMEOUT_MS",
            "egress.proxy": "WORKSPACE_EGRESS_PROXY",
            "egress.noProxy": "WORKSPACE_NO_PROXY",
            "egress.allow": "WORKSPACE_EGRESS_ALLOW",
          },
          { gitTokenEnv: "WORKSPACE_GIT_TOKEN" },
        ),
      );
    },
  },
});
