FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/forge-adapters/package.json packages/forge-adapters/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @kaola/web build

ENV PORT=31415
ENV HOST=0.0.0.0
ENV WEB_DIST=/app/apps/web/dist
EXPOSE 31415

CMD ["pnpm", "--filter", "@kaola/server", "start"]
