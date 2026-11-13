/**
 * A workspace that is one pod plus one volume in a Kubernetes namespace.
 *
 * Layout on the volume (mounted at /work):
 *   /work/repo   the checkout (the agent's cwd)
 *   /work/home   $HOME: Claude Code's config and session
 *                transcripts, evidence/. Kept across sleep, so a woken
 *                workspace resumes the same agent session.
 *
 * The clone happens in an init container that reads a GitHub token from a
 * short-lived Secret; the agent's container never holds a GitHub credential
 * (the origin URL has none, and nothing is written to $HOME). Pushes go
 * through the factory, not the sandbox.
 *
 * Sleep deletes the pod and keeps the volume; wake makes the pod again.
 * Commands run through the Kubernetes exec API, so the factory needs no
 * network path into the pod and the pod needs no open port.
 */
import { PassThrough, Readable, Writable } from "node:stream";
import * as k8s from "@kubernetes/client-node";
import type { RepoRef, TaskId, Workspace, WorkspaceHandle } from "@openfactory/contracts";

export interface K8sWorkspaceOptions {
  kubeConfig: k8s.KubeConfig;
  /** Namespace that holds every task's workspace pod and volume. */
  namespace: string;
  /** Worker image: git, node, the ACP agent, devspace, kubectl, Playwright. */
  image: string;
  /** Volume size, e.g. "10Gi". */
  storageSize: string;
  /** Storage class; null uses the cluster default. */
  storageClassName: string | null;
  /** Token used to clone; the job later writes its own short-lived push token. */
  cloneToken: (repo: RepoRef) => Promise<string | null>;
  /** CPU/memory requests and limits for the pod. */
  resources: { cpu: string; memory: string; cpuLimit: string; memoryLimit: string };
  /** Runtime class (e.g. "gvisor") for stronger isolation; null for the default. */
  runtimeClassName: string | null;
  /** How long to wait for a pod to start. */
  startTimeoutMs: number;
  /** Extra env for every container in the pod (clone and agent), e.g. the egress proxy settings. */
  podEnv?: Record<string, string>;
}

const WORK = "/work";
const REPO = `${WORK}/repo`;
const HOME = `${WORK}/home`;
const CONTAINER = "workspace";

