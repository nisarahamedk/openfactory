#!/bin/bash
# Build an image from a public git ref inside the cluster and load it into k3s containerd.
# No registry: BuildKit (daemonless) writes a docker tar to a hostPath, then a privileged
# step imports it with the host's `k3s ctr` and pins it, so kubelet image GC (which runs under disk pressure and
# removes images no pod is using, such as the worker image between tasks) keeps it. Pods use imagePullPolicy: IfNotPresent.
#   build-image.sh <git-url#ref> <dockerfile path in repo> <image:tag> [context subdir]
set -euo pipefail
SRC=$1; DOCKERFILE=$2; TAG=$3; SUBDIR=${4:-}
name=build-$(echo "$TAG" | tr -c 'a-z0-9\n' '-' | cut -c1-40)-$(date +%s)
ctx="$SRC"; [ -n "$SUBDIR" ] && ctx="$SRC:$SUBDIR"
kubectl -n factory-system delete job -l factory/build="$(echo "$TAG" | tr -c 'a-zA-Z0-9\n' '-' | cut -c1-60)" --ignore-not-found >/dev/null
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: $name
  namespace: factory-system
  labels: { factory/build: "$(echo "$TAG" | tr -c 'a-zA-Z0-9\n' '-' | cut -c1-60)" }
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      restartPolicy: Never
      hostPID: true
      initContainers:
        - name: build
          image: moby/buildkit:v0.25.1
          securityContext: { privileged: true }
          command: [buildctl-daemonless.sh]
          args:
            - build
            - --frontend=dockerfile.v0
            - --opt=context=$ctx
            - --opt=filename=$DOCKERFILE
            - --output=type=docker,name=$TAG,dest=/out/$name.tar
          volumeMounts: [{ name: out, mountPath: /out }, { name: cache, mountPath: /var/lib/buildkit }]
      containers:
        - name: import
          image: alpine:3.22
          securityContext: { privileged: true }
          command: [sh, -c, "nsenter -t 1 -m -- k3s ctr -n k8s.io images import /var/lib/factory-images/$name.tar && nsenter -t 1 -m -- k3s ctr -n k8s.io images label docker.io/library/$TAG io.cri-containerd.pinned=pinned >/dev/null && rm -f /out/$name.tar && echo imported $TAG"]
          volumeMounts: [{ name: out, mountPath: /out }]
      volumes:
        - { name: out, hostPath: { path: /var/lib/factory-images, type: DirectoryOrCreate } }
        - { name: cache, hostPath: { path: /var/lib/factory-buildkit, type: DirectoryOrCreate } }
YAML
echo "job/$name started"
# Use a branch or tag as the ref (BuildKit can't fetch a bare short sha). Stop on Failed, not only on timeout.
until s=$(kubectl -n factory-system get job/$name -o jsonpath='{.status.conditions[*].type}') && [[ "$s" =~ Complete|Failed ]]; do sleep 10; done
if [[ "$s" =~ Failed ]]; then kubectl -n factory-system logs job/$name -c build --tail=40; exit 1; fi
kubectl -n factory-system logs job/$name -c import --tail=3
