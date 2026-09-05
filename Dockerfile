FROM node:25-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:25-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production OPENOUTLINER_HOST=0.0.0.0 OPENOUTLINER_PORT=4317 OPENOUTLINER_DB=/app/data/openoutliner.sqlite
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/person ./person
COPY package.json ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME /app/data
EXPOSE 4317
CMD ["node", "dist/backend/server/index.js"]
