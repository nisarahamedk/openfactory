# @openfactory/workspace-k8s

A workspace is one pod plus one volume (PVC) in a namespace.

```
/work/repo   the checkout (agent cwd)
/work/home   $HOME: .claude/ (session transcripts), .kube/, evidence/
```

- `create` makes the PVC, a short-lived Secret with the clone token, and the pod. An **init container**
  clones the repo (token only in a one-off HTTP header), checks out `startRef` if given (benchmark replays),
  and creates the task branch. The Secret is deleted once the pod is up.
- **Clone credential stays out of the agent's container:** origin has no token in its URL and the Secret is
  gone. The agent's own credential is the per-task repo token the task job writes to `$HOME/.git-credentials`
  (and `GH_TOKEN` in the turn env) before each turn; the agent pushes and opens its PR with `git` and `gh`
  (docs/plugins.md, Sandbox security).
- **Egress:** with `WORKSPACE_EGRESS_PROXY`, both containers get `HTTP(S)_PROXY`/`http(s)_proxy`, `NO_PROXY`
  and `NODE_USE_ENV_PROXY=1`. The pod's `openfactory.dev/task` label attributes its requests to the task; the
  allowlist is passed on as the `openfactory.dev/egress-allow` annotation and `FACTORY_EGRESS_ALLOW`.
  NetworkPolicy (deploy config, not this plugin) blocks every other route out.
- `exec` / `spawn` / `writeFile` go through the Kubernetes exec API. No ports, no Services.
- `sleep` deletes the pod and keeps the PVC. `wake` makes the pod again; the session resumes from disk.
- `destroy` deletes pod and PVC and waits until the PVC is gone. `get` finds only PVCs this plugin made.
- The pod has no service account token, no service links, and an optional runtime class (gVisor).

Worker image: `image/Dockerfile` (Playwright 1.56.1 base and browsers, matching the product repo's pin + Node 22.21 + pnpm + Claude Code ACP adapter + kubectl + devspace + helm 3.11.1 + gh).

## Settings (`fromEnv`)

| Variable | Required | Meaning |
|---|---|---|
| `WORKSPACE_NAMESPACE` | yes | Namespace for workspace pods and PVCs. |
| `WORKER_IMAGE` | yes | Worker image reference. |
| `KUBECONFIG` | no | Path; default is the pod's in-cluster service account. |
| `WORKSPACE_GIT_TOKEN` | no | Token used only by the init container to clone private repos. Never reaches the agent. |
| `WORKSPACE_STORAGE` / `WORKSPACE_STORAGE_CLASS` | no | Default `10Gi` / cluster default. |
| `WORKSPACE_CPU`, `WORKSPACE_MEMORY`, `WORKSPACE_CPU_LIMIT`, `WORKSPACE_MEMORY_LIMIT` | no | Default `500m`, `2Gi`, `2`, `6Gi`. |
| `WORKSPACE_RUNTIME_CLASS` | no | e.g. `gvisor`. |
| `WORKSPACE_START_TIMEOUT_MS` | no | Default 300000 (first image pull is slow). |
| `WORKSPACE_EGRESS_PROXY` | no | e.g. `http://egress.factory.svc:3128`. Unset: no proxy variables. |
| `WORKSPACE_NO_PROXY` | no | Hosts reached directly. Default `localhost,127.0.0.1,::1`, so the kube API and the model gateway go through the proxy too. |
| `WORKSPACE_EGRESS_ALLOW` | no | Comma list; passed to the pod as an annotation and env. |

factory.yaml form: `workspace: { k8s: { namespace, image, egress: { proxy, noProxy, allow: [...] } } }`; each
option falls back to the variable above.

RBAC the factory needs in `WORKSPACE_NAMESPACE`: pods (get, list, create, delete), pods/exec (create), persistentvolumeclaims (get, create, delete), secrets (create, update, delete).
