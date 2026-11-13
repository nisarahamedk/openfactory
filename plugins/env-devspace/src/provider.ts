import { defineProvider } from "@openfactory/contracts";
import { fromEnv } from "./index.js";
import { envWithOptions } from "./options.js";

/**
 * factory.yaml:
 *   devEnvironment:
 *     devspace:
 *       appUrlTemplate: https://{namespace}.example.dev
 *       deployCommand: devspace dev -n {namespace}
 *       copySecrets: [factory/app-dev]
 *       agentVars: { APP_DOMAIN: example.dev }
 * Each option falls back to its env var (ENV_APP_URL_TEMPLATE, ENV_DEPLOY_COMMAND, ENV_COPY_SECRETS...).
 */
export const provider = defineProvider({
  name: "devspace",
  provides: {
    devEnvironment: (ctx) =>
      fromEnv(
        envWithOptions("devspace", ctx, {
          kubeconfig: "KUBECONFIG",
          appUrlTemplate: "ENV_APP_URL_TEMPLATE",
          k8sServer: "ENV_K8S_SERVER",
          namespacePrefix: "ENV_NAMESPACE_PREFIX",
          tokenTtlSeconds: "ENV_TOKEN_TTL_SECONDS",
          workspaceHome: "ENV_WORKSPACE_HOME",
          quotaCpu: "ENV_QUOTA_CPU",
          quotaMemory: "ENV_QUOTA_MEMORY",
          quotaPods: "ENV_QUOTA_PODS",
          skillNotes: "ENV_SKILL_NOTES",
          copySecrets: "ENV_COPY_SECRETS",
          agentVars: "ENV_AGENT_VARS",
          deployCommand: "ENV_DEPLOY_COMMAND",
        }),
      ),
  },
});
