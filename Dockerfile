# ezForge MCP Server — Node.js template Dockerfile
# Multi-stage build: compile TypeScript then run with minimal image.
#

FROM node:26-alpine AS builder

WORKDIR /app

# Copy base template (local dependency).
# Build base in place: emit compiled .js next to .ts under src/ so that runtime
# ESM imports of the form 'ezforge-ready-base/src/X.js' resolve. tsc succeeds at
# template build time via NodeNext .js→.ts resolution, but Node's runtime ESM
# resolver requires the literal .js file to exist.
COPY base ./base
RUN cd base && npm ci && npx tsc --outDir src

COPY package*.json ./
# Use npm install (not npm ci) because the file: dependency on ../base
# makes npm ci fragile across npm versions (lock file generated with npm 9,
# Docker image ships npm 11).
#
# TRADE-OFF: npm install resolves fresh from the registry at build time, so
# patch versions of indirect dependencies can drift between Docker builds.
# This is acceptable for now given the file:-dep / npm version mismatch root
# cause.  Build context: the repository root (docker build .).
RUN npm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────

FROM node:26-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=builder /app/base ./base
# npm install (not npm ci) — same file: dep cross-version issue as builder stage.
# See builder stage comment above for the full reproducibility trade-off discussion.
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

# Drop to non-root user for least-privilege execution (UID 1001 matches platform convention)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs --no-create-home appuser
USER appuser

EXPOSE 8080

CMD ["node", "dist/index.js"]
