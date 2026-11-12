# Build: install, run the tests and the type check, then reinstall production dependencies only.
FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY server server
COPY shared shared
COPY client client
COPY web web
COPY test test
RUN bun test \
 && bun run check \
 && rm -rf node_modules test \
 && bun install --frozen-lockfile --production \
 && mkdir -p /data

# Runtime: no shell, no package manager, non-root, read-only root filesystem (see the Komodo stack).
FROM oven/bun:1.4.4-distroless
ARG REVISION=dev
WORKDIR /app
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/client ./client
COPY --from=build /app/web ./web
COPY --from=build --chown=1000:1000 /data /data
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=UTC \
    REVISION=$REVISION
LABEL org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.source=https://github.com/tr1ckyf0x-studio/meet \
      org.opencontainers.image.description="Find a time for a group meeting across calendars and time zones"
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The base image's entrypoint is already `bun`; a CMD starting with "bun" would run the legacy `bun bun` bundler.
ENTRYPOINT ["bun", "server/main.ts"]
CMD []
