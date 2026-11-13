# Worker image for SlopwareFactory workspaces.
# Holds what an agent needs to code, deploy and test inside its sandbox:
# git, Node + pnpm, the Claude Code ACP adapter, kubectl, devspace,
# and Playwright's browsers (the base image) for e2e evidence.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ARG KUBECTL_VERSION=v1.34.1
ARG DEVSPACE_VERSION=v6.3.18
ARG CLAUDE_AGENT_ACP_VERSION=0.106.0
ARG PNPM_VERSION=10.28.0

# The base image already has git, curl, ps and Node 22.
RUN curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && curl -fsSLo /usr/local/bin/devspace "https://github.com/loft-sh/devspace/releases/download/${DEVSPACE_VERSION}/devspace-linux-amd64" \
 && chmod +x /usr/local/bin/devspace

RUN npm install -g "pnpm@${PNPM_VERSION}" "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}" \
 && npm cache clean --force

# Git identity for the agent's commits; push credentials come per task in $HOME.
RUN git config --system user.name "SlopwareFactory worker" \
 && git config --system user.email "factory-worker@users.noreply.github.com" \
 && git config --system init.defaultBranch main

ENV IS_SANDBOX=1 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /work
CMD ["sleep", "infinity"]
