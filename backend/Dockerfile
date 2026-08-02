# ============================================================================
# Accord2 backend — production container image.
#
# Multi-stage build: compile the `accord-backend` binary against a pinned
# toolchain, then ship it on a minimal Debian runtime as a non-root user with a
# read-only-friendly layout (matches the k8s securityContext:
# runAsNonRoot + readOnlyRootFilesystem).
#
# CI builds this with `context: ./backend` (see .github/workflows/backend.yml),
# so every path below is relative to the backend crate directory. All runtime
# configuration is injected via environment variables (SERVER__*, DATABASE__*,
# TELEMETRY__*); the TOML file is optional, so no repo-root config is copied.
# ============================================================================

# --- Build stage ------------------------------------------------------------
# Edition 2024 requires a recent toolchain; pin it for reproducible builds.
FROM rust:1.89-slim-bookworm AS builder

# Compile sqlx's query macros against the committed offline metadata (.sqlx/)
# rather than a live database — no DATABASE_URL exists at image-build time.
ENV SQLX_OFFLINE=true

WORKDIR /build

# Copy manifests first so dependency compilation is cached when only src/ changes.
COPY Cargo.toml Cargo.lock ./

# Pre-build dependencies against a dummy main to warm the cargo cache layer.
RUN mkdir src \
    && echo 'fn main() { println!("placeholder"); }' > src/main.rs \
    && cargo build --release --locked \
    && rm -rf src

# Copy the real sources plus the sqlx offline query metadata, then build the
# actual binary. Touching main.rs busts the placeholder artifact so the final
# binary is genuinely rebuilt.
COPY src ./src
COPY .sqlx ./.sqlx
RUN touch src/main.rs \
    && cargo build --release --locked \
    && strip target/release/accord-backend

# --- Runtime stage ----------------------------------------------------------
# Slim Debian gives us glibc + a place for CA certificates (needed for OTLP/gRPC
# and any TLS the pool may use) while staying small.
FROM debian:bookworm-slim AS runtime

# ca-certificates for outbound TLS; tini as a proper PID 1 that forwards SIGTERM
# to the app so graceful shutdown (shutdown.rs) actually runs under k8s.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user (uid 10001) to satisfy runAsNonRoot.
RUN groupadd --gid 10001 accord \
    && useradd --uid 10001 --gid accord --no-create-home --shell /usr/sbin/nologin accord

COPY --from=builder /build/target/release/accord-backend /usr/local/bin/accord-backend

USER accord:accord

# Documented default; the actual port is driven by SERVER__PORT at runtime.
EXPOSE 8080

# tini reaps zombies and forwards signals; the binary drains on SIGTERM/SIGINT.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/accord-backend"]
