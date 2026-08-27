FROM node:22-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY test ./test
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./package.json
USER 1000:1000
ENTRYPOINT ["node", "./dist/main.js"]
