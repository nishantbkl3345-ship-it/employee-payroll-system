# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY server ./server
COPY web ./web

RUN npm run build -w web && npm run build -w server

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV LOG_PRETTY=false
ENV WEB_DIST=/app/web/dist

COPY package.json package-lock.json ./
COPY server/package.json ./server/
# Production dependencies only; the web workspace is build-time only.
RUN npm ci --omit=dev --workspace server --include-workspace-root && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY samples ./samples

RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /app/.data && chown -R app:app /app
USER app

EXPOSE 4000
HEALTHCHECK --interval=20s --timeout=4s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
