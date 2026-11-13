import { defineProvider } from "@openfactory/contracts";
import { fromEnv } from "./index.js";
import { envWithOptions } from "./options.js";

/**
 * factory.yaml: `workspace: { k8s: { namespace: factory-workspaces, image: ghcr.io/org/worker:1 } }`.
 * Each option falls back to its env var (WORKSPACE_NAMESPACE, WORKER_IMAGE...). The clone token is a
 * secret: WORKSPACE_GIT_TOKEN, or the env var named by `gitTokenEnv`.
 */
export const provider = defineProvider({
  name: "k8s",
  provides: {
    workspace: (ctx) =>
      fromEnv(
        envWithOptions(
          "k8s",
          ctx,
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
          },
          { gitTokenEnv: "WORKSPACE_GIT_TOKEN" },
        ),
      ),
  },
});
