FROM oven/bun:1.4.0-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN bun run build

FROM oven/bun:1.4.0-alpine AS runtime
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY THIRD-PARTY-NOTICES.md ./
USER bun
EXPOSE 4310
CMD ["bun", "server/serve.ts"]
