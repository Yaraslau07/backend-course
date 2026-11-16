# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
# Upgrade OS packages to pick up security fixes (Trivy scans the final image in CI).
RUN apk upgrade --no-cache
WORKDIR /app

FROM base AS prod-dependencies
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# husky's "prepare" script is a dev-only hook installer; skip lifecycle scripts here.
RUN npm ci --omit=dev --ignore-scripts

FROM base AS builder
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM base AS production
# tini forwards SIGTERM to node so enableShutdownHooks() can drain in-flight requests.
# npm/yarn are removed: the app runs as `node dist/main.js` directly (npm doesn't forward signals).
RUN apk add --no-cache tini && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*

ENV NODE_ENV=production
ENV PORT=3007
WORKDIR /app
USER node

COPY --chown=node:node package.json ./
COPY --from=prod-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

EXPOSE 3007
ENTRYPOINT ["/sbin/tini", "--"]

# Liveness only: readiness is internal and depends on the DB, which must not restart the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:${PORT}/health/live || exit 1

CMD ["node", "dist/main.js"]
