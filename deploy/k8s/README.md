# Deploy on one k3s node

Conventions (shared with the infra runbook): namespace `factory`, k3s Traefik with ACME resolver `le`, StorageClass `local-path`, Postgres at `postgres.factory.svc:5432`, LiteLLM at `http://litellm.factory.svc:4000`.

1. **Image.** `ghcr.io/nisarahamedk/openfactory:<sha>`, built from the root `Dockerfile` by CI. One image runs every process; the container `args` pick it:
   - `apps/server/dist/main.js` (server)
   - `apps/dashboard/dist/main.js`
   - `plugins/metrics-dxfake/dist/main.js` (fake DX)

   If the package is private, add an `imagePullSecrets` entry or import the image with `k3s ctr images import`.
2. **Secrets** (created by infra; names only here, never values):

   | Secret | Keys |
   |---|---|
   | `postgres` | `DATABASE_URL` |
   | `github` | `GITHUB_TOKEN` |
   | `litellm` | `LITELLM_FACTORY_KEY` |
   | `dxfake` | `DXFAKE_TOKEN` |
   | `dashboard` | `DASHBOARD_PASSWORD` |
   | `factory-api` | `FACTORY_API_TOKEN` (random; protects `/v1`, which is public through the ingress) |

3. **IP and tag.** In `kustomization.yaml`, set `VM_IP` (dashed, e.g. `5-75-1-2`) and `newTag`.
4. `kubectl apply -k deploy/k8s`

The URLs are:
- `https://factory.<ip>.sslip.io`: the server and GitHub webhooks.
- `https://dashboard.<ip>.sslip.io`: basic auth, user `factory`.
- `https://dx.<ip>.sslip.io`: the fake DX. `/` is a summary; `/api/*` needs the token.

One PVC, `factory-data`, holds the server's `/data` (including `/data/bench`, the benchmark suite) and the fake DX's `/data/dx`.
