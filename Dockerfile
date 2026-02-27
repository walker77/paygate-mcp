FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY tsconfig.build.json tsconfig.json ./
COPY src/ src/
RUN npm run build

# --- Production image ---
FROM node:22-alpine

LABEL org.opencontainers.image.title="paygate-mcp" \
      org.opencontainers.image.description="Pay-per-tool-call gating proxy for MCP servers" \
      org.opencontainers.image.url="https://paygated.dev" \
      org.opencontainers.image.source="https://github.com/walker77/paygate-mcp" \
      org.opencontainers.image.licenses="MIT"

RUN addgroup -g 1001 -S paygate && \
    adduser -S paygate -u 1001 -G paygate

WORKDIR /app

COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/

RUN mkdir -p /data && chown paygate:paygate /data

USER paygate

ENV NODE_ENV=production \
    PAYGATE_PORT=3000 \
    PAYGATE_STATE_FILE=/data/paygate-state.json \
    PAYGATE_AUDIT_DIR=/data/audit

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["wrap"]
