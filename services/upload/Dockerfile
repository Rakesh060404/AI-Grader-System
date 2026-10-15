FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/gateway/package.json services/gateway/package.json
COPY services/grader/package.json services/grader/package.json
COPY services/results/package.json services/results/package.json
COPY services/upload/package.json services/upload/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY services/upload services/upload
RUN npm run build --workspace=@ai-grader/shared \
    && npm run build --workspace=@ai-grader/upload \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/services/upload/package.json ./services/upload/package.json
COPY --from=build --chown=node:node /app/services/upload/dist ./services/upload/dist

USER node
EXPOSE 3001
CMD ["node", "services/upload/dist/index.js"]
