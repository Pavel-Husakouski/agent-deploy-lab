# syntax=docker/dockerfile:1
# Образ API: сборка TypeScript в отдельном stage, в runtime только prod-зависимости и dist.

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:26-slim
ARG VERSION=dev
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.title="agent-deploy-lab" \
      org.opencontainers.image.source="https://github.com/Pavel-Husakouski/agent-deploy-lab" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json release.json ./
COPY prompts ./prompts
USER node
EXPOSE 3000
CMD ["node", "dist/api/main.js"]
