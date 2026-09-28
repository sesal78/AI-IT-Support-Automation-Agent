# syntax=docker/dockerfile:1
# Build context: the repo root. `docker build -f apps/web/Dockerfile .`

FROM node:24-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@11.27.1

# Install workspace dependencies and build web (and the packages it depends on).
FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=web

# Minimal runtime: only the standalone server and static assets.
FROM node:24-alpine AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# The official node image ships an unprivileged `node` user.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
