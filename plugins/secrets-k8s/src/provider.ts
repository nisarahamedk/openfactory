import { defineProvider } from "@openfactory/contracts";
import { fromEnv } from "./index.js";
import { envWithOptions } from "./options.js";

/**
 * factory.yaml: `secrets: { k8s: { namespace: factory, secret: factory-secrets } }`
 * (env SECRETS_K8S_NAMESPACE, SECRETS_K8S_SECRET as fallback).
 */
export const provider = defineProvider({
  name: "k8s",
  provides: {
    secrets: (ctx) =>
      fromEnv(
        envWithOptions("k8s", ctx, {
          kubeconfig: "KUBECONFIG",
          namespace: "SECRETS_K8S_NAMESPACE",
          secret: "SECRETS_K8S_SECRET",
          gitTokenName: "SECRETS_GIT_TOKEN_NAME",
        }),
      ),
  },
});
