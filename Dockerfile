# syntax=docker/dockerfile:1
# Conclave hub image: builds the web app and serves it from the hub, so one
# container is the whole user-facing app. Run a daemon on each machine separately
# (see docs/DEPLOY.md) — daemons need the host filesystem + real CLIs and are not
# containerized here.

# ---- build stage: install deps (compiles better-sqlite3) + build the web app ----
FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Manifests first for better layer caching of the install step.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/hub/package.json ./packages/hub/
COPY packages/daemon/package.json ./packages/daemon/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @conclave/web build

# ---- runtime stage: node + deps + hub/shared source + built web assets ----
FROM node:22-bookworm-slim AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production \
    CONCLAVE_PORT=7777 \
    CONCLAVE_DATA_DIR=/data \
    CONCLAVE_WEB_DIR=/app/packages/web/dist

# node_modules carries the compiled better-sqlite3 binding (same base image ABI).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/hub ./packages/hub
COPY --from=build /app/packages/web/dist ./packages/web/dist

VOLUME ["/data"]
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.CONCLAVE_PORT||7777)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# CONCLAVE_TOKEN is required at runtime (see docs/DEPLOY.md).
CMD ["pnpm", "--filter", "@conclave/hub", "dev"]
