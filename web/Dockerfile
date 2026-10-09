# Exchanger: Next.js (standalone) на Bun + собранное расширение VS Code для раздачи со страницы.
# Контекст сборки — корень репозитория: docker compose build
# или docker build -f web/Dockerfile -t exchanger .

FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY web/ .
RUN bun --bun run build

FROM oven/bun:1.3.14 AS extension
WORKDIR /ext
COPY vscode-extension/ .
RUN bun run package

FROM oven/bun:1.3.14-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DIR=/data \
    EXTENSION_DIR=/app/extension

COPY --from=build --chown=bun:bun /app/.next/standalone ./
COPY --from=build --chown=bun:bun /app/.next/static ./.next/static
COPY --from=build --chown=bun:bun /app/public ./public
COPY --from=extension --chown=bun:bun /ext/*.vsix ./extension/
RUN mkdir -p /data && chown bun:bun /data

USER bun
VOLUME /data
EXPOSE 3000
CMD ["bun", "server.js"]
