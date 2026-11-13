#cloud-config
# One-VM factory host. Everything comes up from this file: this repo's operators
# have no SSH path (cloud sessions cannot reach port 22), so the only way in
# afterwards is the Kubernetes API, published on https://k8s.<ip>.sslip.io
# behind Traefik with a Let's Encrypt certificate and a static bearer token.
# __KUBE_TOKEN__ is substituted by create-vm.sh from the vault; never commit it.
package_update: true
packages: [curl, jq, open-iscsi, certbot]
write_files:
  - path: /etc/sysctl.d/90-factory-inotify.conf
    content: |
      # Many dev servers (Vite) per node: each task environment watches its whole source tree.
      fs.inotify.max_user_watches=1048576
      fs.inotify.max_user_instances=8192
  - path: /etc/rancher/k3s/tokens.csv
    permissions: "0600"
    content: |
      __KUBE_TOKEN__,factory-admin,factory-admin,"system:masters"
  - path: /var/lib/rancher/k3s/server/manifests/traefik-config.yaml
    content: |
      apiVersion: helm.cattle.io/v1
      kind: HelmChartConfig
      metadata: { name: traefik, namespace: kube-system }
      spec:
        valuesContent: |-
          persistence: { enabled: true, size: 128Mi, path: /data }
          podSecurityContext: { fsGroup: 65532, fsGroupChangePolicy: OnRootMismatch }
          additionalArguments:
            - --certificatesresolvers.le.acme.httpchallenge=true
            - --certificatesresolvers.le.acme.httpchallenge.entrypoint=web
            - --certificatesresolvers.le.acme.storage=/data/acme.json
            - --providers.kubernetescrd.allowcrossnamespace=true
  - path: /usr/local/bin/factory-debug.sh
    permissions: "0755"
    content: |
      #!/bin/bash
      # Non-secret status dump, served at http://debug.<ip>.sslip.io/status.txt (no SSH here).
      mkdir -p /var/lib/factory-debug
      while true; do
        {
          date -u; echo "== boot"; tail -n 40 /var/log/factory-boot.log 2>/dev/null
          echo "== nodes/pods"; k3s kubectl get nodes,pods -A -o wide 2>&1
          echo "== events"; k3s kubectl get events -A --sort-by=.lastTimestamp 2>&1 | tail -n 30
          echo "== traefik"; k3s kubectl -n kube-system logs deploy/traefik --tail=60 2>&1
          echo "== helm-install-traefik"; k3s kubectl -n kube-system logs job/helm-install-traefik --tail=20 2>&1
        } > /var/lib/factory-debug/status.tmp 2>&1
        mv /var/lib/factory-debug/status.tmp /var/lib/factory-debug/status.txt
        # Cert watchdog: Let's Encrypt's first try can race the load balancer coming up.
        # If the API host still has no publicly valid cert, restart Traefik (it retries on start).
        IP=$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4)
        if k3s kubectl -n default get ingressroute kube-api >/dev/null 2>&1 \
           && ! curl -s -m 5 -o /dev/null "https://k8s.${IP}.sslip.io/readyz"; then
          n=$(( $(cat /var/lib/factory-debug/fails 2>/dev/null || echo 0) + 1 )); echo $n > /var/lib/factory-debug/fails
          # Delete (not rollout restart): a rolling restart keeps the old pod serving :80, and
          # Let's Encrypt then fetches the challenge from the pod that doesn't hold the token (404).
          if [ $((n % 6)) -eq 0 ]; then k3s kubectl -n kube-system delete pod -l app.kubernetes.io/name=traefik --wait=false; fi
        else echo 0 > /var/lib/factory-debug/fails; fi
        sleep 30
      done
  - path: /etc/systemd/system/factory-debug.service
    content: |
      [Unit]
      Description=factory debug page + cert watchdog
      After=network-online.target
      [Service]
      ExecStart=/usr/local/bin/factory-debug.sh
      Restart=always
      [Install]
      WantedBy=multi-user.target
  - path: /usr/local/bin/factory-boot.sh
    permissions: "0755"
    content: |
      #!/bin/bash
      set -euo pipefail
      IP=$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4)
      HOST="k8s.${IP}.sslip.io"
      # Fixed hosts get one Let's Encrypt cert from certbot BEFORE k3s binds :80. Traefik's own ACME
      # races its pod becoming Ready (LE times out or hits a stale pod), so it is only used later,
      # for per-task hosts, once Traefik is stable.
      NAMES="k8s factory dashboard dx debug registry"
      args=(); for n in $NAMES; do args+=(-d "$n.${IP}.sslip.io"); done
      for try in 1 2 3; do
        certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email \
          --cert-name factory "${args[@]}" && break; sleep 20; done
      curl -sfL https://get.k3s.io | INSTALL_K3S_CHANNEL=stable INSTALL_K3S_EXEC="server \
        --tls-san ${HOST} --write-kubeconfig-mode 600 \
        --kube-apiserver-arg=token-auth-file=/etc/rancher/k3s/tokens.csv" sh -
      until k3s kubectl get --raw /readyz >/dev/null 2>&1; do sleep 3; done
      if [ -f /etc/letsencrypt/live/factory/fullchain.pem ]; then
        k3s kubectl -n kube-system create secret tls factory-default-cert \
          --cert=/etc/letsencrypt/live/factory/fullchain.pem --key=/etc/letsencrypt/live/factory/privkey.pem \
          --dry-run=client -o yaml > /var/lib/rancher/k3s/server/manifests/factory-default-cert.yaml
        cat > /var/lib/rancher/k3s/server/manifests/factory-tlsstore.yaml <<YAML
      apiVersion: traefik.io/v1alpha1
      kind: TLSStore
      metadata: { name: default, namespace: kube-system }
      spec: { defaultCertificate: { secretName: factory-default-cert } }
      YAML
      fi
      cat > /var/lib/rancher/k3s/server/manifests/kube-api-ingress.yaml <<YAML
      apiVersion: traefik.io/v1alpha1
      kind: ServersTransport
      metadata: { name: kube-api, namespace: default }
      spec: { insecureSkipVerify: true }
      ---
      apiVersion: traefik.io/v1alpha1
      kind: IngressRoute
      metadata: { name: kube-api, namespace: default }
      spec:
        entryPoints: [websecure]
        routes:
          - match: Host(\`${HOST}\`)
            kind: Rule
            services:
              - name: kubernetes
                port: 443
                scheme: https
                serversTransport: kube-api
        tls: {}
      YAML
      cat > /var/lib/rancher/k3s/server/manifests/debug-page.yaml <<YAML
      apiVersion: v1
      kind: Pod
      metadata: { name: debug-page, namespace: kube-system, labels: { app: debug-page } }
      spec:
        containers:
          - name: web
            image: nginx:1.29-alpine
            volumeMounts: [{ name: d, mountPath: /usr/share/nginx/html, readOnly: true }]
        volumes: [{ name: d, hostPath: { path: /var/lib/factory-debug } }]
      ---
      apiVersion: v1
      kind: Service
      metadata: { name: debug-page, namespace: kube-system }
      spec: { selector: { app: debug-page }, ports: [{ port: 80 }] }
      ---
      apiVersion: traefik.io/v1alpha1
      kind: IngressRoute
      metadata: { name: debug-page, namespace: kube-system }
      spec:
        entryPoints: [web]
        routes:
          - match: Host(\`debug.${IP}.sslip.io\`)
            kind: Rule
            services: [{ name: debug-page, port: 80 }]
      YAML
      echo "factory-boot done for ${HOST}" > /var/log/factory-boot.done
runcmd:
  - [systemctl, enable, --now, factory-debug.service]
  - [bash, -c, "/usr/local/bin/factory-boot.sh > /var/log/factory-boot.log 2>&1"]
