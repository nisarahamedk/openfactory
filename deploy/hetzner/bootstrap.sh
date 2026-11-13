#!/bin/bash
# Installs the factory platform on a fresh VM made by create-vm.sh: namespaces, generated
# Secrets, Postgres, LiteLLM (with the $60 virtual key). Safe to re-run: existing Secrets are kept.
# Needs: KUBECONFIG pointing at the cluster, the vault helper (vault.sh) for ANTHROPIC_API_KEY.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); root=$(cd "$here/../.." && pwd)
rand() { python3 -c "import secrets;print(secrets.token_urlsafe(32))"; }
kubectl apply -f "$root/deploy/platform/namespaces.yaml"
has() { kubectl -n factory get secret "$1" >/dev/null 2>&1; }
if ! has postgres; then
  pw=$(rand)
  kubectl -n factory create secret generic postgres \
    --from-literal=POSTGRES_PASSWORD="$pw" \
    --from-literal=DATABASE_URL="postgres://factory:$pw@postgres.factory.svc:5432/factory" \
    --from-literal=LITELLM_DATABASE_URL="postgres://factory:$pw@postgres.factory.svc:5432/litellm" >/dev/null
fi
if ! has litellm; then
  kubectl -n factory create secret generic litellm \
    --from-literal=ANTHROPIC_API_KEY="$("$here/vault.sh" get ANTHROPIC_API_KEY)" \
    --from-literal=LITELLM_MASTER_KEY="sk-$(rand)" >/dev/null
fi
for s in dxfake:DXFAKE_TOKEN dashboard:DASHBOARD_PASSWORD factory-api:FACTORY_API_TOKEN; do
  has "${s%%:*}" || kubectl -n factory create secret generic "${s%%:*}" --from-literal="${s##*:}=$(rand)" >/dev/null
done
kubectl apply -f "$root/deploy/platform/postgres.yaml" -f "$root/deploy/platform/litellm.yaml" \
  -f "$root/deploy/platform/network-policies.yaml"
# The boot-time debug page is only for when the API isn't reachable yet; take it down now.
kubectl -n kube-system delete pod/debug-page svc/debug-page ingressroute/debug-page --ignore-not-found >/dev/null
kubectl -n factory rollout status statefulset/postgres --timeout=300s
kubectl -n factory rollout status deploy/litellm --timeout=600s
# The factory's own key: hard $60 budget on top of the proxy-wide cap.
if ! kubectl -n factory get secret litellm -o jsonpath='{.data.LITELLM_FACTORY_KEY}' | grep -q .; then
  mk=$(kubectl -n factory get secret litellm -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d)
  key=$(kubectl -n factory exec deploy/litellm -- python3 -c "
import json,urllib.request
r=urllib.request.Request('http://localhost:4000/key/generate',method='POST',
  data=json.dumps({'key_alias':'factory','max_budget':60,'models':['claude-sonnet','claude-sonnet-5-5','claude-haiku','claude-haiku-5-5','mock']}).encode(),
  headers={'Authorization':'Bearer $mk','content-type':'application/json'})
print(json.load(urllib.request.urlopen(r))['key'])")
  kubectl -n factory patch secret litellm -p "{\"stringData\":{\"LITELLM_FACTORY_KEY\":\"$key\"}}" >/dev/null
fi
echo "platform ready"
