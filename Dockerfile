# ===================================================
# Stage 1: Build & Package with Vite+ (vp pack)
# ===================================================
FROM node:22-slim AS builder

WORKDIR /app

# Install git and pnpm
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependency manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./

# Install dependencies (respecting pnpm lockfile)
RUN pnpm install --frozen-lockfile

# Copy application source code and configs
COPY tsconfig.json vite.config.ts pr-agent.config.ts ./
COPY src/ ./src/

# Package library & CLI distribution using Vite+ (tsdown / rolldown)
RUN pnpm run build

# Prune development dependencies to keep production footprint minimal
RUN pnpm prune --prod

# ===================================================
# Stage 2: Production Lightweight Runtime Image
# ===================================================
FROM node:22-slim AS runner

WORKDIR /app

# Install git (required for diff parsing and repo inspections)
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

# Security: run as non-root user
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 pragent
USER pragent

# Copy built distribution, production modules, and configuration
COPY --from=builder --chown=pragent:nodejs /app/package.json ./package.json
COPY --from=builder --chown=pragent:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=pragent:nodejs /app/dist ./dist
COPY --from=builder --chown=pragent:nodejs /app/pr-agent.config.ts ./pr-agent.config.ts

# Create session & trace persistence directory
RUN mkdir -p /app/.pr-agent/sessions /app/.pr-agent/traces

EXPOSE 3000

# Default: start the private GitHub App Webhook server & BullMQ Worker daemon
CMD ["node", "dist/cli.mjs", "server"]
