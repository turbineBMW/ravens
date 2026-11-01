# One Dockerfile, two images: `--build-arg APP=huginn` or `APP=muninn`.
# The app's web client is built first and rides in the image; the server
# serves it under /<app> (RAVEN_WEB_DIR). Multi-arch: the Mac mini is arm64.
ARG APP

FROM node:22-alpine AS web
ARG APP
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/ui/package.json shared/ui/
COPY huginn/web/package.json huginn/web/
COPY muninn/web/package.json muninn/web/
RUN npm ci --no-audit --no-fund
COPY shared/ui shared/ui
COPY ${APP}/web ${APP}/web
RUN npm run build -w ${APP}/web

# Pinned to bookworm so the OpenSSL the binary links matches the runtime image.
FROM rust:slim-bookworm AS build
ARG APP
WORKDIR /src
# web-push's hyper client links OpenSSL (via native-tls).
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY shared/raven-core shared/raven-core
COPY shared/raven-server shared/raven-server
COPY huginn/server huginn/server
COPY muninn/server muninn/server
COPY muninn/agent muninn/agent
RUN cargo build --release -p ${APP}-server && cp target/release/${APP}-server /usr/local/bin/raven-server

FROM debian:bookworm-slim
ARG APP
ARG RAVEN_VERSION=dev
ENV RAVEN_VERSION=$RAVEN_VERSION
LABEL org.opencontainers.image.revision="$RAVEN_VERSION"
# curl for the compose healthcheck; ca-certificates and libssl3 for web push (hyper-tls).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/raven-server /usr/local/bin/raven-server
COPY --from=web /src/${APP}/web/build /srv/web
ENV RAVEN_WEB_DIR=/srv/web \
    RAVEN_LISTEN_ADDR=0.0.0.0:8080 \
    RAVEN_DB_PATH=/data/raven.db
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["raven-server"]
