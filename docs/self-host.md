# Self-host SlopwareFactory

This page installs the whole factory into your own Kubernetes cluster with one Helm chart (`deploy/helm/openfactory`). Nothing runs outside your cluster except the model provider and your code host.

## What gets installed

| Piece | What it does | Notes |
|---|---|---|
| Server | Watches your repos, runs tasks, and keeps the ledger and evidence | 1 replica; a PVC holds evidence and benchmarks |
| Dashboard | Runs, metrics and transcripts | Basic auth (user `factory`) |
| Postgres | Ledger plus LiteLLM's key store | Optional; bring your own with `postgres.enabled=false` |
| LiteLLM | Model gateway. Holds provider keys, gives each task its own capped key | Proxy-wide budget is `litellm.budgetUsd` |
| Egress proxy + collector | Sandboxes reach the internet only through an allowlist. Every request is logged on its task | Squid, deny by default |
| NetworkPolicies | Sandboxes can reach only DNS, the proxy, the model gateway and the Kubernetes API | Needs a CNI that enforces NetworkPolicy |
| RBAC | Server creates a sandbox pod per task, plus a namespace per task environment | ClusterRole, see `templates/rbac.yaml` |

A task runs like this:

1. A labelled issue arrives.
2. The server creates a sandbox pod in `workspaces.namespace`. It clones the repo with the GitHub token in an init container, so the agent container never holds that token.
3. The agent (Claude Code over ACP) works, pushes a branch and opens a PR. It uses a per-task repo token and a per-task model key.
4. The agent validates its change and attaches evidence.
5. The task waits for review.

## 10-minute quickstart (k3s or kind)

You need:
- a cluster whose CNI enforces NetworkPolicy. k3s does this out of the box. On kind, install Calico, because kind's default CNI ignores policies.
- `helm` 3.12 or later.
- a GitHub fine-grained token for the repos you want worked on:
  - Contents, Issues, Pull requests: read and write
  - Actions, Commit statuses: read
- an Anthropic API key.

```bash
kubectl create namespace factory

# 1. Your two secrets. The chart only ever references them by name.
kubectl -n factory create secret generic openfactory-github --from-literal=GITHUB_TOKEN="$GITHUB_TOKEN"
kubectl -n factory create secret generic openfactory-anthropic --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"

# 2. Install
helm install factory deploy/helm/openfactory -n factory \
  --set 'repos={acme/app}' \
  --set publicUrl=http://localhost:3000 \
  --set 'networkPolicy.ingressControllerNamespaceSelector.matchLabels.kubernetes\.io/metadata\.name=kube-system'

# 3. Open the dashboard
kubectl -n factory get secret factory-generated -o jsonpath='{.data.DASHBOARD_PASSWORD}' | base64 -d; echo
kubectl -n factory port-forward svc/factory-dashboard 8080
```

Then add the label `factory` to an issue in `acme/app`. The task shows up on the dashboard within a poll interval (20 s).

What the chart generates for you is stored in Secret `<release>-generated`. It is kept across upgrades and uninstalls:
- `FACTORY_API_TOKEN`: the bearer token for `/v1` and the egress collector;
- `LITELLM_MASTER_KEY`;
- `DASHBOARD_PASSWORD`.

## GitHub App (recommended)

With a GitHub App, each task's agent gets its own token, limited to the task's repos and valid for 1 hour. The server uses the app's installation token for its own calls. Without an app, the factory and every agent share one token. The start-up checks (`GET /v1/health`, and the factory app) say which mode is on.

1. Go to GitHub → your org → Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Fill in the basics:
   - Name: anything, such as `acme-factory`. Its comments show as `acme-factory[bot]`.
   - Homepage URL: the factory's URL.
   - Webhook: untick **Active**, unless you use `signals: webhook`.
3. Repository permissions:
   - **Contents, Issues, Pull requests:** Read and write.
   - **Checks, Commit statuses, Actions:** Read.
   - **Metadata:** Read.
4. Organization permissions: **Members** Read, only if you use GitHub teams as the directory.
5. Where can it be installed: **Only on this account**. Create it.
6. On the app's page:
   - Note the **App ID**.
   - Under **Private keys**, press **Generate a private key**. A `.pem` file downloads.
7. **Install App** → your org → **Only select repositories** → the factory's repos.
8. Store the two values as a Secret, then point the chart at it:

   ```bash
   kubectl -n factory create secret generic openfactory-github-app \
     --from-literal=GITHUB_APP_ID=123456 --from-file=GITHUB_APP_PRIVATE_KEY=./acme-factory.pem
   helm upgrade factory deploy/helm/openfactory -n factory --reuse-values \
     --set secrets.githubApp.name=openfactory-github-app --set secrets.github.name=
   ```

The app's installation for the first repo in `repos` serves the server's own calls. Each task token covers repos of one owner, so keep a task's repos under one org.

## Sign-in for the app

Without sign-in, the app has one shared password and a name picker. Anyone with the password can then act as anyone, so use that only in development. With sign-in, every task, message, stop, retry and rollout carries the person's real login, and roles limit who can do what:

| Role | Can |
|---|---|
| viewer | read everything, save views |
| engineer | also ask for tasks, write to them, stop and retry them, turn them into benchmarks |
| admin | also change factory rollouts and start paid benchmark runs |

Everyone who can sign in gets `defaultRole` (engineer), except the logins listed under `admins` or `viewers`.

**GitHub** (the login is the GitHub login, which matches who asked for tasks):

