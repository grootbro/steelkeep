# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.0-alpine AS dependencies
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,id=steelkeep-bun-${TARGETARCH},target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run build

FROM oven/bun:1.4.0-alpine AS runtime
ARG TARGETARCH
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,id=steelkeep-bun-${TARGETARCH},target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY scripts/setup-owner.ts ./scripts/setup-owner.ts
COPY THIRD-PARTY-NOTICES.md ./
USER bun
EXPOSE 4310
CMD ["bun", "server/serve.ts"]
