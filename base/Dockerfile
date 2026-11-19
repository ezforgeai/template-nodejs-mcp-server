# ezForge Ready — Base MCP Server Dockerfile
# Multi-stage build: compile TypeScript, then produce a minimal runtime image.
#
# Environment variables:
#   EZFORGE_READY_CONFIG          (required) JSON-encoded ReadyConfig object
#   PORT                          (optional) HTTP port, defaults to 8080
#   EZFORGE_ANALYTICS_ENDPOINT    (optional) analytics API endpoint; overridden by ReadyConfig.analytics.reportingEndpoint

FROM node:26-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────

FROM node:26-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Drop to non-root user for least-privilege execution (UID 1001 matches platform convention)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs --no-create-home appuser
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["node", "dist/index.js"]
