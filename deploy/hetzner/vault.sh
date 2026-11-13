#!/bin/bash
# Infisical helper (universal auth via INFISICAL_CLIENT_ID/SECRET), dev-vault env dev by default.
#   vault.sh get NAME          -> value on stdout; pipe it, never print it.
#   vault.sh set NAME < file   -> create or update NAME. Only factory-owned names
#                                 (FACTORY_*, LITELLM_*, DXFAKE_*, DASHBOARD_*) may be written.
set -euo pipefail
W=${INFISICAL_WORKSPACE_ID:-f66b8574-cfe0-4a38-b38c-1025303c62e0}
E=${INFISICAL_ENV:-dev}
case "$1" in get|set) ;; *) echo "usage: vault.sh get|set NAME" >&2; exit 2;; esac
T=$(curl -sS https://app.infisical.com/api/v1/auth/universal-auth/login -H 'content-type: application/json' \
  -d "{\"clientId\":\"$INFISICAL_CLIENT_ID\",\"clientSecret\":\"$INFISICAL_CLIENT_SECRET\"}" | jq -r .accessToken)
if [ "$1" = get ]; then
  curl -sS "https://app.infisical.com/api/v3/secrets/raw/$2?workspaceId=$W&environment=$E&secretPath=/" \
    -H "Authorization: Bearer $T" | jq -er .secret.secretValue
  exit
fi
[[ "$2" =~ ^(FACTORY|LITELLM|DXFAKE|DASHBOARD)_[A-Z0-9_]+$ ]] || { echo "refusing to write non-factory name $2" >&2; exit 2; }
body=$(jq -n --arg w "$W" --arg e "$E" --rawfile v /dev/stdin '{workspaceId:$w,environment:$e,secretPath:"/",secretValue:$v,type:"shared"}')
url="https://app.infisical.com/api/v3/secrets/raw/$2"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$url" -H "Authorization: Bearer $T" -H 'content-type: application/json' -d "$body")
[ "$code" = 200 ] || code=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$url" -H "Authorization: Bearer $T" -H 'content-type: application/json' -d "$body")
echo "set $2: HTTP $code"