1. Go to GitHub → your org → Settings → Developer settings → OAuth Apps → **New OAuth App**.
2. Set Homepage URL to the app's URL, and Authorization callback URL to `<app URL>/auth/callback`.
3. Generate a client secret.

**OIDC** (Okta, Entra ID, Google, Keycloak, Dex):

1. Create a web client with redirect URI `<app URL>/auth/callback`.
2. Choose the claim that matches people's code-host logins (`oidcLoginClaim`). The part before any `@` is used.

Then install it:

```bash
kubectl -n factory create secret generic openfactory-dashboard-auth \
  --from-literal=AUTH_CLIENT_ID=... --from-literal=AUTH_CLIENT_SECRET=... \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)"
helm upgrade factory deploy/helm/openfactory -n factory --reuse-values \
  --set dashboard.auth.provider=github --set dashboard.auth.secret=openfactory-dashboard-auth \
  --set dashboard.auth.publicUrl=https://factory-app.example.com \
  --set dashboard.auth.githubOrg=acme --set 'dashboard.auth.admins={alice}'
```

## Configure

Everything is in `values.yaml`. The parts you will touch:

- **`factory:`** is rendered as `factory.yaml` (see docs/plugins.md). It chooses a provider for each abstraction and routes models. For example, issues labelled `ui`, `small`, `test`, `demo` or `docs` go to Haiku.
- **`egress.allow`:** add the package registries and hosts your repos need. Examples:
  - `pypi.org` and `files.pythonhosted.org`;
  - `proxy.golang.org`;
  - your web-font or auth hosts, for e2e screenshots.

  Denied requests show on the task timeline as `egress` events with `allowed: false`. Use them to tune the allowlist.
- **`environments.devspace`:** use this when your repos ship a `devspace.yaml`. Set `factory.providers.devEnvironment: devspace` and `appUrlTemplate` (e.g. `https://{namespace}.apps.example.com`, served by a wildcard ingress). To copy secrets the app needs into each task namespace, list them in `copySecrets` as `<namespace>/<name>`.
- **`litellm.models`:** set the model names, provider models and explicit prices. An explicit price keeps the budget accurate even when LiteLLM's price map doesn't know the model. Add more providers by adding their key Secret under `secrets.modelProviders`.
- **`limits.maxTaskUsd`:** the cap on each task's model key.

## Production checklist

- Pin `image.tag` and `workspaces.image` to commit SHAs.
- Expose the server with `ingress.enabled=true` and TLS. Webhooks (`signals.mode=webhook`) need the server reachable from GitHub, and polling doesn't.
- Use managed Postgres (`postgres.enabled=false`, `externalDatabase.*`). LiteLLM needs its own database.
- Turn on branch protection on `main` (require a PR and a review). The factory never merges; people do.
- Consider `workspaces.runtimeClassName: gvisor` (or Kata) for kernel isolation between sandboxes.

## Cloud notes

### EKS
- **NetworkPolicy:** turn on the VPC CNI's network policy agent (`enableNetworkPolicy: "true"` in the vpc-cni add-on) or run Calico. Without either, policies are silently ignored.
- **Kubernetes API from sandboxes:** the API endpoints are ENIs inside your VPC. The chart looks them up from `default/kubernetes` at install. They change when the control plane scales, so prefer `networkPolicy.kubeApi.cidrs` set to the cluster's VPC CIDR, on port 443.
- **Storage:** gp3 through the EBS CSI driver. Set `persistence.storageClass` and `workspaces.storageClass`.
- **Ingress:** AWS Load Balancer Controller. Set `ingress.className: alb` and point `ingressControllerNamespaceSelector` at `kube-system`.

### GKE
- **NetworkPolicy:** Dataplane V2 (the default on Autopilot and on new Standard clusters) enforces policies.
- **Kubernetes API:** the control plane has a fixed private endpoint. Find it with `gcloud container clusters describe ... --format='value(privateClusterConfig.privateEndpoint)'` and set `networkPolicy.kubeApi.cidrs: [<ip>/32]`, port 443.
- **Autopilot:** gVisor is available as `runtimeClassName: gvisor`. Autopilot also rejects privileged pods, which the chart doesn't use.
- **Ingress:** GKE Ingress, or Gateway API with your own route.

### AKS
- **NetworkPolicy:** create the cluster with `--network-policy azure|calico|cilium`.
- **Kubernetes API:** traffic leaves through the konnectivity tunnel to a public FQDN. Set `networkPolicy.kubeApi.cidrs` to the API server's IP, or use API Server VNet Integration and its subnet.
- **Storage:** `managed-csi`.

### Cilium (any cloud)
Cilium does not match traffic to the API server by `ipBlock`. Add a `CiliumNetworkPolicy` with `toEntities: [kube-apiserver]` for the workspaces namespace.

## Upgrade and uninstall

```bash
helm upgrade factory deploy/helm/openfactory -n factory -f my-values.yaml
helm uninstall factory -n factory   # keeps: generated Secret, Postgres PVC, workspaces namespace
```

## How it is verified

- `helm lint` passes.
- `helm install --dry-run=server` passes, so the API server has validated every object.
- The chart is installed fresh into a scratch namespace of a k3s cluster. There, the workspace (14) and dev-environment (8) cluster suites pass through its egress proxy and policies.
- From a sandbox pod:
  - **Blocked:** direct internet, a proxied request to a host not on the allowlist, Postgres, the server, and another release's gateway.
  - **Allowed:** GitHub through the proxy, the model gateway and the Kubernetes API.
