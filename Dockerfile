# Multi-stage build: install deps in a full image, run in a slim one.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:22-slim AS runtime
RUN groupadd -r objstore && useradd -r -g objstore objstore
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data && chown -R objstore:objstore /app
USER objstore

ENV NODE_ENV=production
EXPOSE 3000 4100

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Overridden per-service by docker-compose (coordinator vs storage node).
CMD ["node", "src/server.js"]
