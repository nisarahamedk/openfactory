# Worker image for SlopwareFactory workspaces.
# Holds what an agent needs to code, deploy and test inside its sandbox:
# git and the gh CLI (the agent pushes and opens its PR), Node + pnpm, the
# Claude Code ACP adapter, kubectl, devspace + helm, and Playwright's browsers
# for e2e evidence and world checks.
# The base image's Playwright matches the version the product repo pins
# (FirstWord: @playwright/test 1.56.1); bump both together.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ARG KUBECTL_VERSION=v1.34.1
ARG DEVSPACE_VERSION=v6.3.18
ARG CLAUDE_AGENT_ACP_VERSION=0.106.0
ARG PNPM_VERSION=10.28.0
ARG NODE_VERSION=22.21.1
ARG NODE_SHA256=219a152ea859861d75adea578bdec3dce8143853c13c5187f40c40e77b0143b2
ARG HELM_VERSION=v3.11.1
ARG HELM_SHA256=0b1be96b66fab4770526f136f5f1a385a47c41923d33aab0dcb500e0f6c1bf7c
ARG PLAYWRIGHT_VERSION=1.56.1
ARG GH_VERSION=2.83.0
ARG CODEGRAPH_VERSION=1.6.2
ARG GH_SHA256=a5cf6cdb40fc67751adf561126b3314044779cea81ba4f254fbe8e9a69f1676f

# Node 22.21+ so Node's own fetch and https honour the egress proxy variables
# (NODE_USE_ENV_PROXY=1, set on the pod); the base image's Node 22.20 does not.
# /usr/local/bin comes first on PATH, ahead of the base image's /usr/bin/node.
RUN curl -fsSLo /tmp/node.tgz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && echo "${NODE_SHA256}  /tmp/node.tgz" | sha256sum -c - \
 && tar -xzf /tmp/node.tgz -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE \
 && rm /tmp/node.tgz \
 && node --version | grep -qx "v${NODE_VERSION}"

# The base image already has git, curl and ps.
RUN curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && curl -fsSLo /usr/local/bin/devspace "https://github.com/loft-sh/devspace/releases/download/${DEVSPACE_VERSION}/devspace-linux-amd64" \
 && chmod +x /usr/local/bin/devspace \
 && curl -fsSLo /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"

# Helm at the version DevSpace would otherwise download at deploy time, so the
# sandbox needs no route to get.helm.sh.
RUN curl -fsSLo /tmp/helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
 && echo "${HELM_SHA256}  /tmp/helm.tgz" | sha256sum -c - \
 && tar -xzf /tmp/helm.tgz -C /tmp \
 && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
 && rm -rf /tmp/helm.tgz /tmp/linux-amd64

# CodeGraph: a code index with one MCP tool; factory versions with `codegraph: true` use it to read less.
RUN npm install -g "pnpm@${PNPM_VERSION}" "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}" "@colbymchenry/codegraph@${CODEGRAPH_VERSION}" \
 && npm cache clean --force

# Git identity for the agent's commits. The task job writes a per-task repo
# token to $HOME/.git-credentials before each turn; gh reads GH_TOKEN.
RUN git config --system user.name "SlopwareFactory worker" \
 && git config --system user.email "factory-worker@users.noreply.github.com" \
 && git config --system init.defaultBranch main \
 && git config --system credential.helper store

ENV IS_SANDBOX=1 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    GH_PROMPT_DISABLED=1 \
    GH_NO_UPDATE_NOTIFIER=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Browsers for the product's pinned Playwright. With the matching base image
# this is a no-op; with a different pin it downloads that version's browsers
# (system libraries come from the base image, so no apt step).
RUN npx -y "playwright@${PLAYWRIGHT_VERSION}" install chromium \
 && npm cache clean --force

WORKDIR /work
CMD ["sleep", "infinity"]
