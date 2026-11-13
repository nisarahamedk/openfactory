# One image for the whole factory. Pick the process by command:
#   server     node apps/server/dist/main.js        (default)
#   dashboard  node apps/dashboard/dist/main.js
#   fake DX    node plugins/metrics-dxfake/dist/main.js
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
ENV CI=true
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
ARG KUBECTL_VERSION=v1.34.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl tini \
 && curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/$(dpkg --print-architecture)/kubectl" \
 && chmod +x /usr/local/bin/kubectl \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /src /app
USER node
ENV NODE_ENV=production
ENTRYPOINT ["/usr/bin/tini", "--", "node"]
CMD ["apps/server/dist/main.js"]
