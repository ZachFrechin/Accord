# syntax=docker/dockerfile:1
# ============================================================================
# Accord2 backend image — one binary, two roles:
#   accord-backend            → serve (default)
#   accord-backend migrate    → apply schema, then exit (one-shot deploy step)
#
# Build context is the REPO ROOT (the crate needs its sibling migrations/ for the
# embedded sqlx::migrate!). Build:
#   docker build -f infra/backend.Dockerfile -t accord-backend .
# ============================================================================

# --- builder -------------------------------------------------------------------
FROM rust:1.89-slim-bookworm AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config \
 && rm -rf /var/lib/apt/lists/*

# migrations/ is a sibling of the crate: sqlx::migrate!("../migrations") reads it
# at compile time, and the query cache (.sqlx, inside backend/) drives the offline
# build so no database is needed to compile.
COPY migrations ./migrations
COPY backend ./backend
WORKDIR /app/backend
ENV SQLX_OFFLINE=true
RUN cargo build --release --locked

# --- runtime -------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
# ca-certificates for outbound TLS (SMTP, S3); curl for the compose healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 accord
COPY --from=builder /app/backend/target/release/accord-backend /usr/local/bin/accord-backend
USER accord
EXPOSE 8090
ENTRYPOINT ["accord-backend"]
