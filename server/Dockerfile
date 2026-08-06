FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npm run build

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Migration SQL files are read at runtime by drizzle's migrator, not bundled by tsc.
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3333
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/api/server.js"]
