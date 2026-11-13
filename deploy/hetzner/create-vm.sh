#!/bin/bash
# Creates the single factory VM (and its firewall) on Hetzner. Idempotent by name.
# Needs: HCLOUD_TOKEN, KUBE_TOKEN_FILE (the static admin token baked into cloud-init).
set -euo pipefail
NAME=${NAME:-slopware-factory}
TYPE=${TYPE:-cpx32}         # 4 vCPU / 8 GB / 160 GB, ~EUR 0.067/h (cx43, cpx41 were not orderable 2026-11-13)
LOC=${LOC:-fsn1}
API=https://api.hetzner.cloud/v1
h() { curl -sS -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'content-type: application/json' "$@"; }
dir=$(cd "$(dirname "$0")" && pwd)

fw=$(h "$API/firewalls?name=$NAME" | jq -r '.firewalls[0].id // empty')
if [ -z "$fw" ]; then
  fw=$(h -X POST "$API/firewalls" -d "$(jq -n --arg n "$NAME" '{name:$n, rules:[
    {direction:"in",protocol:"tcp",port:"80",source_ips:["0.0.0.0/0","::/0"]},
    {direction:"in",protocol:"tcp",port:"443",source_ips:["0.0.0.0/0","::/0"]},
    {direction:"in",protocol:"icmp",source_ips:["0.0.0.0/0","::/0"]}]}')" | jq -r .firewall.id)
fi
existing=$(h "$API/servers?name=$NAME" | jq -r '.servers[0].id // empty')
if [ -n "$existing" ]; then echo "server exists: $existing"; exit 0; fi
ud=$(sed "s|__KUBE_TOKEN__|$(cat "$KUBE_TOKEN_FILE")|" "$dir/cloud-init.yaml.tpl")
h -X POST "$API/servers" -d "$(jq -n --arg n "$NAME" --arg t "$TYPE" --arg l "$LOC" --arg ud "$ud" --argjson fw "$fw" \
  '{name:$n, server_type:$t, location:$l, image:"ubuntu-24.04", user_data:$ud, firewalls:[{firewall:$fw}],
    labels:{owner:"slopware-factory"}, public_net:{enable_ipv4:true, enable_ipv6:true}}')" \
  | jq '{id:.server.id, ip:.server.public_net.ipv4.ip, status:.server.status, error}'
