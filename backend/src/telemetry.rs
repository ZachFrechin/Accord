//! Telemetry bootstrap: structured logging + OpenTelemetry tracing.
//!
//! [`init`] wires a `tracing-subscriber` registry with three layers — an
//! `EnvFilter` (honours `RUST_LOG`), a stdout formatter (JSON or pretty per
//! config) and an optional OTLP export layer feeding traces to the collector
//! over gRPC. It returns a [`TelemetryGuard`]; keep it alive for the whole
//! process and drop it last so batched spans are flushed on shutdown.

use anyhow::Context;
use opentelemetry::KeyValue;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::runtime;
use opentelemetry_sdk::trace::TracerProvider;
use tracing_subscriber::{EnvFilter, Layer, layer::SubscriberExt, util::SubscriberInitExt};

use crate::config::{LogFormat, TelemetryConfig};

/// RAII guard that flushes and shuts down the OpenTelemetry tracer provider on
/// drop. Held by `main` for the lifetime of the process; dropping it at the end
/// of `main` guarantees in-flight spans are exported before exit.
pub struct TelemetryGuard {
    provider: Option<TracerProvider>,
}

impl Drop for TelemetryGuard {
    /// Flushes any batched spans and tears down the exporter. Errors are logged
    /// but never panic — we are already on the shutdown path.
    fn drop(&mut self) {
        if let Some(provider) = self.provider.take()
            && let Err(err) = provider.shutdown()
        {
            eprintln!("telemetry: tracer provider shutdown failed: {err:?}");
        }
    }
}

/// Initializes the global tracing subscriber and (best-effort) the OTLP tracer.
///
/// The stdout log layer is always installed. The OTLP layer is optional: if the
/// exporter cannot be built (e.g. the collector address is malformed) we log a
/// warning and continue with logs-only telemetry rather than aborting boot —
/// observability must never take the service down.
///
/// Must be called exactly once, before any span is created.
pub fn init(cfg: &TelemetryConfig) -> anyhow::Result<TelemetryGuard> {
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    // Stdout formatting layer, boxed so both arms share one type.
    let fmt_layer = match cfg.log_format {
        LogFormat::Json => tracing_subscriber::fmt::layer()
            .json()
            .with_current_span(true)
            .boxed(),
        LogFormat::Pretty => tracing_subscriber::fmt::layer()
            .pretty()
            .with_line_number(true)
            .boxed(),
    };

    // Best-effort OTLP tracer provider. An empty endpoint disables OTLP entirely
    // (logs-only mode) — useful for local runs and tests where no collector is up,
    // and it avoids spawning the exporter's background batch runtime.
    let provider = if cfg.otlp_endpoint.trim().is_empty() {
        None
    } else {
        match build_tracer_provider(cfg) {
            Ok(provider) => Some(provider),
            Err(err) => {
                eprintln!(
                    "telemetry: OTLP exporter unavailable, continuing with logs only: {err:?}"
                );
                None
            }
        }
    };

    // Bridge OTel spans into `tracing` only when a provider exists. An
    // `Option<Layer>` is itself a `Layer`, so this composes cleanly.
    let otel_layer = provider.as_ref().map(|provider| {
        let tracer = provider.tracer(cfg.service_name.clone());
        tracing_opentelemetry::layer().with_tracer(tracer)
    });

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();

    Ok(TelemetryGuard { provider })
}

/// Builds an OTLP/gRPC tracer provider with a batch span processor tagged by the
/// configured `service.name`. Separated out so [`init`] can degrade gracefully
/// when this fails.
fn build_tracer_provider(cfg: &TelemetryConfig) -> anyhow::Result<TracerProvider> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(cfg.otlp_endpoint.clone())
        .build()
        .context("building OTLP span exporter")?;

    let resource = Resource::new(vec![KeyValue::new(
        "service.name",
        cfg.service_name.clone(),
    )]);

    let provider = TracerProvider::builder()
        .with_batch_exporter(exporter, runtime::Tokio)
        .with_resource(resource)
        .build();

    // Register as the process-wide provider so library code can emit spans too.
    opentelemetry::global::set_tracer_provider(provider.clone());

    Ok(provider)
}