/** Kubernetes names allow lowercase letters, digits and dashes only. */
function resourceName(taskId: string): string {
  return `ws-${taskId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 63);
}

export class K8sWorkspace implements Workspace {
  readonly name = "k8s";
  private readonly core: k8s.CoreV1Api;

  constructor(private readonly options: K8sWorkspaceOptions) {
    this.core = options.kubeConfig.makeApiClient(k8s.CoreV1Api);
  }

  async create(input: {
    taskId: TaskId;
    repo: RepoRef;
    branch: string;
    image: string | null;
    startRef?: string | null;
  }): Promise<WorkspaceHandle> {
    const name = resourceName(input.taskId);
    await this.ensureVolume(name, input.taskId);
    const token = await this.options.cloneToken(input.repo);
    const secretName = `${name}-git`.slice(0, 63);
    if (token !== null) await this.putTokenSecret(secretName, input.taskId, token);
    const handle = this.handle(name, input.image ?? this.options.image, input.taskId, {
      repoUrl: `https://github.com/${input.repo.owner}/${input.repo.name}.git`,
      branch: input.branch,
      startRef: input.startRef ?? "",
      tokenSecret: secretName,
    });
    try {
      await handle.wake();
    } finally {
      // The token is only needed while the init container clones.
      if (token !== null) await this.deleteSecret(secretName);
    }
    return handle;
  }

  private async putTokenSecret(name: string, taskId: string, token: string): Promise<void> {
    const body: k8s.V1Secret = {
      metadata: { name, labels: { "openfactory.dev/task": taskId, "app.kubernetes.io/managed-by": "openfactory" } },
      type: "Opaque",
      stringData: { GITHUB_TOKEN: token },
    };
    try {
      await this.core.createNamespacedSecret({ namespace: this.options.namespace, body });
    } catch (error) {
      if (!isConflict(error)) throw error;
      await this.core.replaceNamespacedSecret({ name, namespace: this.options.namespace, body });
    }
  }

  private async deleteSecret(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedSecret({ name, namespace: this.options.namespace });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async get(id: string): Promise<WorkspaceHandle | null> {
    try {
      const claim = await this.core.readNamespacedPersistentVolumeClaim({ name: id, namespace: this.options.namespace });
      const taskId = claim.metadata?.labels?.["openfactory.dev/task"] ?? id;
      const image = claim.metadata?.annotations?.["openfactory.dev/image"] ?? this.options.image;
      return this.handle(id, image, taskId);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private handle(name: string, image: string, taskId: string, clone: CloneSpec | null = null): K8sWorkspaceHandle {
    return new K8sWorkspaceHandle(name, this.options, this.core, image, taskId, clone);
  }

  private async ensureVolume(name: string, taskId: string): Promise<void> {
    try {
      await this.core.createNamespacedPersistentVolumeClaim({
        namespace: this.options.namespace,
        body: {
          metadata: { name, labels: { "openfactory.dev/task": taskId, "app.kubernetes.io/managed-by": "openfactory" } },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: this.options.storageSize } },
            ...(this.options.storageClassName === null ? {} : { storageClassName: this.options.storageClassName }),
          },
        },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
  }
}

/** A command the workspace ran exited non-zero. */
export class CommandFailed extends Error {
  readonly code = "command_failed" as const;
  constructor(
    readonly cmd: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`Command failed with exit code ${exitCode}: ${cmd.join(" ")}\n${stderr.slice(-2000)}`);
  }
}

/** The workspace pod did not become ready in time. */
export class WorkspaceStartTimeout extends Error {
  readonly code = "workspace_start_timeout" as const;
  constructor(readonly pod: string, readonly phase: string) {
    super(`Workspace pod ${pod} did not start in time (phase ${phase})`);
  }
}

/** What the init container clones when the volume has no checkout yet. */
interface CloneSpec {
  repoUrl: string;
  branch: string;
  /** Commit or ref to start from (benchmark replays); empty for the default branch. */
  startRef: string;
  /** Secret holding GITHUB_TOKEN; optional, so a missing Secret means an anonymous clone. */
  tokenSecret: string;
}

/**
 * Runs in the init container. Clones only if the volume has no checkout, so a
 * wake after sleep keeps the agent's work. The token goes in a one-off header,
 * never into the repo's config or the volume.
 */
export const CLONE_SCRIPT = `set -eu
mkdir -p ${HOME}
if [ -d ${REPO}/.git ]; then echo "checkout present"; exit 0; fi
if [ -z "\${REPO_URL:-}" ]; then echo "no checkout and nothing to clone" >&2; exit 1; fi
AUTH=""
if [ -n "\${GITHUB_TOKEN:-}" ]; then AUTH="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"; fi
git -c "http.extraHeader=$AUTH" clone "$REPO_URL" ${REPO}
cd ${REPO}
if [ -n "\${START_REF:-}" ]; then
  git -c "http.extraHeader=$AUTH" fetch origin "$START_REF" || true
  git checkout --quiet --detach "$START_REF" 2>/dev/null || git checkout --quiet --detach FETCH_HEAD
fi
if [ -z "\${START_REF:-}" ] && git rev-parse --verify --quiet "refs/remotes/origin/$TASK_BRANCH" >/dev/null; then
  git checkout --quiet -B "$TASK_BRANCH" "origin/$TASK_BRANCH"
else
  git checkout --quiet -B "$TASK_BRANCH"
fi
git config --unset-all http.extraHeader || true
echo "cloned $REPO_URL at $(git rev-parse HEAD) on $TASK_BRANCH"
`;

class K8sWorkspaceHandle implements WorkspaceHandle {
  readonly repoPath = REPO;
  private readonly exec_: k8s.Exec;
  private spawnSeq = 0;

  constructor(
    readonly id: string,
    private readonly options: K8sWorkspaceOptions,
    private readonly core: k8s.CoreV1Api,
    private readonly image: string,
    private readonly taskId: string,
    private readonly clone: CloneSpec | null,
  ) {
    this.exec_ = new k8s.Exec(options.kubeConfig);
  }

  async exec(
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const out = new Writable({ write: (chunk: Buffer, _enc, done) => ((stdout += chunk.toString()), done()) });
    const err = new Writable({ write: (chunk: Buffer, _enc, done) => ((stderr += chunk.toString()), done()) });
    const stdin = opts.stdin === undefined ? null : Readable.from([Buffer.from(opts.stdin)]);
    const full = this.wrap(cmd, opts.cwd, opts.env, opts.timeoutMs);
    const exitCode = await new Promise<number>((resolve, reject) => {
      this.exec_
        .exec(this.options.namespace, this.id, CONTAINER, full, out, err, stdin, false, (status) => resolve(exitCodeOf(status)))
        .then((ws) => ws.on("error", reject))
        .catch(reject);
    });
    return { exitCode, stdout, stderr };
  }

  async mustExec(cmd: string[], opts: { cwd?: string; timeoutMs?: number; stdin?: string } = {}): Promise<string> {
    const result = await this.exec(cmd, opts);
    if (result.exitCode !== 0) throw new CommandFailed(cmd, result.exitCode, result.stderr);
    return result.stdout;
  }

  async spawn(
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string> } = {},
  ): Promise<{
    stdin: WritableStream<Uint8Array>;
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(): Promise<void>;
  }> {
    const pidFile = `/tmp/openfactory-spawn-${process.pid}-${++this.spawnSeq}.pid`;
    // Record the pid so kill() can stop the process even if the exec stream is gone.
    const inner = this.wrap(cmd, opts.cwd, opts.env, undefined);
    const full = ["sh", "-c", `echo $$ > ${pidFile}; exec "$@"`, "sh", ...inner];
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stderr.resume(); // drained so the agent never blocks on a full pipe
    let socketClosed: () => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      socketClosed = () => resolve(1);
      this.exec_
        .exec(this.options.namespace, this.id, CONTAINER, full, stdout, stderr, stdin, false, (status) => resolve(exitCodeOf(status)))
        .then((ws) => {
          ws.on("close", () => {
            stdout.end();
            socketClosed();
          });
        })
        .catch(() => socketClosed());
    });
    return {
      stdin: Writable.toWeb(stdin) as WritableStream<Uint8Array>,
      stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      exited,
      kill: async () => {
        await this.exec(["sh", "-c", `test -f ${pidFile} && kill $(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile}; true`], { cwd: WORK });
        stdin.end();
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      },
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = path.startsWith("/") ? path : `${REPO}/${path}`;
    await this.mustExec(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", full], { cwd: WORK, stdin: content });
  }

  async sleep(): Promise<void> {
    try {
      await this.core.deleteNamespacedPod({ name: this.id, namespace: this.options.namespace, gracePeriodSeconds: 5 });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.waitFor(async () => (await this.readPod()) === null, "deleted");
  }

  async wake(): Promise<void> {
    const pod = await this.readPod();
    if (pod?.metadata?.deletionTimestamp !== undefined && pod?.metadata?.deletionTimestamp !== null) {
      await this.waitFor(async () => (await this.readPod()) === null, "deleted");
    }
    if ((await this.readPod()) === null) {
      try {
        await this.core.createNamespacedPod({ namespace: this.options.namespace, body: this.podSpec() });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    await this.waitFor(async () => {
      const current = await this.readPod();
      const phase = current?.status?.phase ?? "Pending";
      if (phase === "Failed" || phase === "Succeeded") throw new WorkspaceStartTimeout(this.id, phase);
      return current?.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") === true;
    }, "ready");
  }

  async destroy(): Promise<void> {
    await this.sleep();
    try {
      await this.core.deleteNamespacedPersistentVolumeClaim({ name: this.id, namespace: this.options.namespace });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /** Runs `cmd` in `cwd` with extra env, and a time limit when given. */
  private wrap(cmd: string[], cwd: string | undefined, env: Record<string, string> | undefined, timeoutMs: number | undefined): string[] {
    const vars = Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);
    const limit = timeoutMs === undefined ? [] : ["timeout", `${Math.ceil(timeoutMs / 1000)}s`];
    return ["env", "-C", cwd ?? REPO, ...vars, ...limit, ...cmd];
  }

  private podEnv(): k8s.V1EnvVar[] {
    return Object.entries(this.options.podEnv ?? {}).map(([name, value]) => ({ name, value }));
  }

  private podSpec(): k8s.V1Pod {
    const { resources } = this.options;
    return {
      metadata: {
        name: this.id,
        labels: { "openfactory.dev/task": this.taskId, "app.kubernetes.io/managed-by": "openfactory", "app.kubernetes.io/component": "workspace" },
      },
      spec: {
        restartPolicy: "Always",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...(this.options.runtimeClassName === null ? {} : { runtimeClassName: this.options.runtimeClassName }),
        terminationGracePeriodSeconds: 5,
        initContainers: [
          {
            name: "clone",
            image: this.image,
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-c", CLONE_SCRIPT],
            workingDir: WORK,
            env: [
              { name: "HOME", value: "/tmp" }, // nothing the clone writes to $HOME lands on the volume
              { name: "REPO_URL", value: this.clone?.repoUrl ?? "" },
              { name: "TASK_BRANCH", value: this.clone?.branch ?? "" },
              { name: "START_REF", value: this.clone?.startRef ?? "" },
              ...this.podEnv(),
              ...(this.clone === null
                ? []
                : [{ name: "GITHUB_TOKEN", valueFrom: { secretKeyRef: { name: this.clone.tokenSecret, key: "GITHUB_TOKEN", optional: true } } }]),
            ],
            resources: {
              requests: { cpu: resources.cpu, memory: "256Mi" },
              limits: { cpu: resources.cpuLimit, memory: "1Gi" },
            },
            volumeMounts: [{ name: "work", mountPath: WORK }],
          },
        ],
        containers: [
          {
            name: CONTAINER,
            image: this.image,
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-c", `mkdir -p ${HOME} && touch ${HOME}/.ready && exec sleep infinity`],
            workingDir: WORK,
            env: [
              { name: "HOME", value: HOME },
              { name: "CLAUDE_CONFIG_DIR", value: `${HOME}/.claude` },
              { name: "OPENFACTORY_TASK", value: this.taskId },
              ...this.podEnv(),
            ],
            readinessProbe: { exec: { command: ["test", "-f", `${HOME}/.ready`] }, periodSeconds: 1 },
            resources: {
              requests: { cpu: resources.cpu, memory: resources.memory },
              limits: { cpu: resources.cpuLimit, memory: resources.memoryLimit },
            },
            volumeMounts: [{ name: "work", mountPath: WORK }, { name: "shm", mountPath: "/dev/shm" }],
          },
        ],
        volumes: [
          { name: "work", persistentVolumeClaim: { claimName: this.id } },
          // Chromium needs more shared memory than the default 64Mi for Playwright.
          { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
        ],
      },
    };
  }

  private async readPod(): Promise<k8s.V1Pod | null> {
    try {
      return await this.core.readNamespacedPod({ name: this.id, namespace: this.options.namespace });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + this.options.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new WorkspaceStartTimeout(this.id, `not ${what}`);
  }
}

function exitCodeOf(status: k8s.V1Status): number {
  if (status.status === "Success") return 0;
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
  return cause?.message === undefined ? 1 : Number(cause.message);
}

function statusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { code?: unknown; statusCode?: unknown };
  if (typeof e.code === "number") return e.code;
  if (typeof e.statusCode === "number") return e.statusCode;
  return null;
}

const isNotFound = (error: unknown): boolean => statusCode(error) === 404;
const isConflict = (error: unknown): boolean => statusCode(error) === 409;

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value === "") throw new Error(`workspace-k8s needs ${key}`);
  return value;
}

/**
 * Builds the workspace plugin from settings. See README.md for the variables.
 * In a pod it uses the pod's service account; elsewhere KUBECONFIG.
 */
export function fromEnv(env: Env): K8sWorkspace {
  const kubeConfig = new k8s.KubeConfig();
  if (env.KUBECONFIG !== undefined && env.KUBECONFIG !== "") kubeConfig.loadFromFile(env.KUBECONFIG);
  else kubeConfig.loadFromCluster();
  const cloneToken = env.WORKSPACE_GIT_TOKEN;
  return new K8sWorkspace({
    kubeConfig,
    namespace: required(env, "WORKSPACE_NAMESPACE"),
    image: required(env, "WORKER_IMAGE"),
    storageSize: env.WORKSPACE_STORAGE ?? "10Gi",
    storageClassName: env.WORKSPACE_STORAGE_CLASS ?? null,
    cloneToken: async () => cloneToken ?? null,
    resources: {
      cpu: env.WORKSPACE_CPU ?? "500m",
      memory: env.WORKSPACE_MEMORY ?? "2Gi",
      cpuLimit: env.WORKSPACE_CPU_LIMIT ?? "2",
      memoryLimit: env.WORKSPACE_MEMORY_LIMIT ?? "6Gi",
    },
    runtimeClassName: env.WORKSPACE_RUNTIME_CLASS ?? null,
    startTimeoutMs: Number(env.WORKSPACE_START_TIMEOUT_MS ?? "300000"),
    podEnv: parsePodEnv(env.WORKSPACE_POD_ENV),
  });
}

export const createK8sWorkspace = (options: K8sWorkspaceOptions): K8sWorkspace => new K8sWorkspace(options);

/**
 * WORKSPACE_POD_ENV is a JSON object of extra env vars for the workspace pod's containers, e.g.
 * {"HTTPS_PROXY":"http://egress-proxy.factory-egress.svc:3128","NO_PROXY":".svc,.cluster.local"}.
 */
function parsePodEnv(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKSPACE_POD_ENV must be a JSON object of string values");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string") throw new Error(`WORKSPACE_POD_ENV.${k} must be a string`);
    out[k] = v;
  }
  return out;
}
