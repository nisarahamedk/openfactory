# @openfactory/workspace-k8s

A workspace is one pod plus one volume (PVC) in a namespace.

```
/work/repo   the checkout (agent cwd)
/work/home   $HOME: .git-credentials, .claude/ (session transcripts), .kube/, evidence/
```

- `create` makes the PVC and pod, sets `credential.helper store` with `$HOME/.git-credentials`,
  clones (`--filter=blob:none`, so `git fetch origin <sha>` works later) and checks out the branch.
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
| `WORKSPACE_GIT_TOKEN` | no | Token to clone private repos (the job later writes a per-task push token). |
| `WORKSPACE_STORAGE` / `WORKSPACE_STORAGE_CLASS` | no | Default `10Gi` / cluster default. |
| `WORKSPACE_CPU`, `WORKSPACE_MEMORY`, `WORKSPACE_CPU_LIMIT`, `WORKSPACE_MEMORY_LIMIT` | no | Default `500m`, `2Gi`, `2`, `6Gi`. |
| `WORKSPACE_RUNTIME_CLASS` | no | e.g. `gvisor`. |
| `WORKSPACE_START_TIMEOUT_MS` | no | Default 300000 (first image pull is slow). |

RBAC the factory needs in `WORKSPACE_NAMESPACE`: pods (get, list, create, delete), pods/exec (create), persistentvolumeclaims (get, create, delete).
