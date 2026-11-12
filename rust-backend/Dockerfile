FROM rust:1-bookworm AS builder
WORKDIR /app
COPY rust-backend/Cargo.toml ./Cargo.toml
COPY rust-backend/migrations ./migrations
COPY rust-backend/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home mallowcord
COPY --from=builder /app/target/release/mallowcord-backend /usr/local/bin/mallowcord-backend
USER mallowcord
ENV MALLOWCORD_BIND_ADDR=0.0.0.0:8081
EXPOSE 8081
CMD ["mallowcord-backend"]
