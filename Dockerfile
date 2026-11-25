# SPDX-License-Identifier: AGPL-3.0-or-later
# rhizome on Node: one container, data in /data. See "Run it without Cloudflare" in the README.
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json web/
RUN npm ci --no-audit --no-fund && npm ci --prefix web --no-audit --no-fund
COPY . .
RUN npm run build:web && npm run build:node

FROM node:26-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
WORKDIR /app
# The server is a single bundle: no node_modules at runtime.
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/migrations ./migrations
COPY LICENSE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/node/server.mjs"]
