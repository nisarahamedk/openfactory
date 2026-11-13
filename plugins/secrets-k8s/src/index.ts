/**
 * Secrets from one Kubernetes Secret (each key is a secret name). The usual
 * choice when an org syncs its vault into the cluster (External Secrets,
 * Vault Agent). Values are static, so issued git tokens have expiresAt null.
 */
import * as k8s from "@kubernetes/client-node";
import { SecretNotFound, type IssuedSecret, type SecretRequest, type Secrets } from "@openfactory/contracts";
import { gitTokenNames } from "./git-token-names.js";

export interface K8sSecretsOptions {
  kubeConfig: k8s.KubeConfig;
  namespace: string;
  /** The Secret whose keys are the secrets. */
  secretName: string;
  gitTokenName: string;
}

export class K8sSecrets implements Secrets {
  readonly name = "k8s";
  private readonly core: k8s.CoreV1Api;

  constructor(private readonly options: K8sSecretsOptions) {
    this.core = options.kubeConfig.makeApiClient(k8s.CoreV1Api);
  }

  async get(name: string): Promise<string> {
    // Read on every call: a rotated value is picked up without a restart.
    const secret = await this.core.readNamespacedSecret({ name: this.options.secretName, namespace: this.options.namespace });
    const encoded = secret.data?.[name];
    if (encoded === undefined) throw new SecretNotFound(name, `k8s:${this.options.namespace}/${this.options.secretName}`);
    return Buffer.from(encoded, "base64").toString("utf8");
  }

  async issue(request: SecretRequest): Promise<IssuedSecret> {
    for (const name of gitTokenNames(request.repo, this.options.gitTokenName)) {
      try {
        return { value: await this.get(name), expiresAt: null };
      } catch (error) {
        if (!(error instanceof SecretNotFound)) throw error;
      }
    }
    throw new SecretNotFound(this.options.gitTokenName, `k8s:${this.options.namespace}/${this.options.secretName}`);
  }
}

type Env = Record<string, string | undefined>;

/** Builds the provider from settings. See README.md. */
export function fromEnv(env: Env): K8sSecrets {
  const kubeConfig = new k8s.KubeConfig();
  if (env.KUBECONFIG !== undefined && env.KUBECONFIG !== "") kubeConfig.loadFromFile(env.KUBECONFIG);
  else kubeConfig.loadFromCluster();
  const namespace = env.SECRETS_K8S_NAMESPACE;
  const secretName = env.SECRETS_K8S_SECRET;
  if (namespace === undefined || namespace === "" || secretName === undefined || secretName === "") {
    throw new Error("secrets-k8s needs SECRETS_K8S_NAMESPACE and SECRETS_K8S_SECRET");
  }
  return new K8sSecrets({ kubeConfig, namespace, secretName, gitTokenName: env.SECRETS_GIT_TOKEN_NAME ?? "GITHUB_TOKEN" });
}

export const createK8sSecrets = (options: K8sSecretsOptions): K8sSecrets => new K8sSecrets(options);
