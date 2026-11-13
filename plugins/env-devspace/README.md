# @openfactory/env-devspace

One Kubernetes namespace per task (`task-<id>`). The agent deploys the product there with DevSpace and tests against it.

- `create`: namespace, ResourceQuota + LimitRange, ServiceAccount `agent`, Role + RoleBinding limited to that namespace.
- `credentialsForWorkspace`: a kubeconfig with a fresh short-lived token (TokenRequest), and the skill file at
  `$HOME/.claude/skills/factory-environment/SKILL.md`. Call it again after every wake to refresh the token.
- `envVars`: `KUBECONFIG`, `FACTORY_ENV_NAMESPACE`, `FACTORY_ENV_URL`, `FACTORY_ENV_NAME`, `FACTORY_EVIDENCE_DIR`, `DEVSPACE_NAMESPACE`.
- `skill`: how to deploy (`devspace deploy`), test (Playwright against the env URL) and leave evidence
  (`$HOME/evidence/manifest.json`: `[{kind, title, file, commitSha, environment}]`).
- `sleep` scales Deployments and StatefulSets to 0 (remembering replicas); `wake` restores them. `destroy` deletes the namespace.

The repo must carry a `devspace.yaml` that deploys the product into the current namespace, with an Ingress on the URL below.

## Settings (`fromEnv`)

| Variable | Required | Meaning |
|---|---|---|
| `ENV_APP_URL_TEMPLATE` | yes | Product URL, `{namespace}` replaced, e.g. `https://{namespace}.1.2.3.4.sslip.io`. |
| `KUBECONFIG` | no | Default: in-cluster service account. |
| `ENV_K8S_SERVER` | no | API server URL as seen from workspace pods, default `https://kubernetes.default.svc`. |
| `ENV_NAMESPACE_PREFIX` | no | Default `task-`. |
| `ENV_TOKEN_TTL_SECONDS` | no | Default 28800 (8h). |
| `ENV_WORKSPACE_HOME` | no | Default `/work/home` (matches workspace-k8s). |
| `ENV_QUOTA_CPU`, `ENV_QUOTA_MEMORY`, `ENV_QUOTA_PODS` | no | Default `3`, `4Gi`, `20`. |
| `ENV_SKILL_NOTES` | no | Extra markdown for the skill (repo-specific know-how). |

RBAC the factory needs: namespaces (get, create, delete); in task namespaces: serviceaccounts (create), serviceaccounts/token (create),
configmaps (get), resourcequotas and limitranges (create), roles and rolebindings (create), deployments and statefulsets (list, update),
plus every permission the agent Role grants (Kubernetes refuses to grant what the granter lacks).
