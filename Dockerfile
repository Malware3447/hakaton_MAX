# syntax=docker/dockerfile:1

# bookworm, а не trixie: пакет libengine-gost-openssl (ГОСТ для проверки подписи «Госключа») есть только в нём
FROM node:24-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl libengine-gost-openssl libxml2-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Корневой сертификат Минцифры: без него не открыть platform-api2.max.ru
COPY certs/russian_trusted_root_ca.pem /usr/local/share/ca-certificates/russian_trusted_root_ca.crt
RUN update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

FROM base AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/app/package.json apps/app/
COPY packages/domain/package.json packages/domain/
COPY packages/etrn/package.json packages/etrn/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY apps apps
COPY packages packages
RUN npm run build

# Бандл самодостаточный: node_modules в итоговом образе не нужны
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /src/apps/app/dist ./dist
COPY apps/app/drizzle ./drizzle
COPY seed ./seed
COPY certs/goskey ./certs/goskey
RUN mkdir -p /app/.cache/goskey && chown node:node /app/.cache/goskey
ENV MIGRATIONS_DIR=/app/drizzle SEED_PATH=/app/seed/plant-seed.json \
    GOSKEY_CERTS_DIR=/app/certs/goskey GOSKEY_CACHE_DIR=/app/.cache/goskey
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
