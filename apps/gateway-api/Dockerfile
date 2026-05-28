FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development
ENV GATEWAY_HOST=0.0.0.0
ENV GATEWAY_PORT=3000

COPY package.json package-lock.json ./
COPY apps/gateway-api/package.json apps/gateway-api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/admin-panel/package.json apps/admin-panel/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/local-store/package.json packages/local-store/package.json
COPY packages/queue/package.json packages/queue/package.json

RUN npm ci

COPY apps/gateway-api apps/gateway-api
COPY packages packages

RUN node --check apps/gateway-api/src/main.ts

EXPOSE 3000
CMD ["node", "apps/gateway-api/src/main.ts"]
