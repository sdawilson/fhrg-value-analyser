# Value Analyser, for bunny.net Magic Containers (linux/amd64).
# GitHub Actions builds this automatically (see .github/workflows/deploy.yml).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && node scripts/build.mjs

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
