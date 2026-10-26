# syntax=docker/dockerfile:1
# One Dockerfile, one target per image:
#   docker build --target gateway         --build-arg APP=gateway         -t urumi/gateway:dev .
#   docker build --target app             --build-arg APP=woocommerce-mcp -t urumi/woocommerce-mcp:dev .
#   docker build --target app             --build-arg APP=toolbox-mcp     -t urumi/toolbox-mcp:dev .
#   docker build --target everything-mcp                                  -t urumi/everything-mcp:dev .
#   docker build --target store-provisioner --build-arg APP=gateway     -t urumi/store-provisioner:dev .
# Services run TypeScript directly with Node's built-in type stripping, so there is no compile step.

FROM node:24.22.0-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/woocommerce-mcp/package.json apps/woocommerce-mcp/
COPY apps/toolbox-mcp/package.json apps/toolbox-mcp/

FROM base AS dashboard
RUN pnpm install --frozen-lockfile --filter dashboard
COPY apps/dashboard apps/dashboard
RUN pnpm --filter dashboard build

FROM base AS deploy
ARG APP
COPY apps/${APP} apps/${APP}
# Production dependencies of one app only, flattened into /out.
RUN pnpm --filter "${APP}" deploy --prod --legacy /out && rm -rf /out/test

FROM node:24.22.0-alpine AS app
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deploy /out ./
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]

FROM app AS gateway
COPY --from=dashboard /repo/apps/dashboard/dist ./dashboard
ENV DASHBOARD_DIR=/app/dashboard

# Helm CLI for the store-provisioner, pinned and checksum-verified.
FROM alpine:3.22 AS helm
ARG TARGETARCH
ARG HELM_VERSION=3.17.3
RUN wget -q https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz \
      https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz.sha256sum \
  && sha256sum -c helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz.sha256sum \
  && tar -xzf helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz --strip-components=1 -C /usr/local/bin linux-${TARGETARCH}/helm

# store-provisioner: the gateway code (build with APP=gateway), Helm, and the same store chart as `make up`.
FROM app AS store-provisioner
COPY --from=helm /usr/local/bin/helm /usr/local/bin/helm
COPY deploy/charts/store /app/charts/store
CMD ["node", "src/provisioner-main.ts"]

# Third-party reference MCP server (upstream #3), pinned. Not our code: treated as untrusted by the gateway.
FROM node:24.22.0-alpine AS everything-mcp
ENV NODE_ENV=production PORT=8080
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund @modelcontextprotocol/server-everything@2026.8.31 \
  && npm cache clean --force && apk add --no-cache tini
# The server installs no SIGTERM handler, and as PID 1 Node then ignores SIGTERM: a pod delete would hang for
# the whole grace period while the gateway still sees it as healthy. tini forwards the signal.
ENTRYPOINT ["/sbin/tini", "--"]
USER node
EXPOSE 8080
CMD ["node", "node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]

