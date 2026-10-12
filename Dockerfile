FROM rust:1.96-bookworm AS builder
WORKDIR /build
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY server/migrations ./migrations
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 nas-sync && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin nas-sync \
    && mkdir /data && chown 10001:10001 /data
COPY --from=builder /build/target/release/nas-sync-server /usr/local/bin/nas-sync-server
USER 10001:10001
ENV NAS_SYNC_DATA=/data NAS_SYNC_PORT=8080 NAS_SYNC_MAX_FILE_BYTES=52428800
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD curl -fsS "http://127.0.0.1:${NAS_SYNC_PORT}/health" || exit 1
ENTRYPOINT ["nas-sync-server"]
