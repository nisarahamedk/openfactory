# Worker image for SlopwareFactory workspaces.
# Holds what an agent needs to code, deploy and test inside its sandbox:
# git and the gh CLI (the agent pushes and opens its PR), Node + pnpm, the
# Claude Code ACP adapter, kubectl, devspace, and Playwright's browsers (the
# base image) for e2e evidence.
FROM mcr.microsoft.com/playwright:v1.56.1-noble

ARG KUBECTL_VERSION=v1.34.1
ARG DEVSPACE_VERSION=v6.3.18
ARG CLAUDE_AGENT_ACP_VERSION=0.106.0
ARG PNPM_VERSION=10.28.0
ARG GH_VERSION=2.83.0
ARG GH_SHA256=a5cf6cdb40fc67751adf561126b3314044779cea81ba4f254fbe8e9a69f1676f

# The base image already has git, curl, ps and Node 22.
RUN curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && curl -fsSLo /usr/local/bin/devspace "https://github.com/loft-sh/devspace/releases/download/${DEVSPACE_VERSION}/devspace-linux-amd64" \
 && chmod +x /usr/local/bin/devspace \
 && curl -fsSLo /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tgz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64"

RUN npm install -g "pnpm@${PNPM_VERSION}" "@agentclientprotocol/claude-agent-acp@${CLAUDE_AGENT_ACP_VERSION}" \
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

WORKDIR /work
CMD ["sleep", "infinity"]
