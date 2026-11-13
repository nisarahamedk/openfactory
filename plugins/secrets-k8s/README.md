# @openfactory/secrets-k8s

`Secrets` from one Kubernetes Secret: each key is a secret name. Use it when the org already syncs its vault into the
cluster (External Secrets Operator, Vault Agent, sealed secrets). The Secret is read on every call, so rotated values
apply without a restart.

- `get(name)` returns the key's value; a missing key throws `SecretNotFound`.
- `issue({ kind: "git", repo })` returns `GITHUB_TOKEN_<OWNER>_<REPO>` if present, else `GITHUB_TOKEN`. Static: `expiresAt` null.

| Variable | Required | Meaning |
|---|---|---|
| `SECRETS_K8S_NAMESPACE` | yes | Namespace of the Secret. |
| `SECRETS_K8S_SECRET` | yes | Name of the Secret. |
| `KUBECONFIG` | no | Default: in-cluster service account (needs `get` on that Secret). |
| `SECRETS_GIT_TOKEN_NAME` | no | Default `GITHUB_TOKEN`. |
