"""Aggregate the proxy's access log per (task, host, allowed, minute) and post it to the factory.

Source pod IPs are mapped to tasks with the openfactory.dev/task label on workspace pods.
Reports for a minute are sent once the minute is over; failed posts are retried next round.
"""
import json, os, ssl, time, urllib.request
from urllib.parse import urlsplit

LOG = "/var/log/egress/access.log"
NS = os.environ.get("WORKSPACE_NAMESPACE", "factory-workspaces")
FACTORY = os.environ["FACTORY_URL"].rstrip("/")
TOKEN = os.environ["FACTORY_API_TOKEN"]
SA = "/var/run/secrets/kubernetes.io/serviceaccount"
API = "https://kubernetes.default.svc"
ctx = ssl.create_default_context(cafile=f"{SA}/ca.crt")

def pods_by_ip():
    req = urllib.request.Request(f"{API}/api/v1/namespaces/{NS}/pods?labelSelector=openfactory.dev/task",
                                 headers={"Authorization": "Bearer " + open(f"{SA}/token").read().strip()})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
        items = json.load(r)["items"]
    return {p["status"].get("podIP"): p["metadata"]["labels"]["openfactory.dev/task"] for p in items if p["status"].get("podIP")}

def host_of(method, url):
    if method == "CONNECT":
        return url.rsplit(":", 1)[0]
    return urlsplit(url).hostname or url

def post(entries):
    body = json.dumps({"entries": entries}).encode()
    req = urllib.request.Request(f"{FACTORY}/v1/egress", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status

def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))

while not os.path.exists(LOG):
    time.sleep(1)
f = open(LOG)
buckets = {}   # (ip, host, allowed, minute) -> count
pending = []   # entries waiting to be posted
ips = {}
last_flush = 0
while True:
    line = f.readline()
    if line:
        parts = line.split()
        if len(parts) >= 5 and parts[3] != "-":  # "-" = probe connections that sent nothing
            ts, ip, status, method, url = float(parts[0]), parts[1], parts[2], parts[3], parts[4]
            allowed = not status.startswith("TCP_DENIED")
            key = (ip, host_of(method, url), allowed, int(ts // 60) * 60)
            buckets[key] = buckets.get(key, 0) + 1
        continue
    time.sleep(1)
    now = time.time()
    if now - last_flush < 15:
        continue
    last_flush = now
    done = [k for k in buckets if k[3] + 60 <= now]
    if done:
        try:
            ips = pods_by_ip()
        except Exception as e:
            print("pod lookup failed:", e, flush=True)
        for k in done:
            ip, host, allowed, minute = k
            count = buckets.pop(k)
            task = ips.get(ip)
            if task is None:
                print(f"untracked source {ip} -> {host} allowed={allowed} count={count}", flush=True)
                continue
            pending.append({"taskId": task, "host": host, "allowed": allowed, "count": count,
                            "from": iso(minute), "to": iso(minute + 60)})
    if pending:
        try:
            post(pending[:500])
            pending = pending[500:]
        except Exception as e:
            print("post failed (will retry):", e, flush=True)
            pending = pending[-5000:]
