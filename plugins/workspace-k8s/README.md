# @openfactory/workspace-k8s

A workspace is one pod plus one volume (PVC) in a namespace.

```
/work/repo   the checkout (agent cwd)
/work/home   $HOME: .claude/ (session transcripts), .kube/, evidence/
```

- `create` makes the PVC, a short-lived Secret with the clone token, and the pod. An **init container**
  clones the repo (token only in a one-off HTTP header), checks out `startRef` if given (benchmark replays),
  and creates the task branch. The Secret is deleted once the pod is up.
- **No GitHub credential in the agent's container:** origin has no token in its URL, nothing is written to
  `$HOME`, and the Secret is gone. The agent commits; the factory pushes (git bundle). Consequence: the agent
  cannot `git fetch` a private repo; the clone is full, so history and blobs are all local.
- `exec` / `spawn` / `writeFile` go through the Kubernetes exec API. No ports, no Services.
- `sleep` deletes the pod and keeps the PVC. `wake` makes the pod again; the session resumes from disk.
- `destroy` deletes pod and PVC.
- The pod has no service account token, no service links, and an optional runtime class (gVisor).

Worker image: `image/Dockerfile` (Playwright base + Node 22 + pnpm + Claude Code ACP adapter + kubectl + devspace).

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

RBAC the factory needs in `WORKSPACE_NAMESPACE`: pods (get, list, create, delete), pods/exec (create), persistentvolumeclaims (get, create, delete), secrets (create, update, delete).
