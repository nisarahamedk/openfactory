/**
 * An environment per task: one Kubernetes namespace the agent deploys the
 * product into with DevSpace, and tests against.
 *
 * The agent gets a kubeconfig that can only touch its own namespace, with a
 * short-lived token minted fresh each time the workspace is (re)prepared.
 * Sleep scales the namespace's workloads to zero; wake puts them back.
 */
import * as k8s from "@kubernetes/client-node";
import type { Environment, EnvironmentHandle, RepoRef, TaskId } from "@openfactory/contracts";
import { renderSkill } from "./skill.js";

export interface DevspaceEnvironmentOptions {
  kubeConfig: k8s.KubeConfig;
  /** API server URL as seen from inside a workspace pod. */
  inClusterServer: string;
  /** Namespace names are `${prefix}${task number}`. */
  namespacePrefix: string;
  /** Where the product is reachable; `{namespace}` is replaced. */
  appUrlTemplate: string;
  /** Lifetime of the agent's kubeconfig token. */
  tokenTtlSeconds: number;
  /** $HOME inside the workspace, where the kubeconfig and skill go. */
  workspaceHome: string;
  /** ResourceQuota for each task namespace. */
  quota: { cpu: string; memory: string; pods: string };
  /** Extra lines appended to the skill (team-specific know-how). */
  skillNotes: string;
  /** Secrets copied into every task namespace on create, e.g. app dev keys. */
  copySecrets: Array<{ namespace: string; name: string }>;
  /** Extra env vars for the agent (e.g. FACTORY_DOMAIN the repo's devspace.yaml reads). */
  agentVars: Record<string, string>;
  /** How the agent deploys; `{namespace}` replaced. */
  deployCommand: string;
}

const MANAGED = { "app.kubernetes.io/managed-by": "openfactory" };
const AGENT_SA = "agent";
const REPLICAS_ANNOTATION = "openfactory.dev/replicas-before-sleep";

