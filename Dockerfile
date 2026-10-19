# Multi-stage build following the Vite+ Docker guide: build with the official toolchain image,
# install production dependencies in a separate stage, run on a slim glibc image without vp.

# ===================================================
# Stage 1: build with the Vite+ toolchain
# ===================================================
FROM ghcr.io/voidzero-dev/vite-plus:latest AS build
WORKDIR /app

# Dependencies first so this layer is cached across source changes.
# vp provisions the Node.js and pnpm versions pinned in package.json (devEngines / packageManager).
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN vp install --frozen-lockfile

COPY --chown=vp:vp tsconfig.json vite.config.ts pr-agent.config.ts ./
COPY --chown=vp:vp src/ ./src/
RUN vp pack

# Export the exact resolved Node.js binary for the runtime stage.
RUN cp "$(vp env which node | head -1)" /tmp/node

# ===================================================
# Stage 2: production-only dependencies
# ===================================================
# A fresh --prod install: running --prod over the full install above would not prune devDependencies.
FROM ghcr.io/voidzero-dev/vite-plus:latest AS deps
WORKDIR /app
COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN vp install --frozen-lockfile --prod

# ===================================================
# Stage 3: runtime
# ===================================================
FROM debian:bookworm-slim AS runtime
WORKDIR /app

# git fetches the PR head for the context tools; ca-certificates for HTTPS to GitHub and the LLM API.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /tmp/node /usr/local/bin/node

ENV NODE_ENV=production
ENV PORT=3000

# Non-root user with a home directory (git writes its config and temp checkouts there).
RUN groupadd --system --gid 1001 pragent \
    && useradd --system --uid 1001 --gid pragent --create-home pragent
COPY --from=deps --chown=pragent:pragent /app/node_modules ./node_modules
COPY --from=build --chown=pragent:pragent /app/dist ./dist
COPY --from=build --chown=pragent:pragent /app/package.json /app/pr-agent.config.ts ./

# Sessions, traces and the SQLite trace store (mounted as a volume in docker-compose).
RUN mkdir -p /app/.pr-agent && chown pragent:pragent /app/.pr-agent
USER pragent

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Webhook server and BullMQ worker in one process
CMD ["node", "dist/cli.mjs", "server"]
