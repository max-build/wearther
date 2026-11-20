# syntax=docker/dockerfile:1

# ---- Build stage: compile Tailwind CSS + TypeScript -----------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Install deps first so this layer is cached until package files change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.client.json ./
COPY styles ./styles
COPY client ./client
COPY src ./src
COPY public ./public
RUN npm run build

# ---- Production dependencies only -------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime image ------------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    # Railway (and most PaaS hosts) put exactly one reverse proxy in front of the
    # app. This makes the rate limiter see each visitor's real IP instead of the
    # proxy's. Override with TRUST_PROXY=0 if you run the container directly.
    TRUST_PROXY=1

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

# Secrets (ANTHROPIC_API_KEY) are supplied at runtime, never baked into the image.
CMD ["node", "dist/server.js"]
