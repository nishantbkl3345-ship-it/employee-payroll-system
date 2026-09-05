# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install --no-audit --no-fund

COPY tsconfig*.json ./
COPY server ./server
COPY web ./web
COPY samples ./samples

RUN npm run build -w web && npm run build -w server

# Prune to production dependencies for the runtime image.
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV LOG_PRETTY=false
ENV WEB_DIST=/app/web/dist

RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/samples ./samples

RUN mkdir -p /app/.data && chown -R app:app /app
USER app

EXPOSE 4000
HEALTHCHECK --interval=20s --timeout=4s --start-period=25s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