/** `task_7f3a` → `task-7f3a` (Kubernetes names: lowercase, digits, dashes). */
export function namespaceFor(prefix: string, taskId: TaskId): string {
  const suffix = taskId.replace(/^task_/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${prefix}${suffix}`.slice(0, 63);
}

export class DevspaceEnvironment implements Environment {
  readonly name = "devspace";
  private readonly core: k8s.CoreV1Api;
  private readonly rbac: k8s.RbacAuthorizationV1Api;

  constructor(private readonly options: DevspaceEnvironmentOptions) {
    this.core = options.kubeConfig.makeApiClient(k8s.CoreV1Api);
    this.rbac = options.kubeConfig.makeApiClient(k8s.RbacAuthorizationV1Api);
  }

  async create(input: { taskId: TaskId; repo: RepoRef }): Promise<EnvironmentHandle> {
    const namespace = namespaceFor(this.options.namespacePrefix, input.taskId);
    const labels = { ...MANAGED, "openfactory.dev/task": input.taskId };
    await ignoreConflict(() => this.core.createNamespace({ body: { metadata: { name: namespace, labels } } }));
    await ignoreConflict(() =>
      this.core.createNamespacedResourceQuota({
        namespace,
        body: {
          metadata: { name: "task-quota", labels: MANAGED },
          spec: {
            hard: {
              "limits.cpu": this.options.quota.cpu,
              "limits.memory": this.options.quota.memory,
              pods: this.options.quota.pods,
            },
          },
        },
      }),
    );
    // Without defaults, the quota would reject every pod that omits limits.
    await ignoreConflict(() =>
      this.core.createNamespacedLimitRange({
        namespace,
        body: {
          metadata: { name: "task-defaults", labels: MANAGED },
          spec: {
            limits: [
              {
                type: "Container",
                _default: { cpu: "1", memory: "1Gi" },
                defaultRequest: { cpu: "100m", memory: "256Mi" },
              },
            ],
          },
        },
      }),
    );
    await ignoreConflict(() =>
      this.core.createNamespacedServiceAccount({ namespace, body: { metadata: { name: AGENT_SA, labels: MANAGED } } }),
    );
    await ignoreConflict(() =>
      this.rbac.createNamespacedRole({
        namespace,
        body: {
          metadata: { name: "agent", labels: MANAGED },
          rules: [
            {
              apiGroups: [""],
              resources: ["pods", "pods/log", "pods/exec", "pods/portforward", "services", "configmaps", "secrets", "persistentvolumeclaims", "events", "endpoints"],
              verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
            },
            { apiGroups: ["apps"], resources: ["deployments", "deployments/scale", "statefulsets", "replicasets"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
            { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
            { apiGroups: ["networking.k8s.io"], resources: ["ingresses"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
          ],
        },
      }),
    );
    await ignoreConflict(() =>
      this.rbac.createNamespacedRoleBinding({
        namespace,
        body: {
          metadata: { name: "agent", labels: MANAGED },
          roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "agent" },
          subjects: [{ kind: "ServiceAccount", name: AGENT_SA, namespace }],
        },
      }),
    );
    for (const source of this.options.copySecrets) await this.copySecret(source, namespace);
    return this.handle(namespace, input.taskId);
  }

  /** Copies a Secret into the task namespace, replacing an older copy so values stay current. */
  private async copySecret(source: { namespace: string; name: string }, namespace: string): Promise<void> {
    const original = await this.core.readNamespacedSecret({ name: source.name, namespace: source.namespace });
    const body: k8s.V1Secret = {
      metadata: { name: source.name, labels: { ...MANAGED, "openfactory.dev/copied-from": source.namespace } },
      type: original.type ?? "Opaque",
      data: original.data ?? {},
    };
    try {
      await this.core.createNamespacedSecret({ namespace, body });
    } catch (error) {
      if (statusCode(error) !== 409) throw error;
      await this.core.replaceNamespacedSecret({ name: source.name, namespace, body });
    }
  }

  async get(name: string): Promise<EnvironmentHandle | null> {
    try {
      const ns = await this.core.readNamespace({ name });
      // Only namespaces this environment made, and not one already being deleted.
      const task = ns.metadata?.labels?.["openfactory.dev/task"];
      if (task === undefined || ns.metadata?.deletionTimestamp !== undefined) return null;
      return this.handle(name, task);
    } catch (error) {
      if (statusCode(error) === 404) return null;
      throw error;
    }
  }

  private handle(namespace: string, taskId: string): EnvironmentHandle {
    return new DevspaceEnvironmentHandle(namespace, taskId, this.options, this.core);
  }
}

class DevspaceEnvironmentHandle implements EnvironmentHandle {
  private readonly apps: k8s.AppsV1Api;

  constructor(
    readonly name: string,
    private readonly taskId: string,
    private readonly options: DevspaceEnvironmentOptions,
    private readonly core: k8s.CoreV1Api,
  ) {
    this.apps = options.kubeConfig.makeApiClient(k8s.AppsV1Api);
  }

  private get appUrl(): string {
    return this.options.appUrlTemplate.replaceAll("{namespace}", this.name);
  }

  private get kubeconfigPath(): string {
    return `${this.options.workspaceHome}/.kube/config`;
  }

  async credentialsForWorkspace(): Promise<Array<{ path: string; content: string }>> {
    const token = await this.core.createNamespacedServiceAccountToken({
      name: AGENT_SA,
      namespace: this.name,
      body: { spec: { expirationSeconds: this.options.tokenTtlSeconds, audiences: [] } },
    });
    const caMap = await this.core.readNamespacedConfigMap({ name: "kube-root-ca.crt", namespace: this.name });
    const ca = caMap.data?.["ca.crt"];
    if (ca === undefined || token.status?.token === undefined) {
      throw new Error(`Could not build a kubeconfig for namespace ${this.name}: missing CA or token`);
    }
    const kubeconfig = [
      "apiVersion: v1",
      "kind: Config",
      "clusters:",
      `- name: factory`,
      `  cluster:`,
      `    server: ${this.options.inClusterServer}`,
      `    certificate-authority-data: ${Buffer.from(ca).toString("base64")}`,
      "users:",
      `- name: agent`,
      `  user:`,
      `    token: ${token.status.token}`,
      "contexts:",
      `- name: ${this.name}`,
      `  context: { cluster: factory, user: agent, namespace: ${this.name} }`,
      `current-context: ${this.name}`,
      "",
    ].join("\n");
    return [
      { path: this.kubeconfigPath, content: kubeconfig },
      { path: `${this.options.workspaceHome}/.claude/skills/factory-environment/SKILL.md`, content: await this.skill() },
    ];
  }

  async envVars(): Promise<Record<string, string>> {
    return {
      ...this.options.agentVars,
      KUBECONFIG: this.kubeconfigPath,
      FACTORY_ENV_NAMESPACE: this.name,
      FACTORY_ENV_URL: this.appUrl,
      FACTORY_ENV_NAME: `devspace:${this.name}`,
      FACTORY_EVIDENCE_DIR: `${this.options.workspaceHome}/evidence`,
      DEVSPACE_NAMESPACE: this.name,
    };
  }

  async skill(): Promise<string> {
    return renderSkill({
      namespace: this.name,
      appUrl: this.appUrl,
      environmentName: `devspace:${this.name}`,
      evidenceDir: `${this.options.workspaceHome}/evidence`,
      taskId: this.taskId,
      notes: this.options.skillNotes,
      deployCommand: this.options.deployCommand.replaceAll("{namespace}", this.name),
    });
  }

  async sleep(): Promise<void> {
    await this.scaleAll((current, annotations) => ({
      replicas: 0,
      annotations: current === 0 ? annotations : { ...annotations, [REPLICAS_ANNOTATION]: String(current) },
    }));
  }

  async wake(): Promise<void> {
    await this.scaleAll((_current, annotations) => {
      const before = annotations[REPLICAS_ANNOTATION];
      if (before === undefined) return null;
      const { [REPLICAS_ANNOTATION]: _dropped, ...rest } = annotations;
      return { replicas: Number(before), annotations: rest };
    });
  }

  async destroy(): Promise<void> {
    try {
      await this.core.deleteNamespace({ name: this.name });
    } catch (error) {
      if (statusCode(error) !== 404) throw error;
    }
  }

  /** Applies `next` to every Deployment and StatefulSet; null leaves one as is. */
  private async scaleAll(
    next: (current: number, annotations: Record<string, string>) => { replicas: number; annotations: Record<string, string> } | null,
  ): Promise<void> {
    const deployments = await this.apps.listNamespacedDeployment({ namespace: this.name });
    for (const d of deployments.items) {
      const change = next(d.spec?.replicas ?? 1, d.metadata?.annotations ?? {});
      if (change === null || d.metadata?.name === undefined) continue;
      await this.apps.replaceNamespacedDeployment({
        name: d.metadata.name,
        namespace: this.name,
        body: { ...d, metadata: { ...d.metadata, annotations: change.annotations }, spec: { ...d.spec!, replicas: change.replicas } },
      });
    }
    const sets = await this.apps.listNamespacedStatefulSet({ namespace: this.name });
    for (const s of sets.items) {
      const change = next(s.spec?.replicas ?? 1, s.metadata?.annotations ?? {});
      if (change === null || s.metadata?.name === undefined) continue;
      await this.apps.replaceNamespacedStatefulSet({
        name: s.metadata.name,
        namespace: this.name,
        body: { ...s, metadata: { ...s.metadata, annotations: change.annotations }, spec: { ...s.spec!, replicas: change.replicas } },
      });
    }
  }
}

function statusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { code?: unknown; statusCode?: unknown };
  if (typeof e.code === "number") return e.code;
  if (typeof e.statusCode === "number") return e.statusCode;
  return null;
}

/** Creating something that already exists is fine: create() must be safe to run twice. */
async function ignoreConflict(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (error) {
    if (statusCode(error) !== 409) throw error;
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") throw new Error(`env-devspace needs ${key}`);
  return value;
}

/** Builds the environment plugin from settings. See README.md for the variables. */
export function fromEnv(env: Env): DevspaceEnvironment {
  const kubeConfig = new k8s.KubeConfig();
  if (env.KUBECONFIG !== undefined && env.KUBECONFIG !== "") kubeConfig.loadFromFile(env.KUBECONFIG);
  else kubeConfig.loadFromCluster();
  return new DevspaceEnvironment({
    kubeConfig,
    inClusterServer: env.ENV_K8S_SERVER ?? "https://kubernetes.default.svc",
    namespacePrefix: env.ENV_NAMESPACE_PREFIX ?? "task-",
    appUrlTemplate: required(env, "ENV_APP_URL_TEMPLATE"),
    tokenTtlSeconds: Number(env.ENV_TOKEN_TTL_SECONDS ?? "28800"),
    workspaceHome: env.ENV_WORKSPACE_HOME ?? "/work/home",
    quota: {
      cpu: env.ENV_QUOTA_CPU ?? "3",
      memory: env.ENV_QUOTA_MEMORY ?? "4Gi",
      pods: env.ENV_QUOTA_PODS ?? "20",
    },
    skillNotes: env.ENV_SKILL_NOTES ?? "",
    copySecrets: parseList(env.ENV_COPY_SECRETS).map((item) => {
      const [namespace, name] = item.split("/");
      if (namespace === undefined || name === undefined || name === "") {
        throw new Error(`env-devspace: ENV_COPY_SECRETS entries are <namespace>/<name>, got "${item}"`);
      }
      return { namespace, name };
    }),
    agentVars: Object.fromEntries(
      parseList(env.ENV_AGENT_VARS).map((item) => {
        const at = item.indexOf("=");
        if (at <= 0) throw new Error(`env-devspace: ENV_AGENT_VARS entries are KEY=value, got "${item}"`);
        return [item.slice(0, at), item.slice(at + 1)];
      }),
    ),
    deployCommand: env.ENV_DEPLOY_COMMAND ?? "devspace deploy --namespace {namespace}",
  });
}

function parseList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((v) => v.trim()).filter((v) => v !== "");
}

export const createDevspaceEnvironment = (options: DevspaceEnvironmentOptions): DevspaceEnvironment =>
  new DevspaceEnvironment(options);
export { renderSkill } from "./skill.js";
export { provider } from "./provider.js";
