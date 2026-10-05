// SPDX-License-Identifier: MIT

//! Confeature Rust SDK — drop-in compatible with the upstream
//! `configcat` crate. Construct a [`Client`] via [`Client::builder`]
//! and call [`Client::get_value`] to resolve feature-flag values.
//!
//! Migration from ConfigCat is one-line: replace
//! `configcat = "..."` with `confeature = "..."` in `Cargo.toml`
//! and rename the `use configcat::...` paths to `use confeature::...`.
//! Every other call site stays byte-identical.
//!
//! See the constitution's Principle II (NON-NEGOTIABLE) for the
//! ConfigCat parity guarantee.

#![doc(html_root_url = "https://docs.rs/confeature/0.1.0")]

pub mod client;
pub mod errors;
pub mod evaluation_details;
pub mod flag_overrides;
pub mod hooks;
pub mod log_level;
pub mod logger;
pub mod polling_mode;
pub mod snapshot;
pub mod user;

pub(crate) mod internal;

pub use crate::client::{Client, ClientBuilder};
pub use crate::errors::{BuildError, RefreshError};
pub use crate::evaluation_details::{EvaluationDetails, PercentageOption, TargetingRule, Value};
pub use crate::flag_overrides::{
    create_flag_overrides_from_config, ConfigOverrideDataSource, FlagOverrides,
    MapOverrideDataSource, OverrideBehaviour, OverrideDataSource,
};
// Confeature-SUPERSET hooks API (epic #574 / #578). Additive — the
// upstream `configcat` crate exposes no hooks surface, so this adds
// capability without touching any ConfigCat-published member.
pub use crate::hooks::{FlagEvaluatedDetails, Hooks};
pub use crate::log_level::LogLevel;
pub use crate::logger::{LogFacadeLogger, Logger};
pub use crate::polling_mode::PollingMode;
pub use crate::snapshot::Snapshot;
pub use crate::user::User;

// SDK-key helpers are public for cross-language parity tests +
// customer-side diagnostics (redaction in their own log pipelines).
// Mirrors `configcat`'s public `derive_cache_key` re-export.
pub use crate::internal::sdk_key::{
    derive_cache_key, is_valid_confeature_key_format, redact_sdk_key,
};

/// Crate version string. Stamped into the outgoing User-Agent header
/// (`confeature-rust-sdk/{VERSION}`) and exposed publicly for tests.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Cross-test access to internal wire-layer types. NOT a stable public
/// API — exists solely so the integration test at
/// `tests/wire_cases.rs` can drive `ConfigFetcher` directly against
/// the shared `wire-cases.json` corpus (epic #146 / issue #148 / spec
/// 112). The corpus tests wire behaviour by name; the matching SDK
/// surface is the fetcher, not the public `Client` (which adds poll-
/// service indirection the corpus does not assert). `#[doc(hidden)]`
/// keeps these types out of rustdoc; semver guarantees do NOT apply.
#[doc(hidden)]
pub mod __wire_test_api {
    pub use crate::internal::config_fetcher::{ConfigFetcher, FetchResult, FetchStatus};
}

/// Test-only access to the internal ConfigCat-parity evaluator, used by
/// `tests/evaluator_upstream_corpus.rs` to replay the vendored upstream
/// matrix (spec 125, SC-001) against a raw `config_v6` blob with TYPED
/// user attributes (which the public `User` cannot carry). Mirrors the
/// PHP / Go / Dart corpus harnesses, which drive the internal evaluator
/// directly. `#[doc(hidden)]` keeps these out of rustdoc; semver
/// guarantees do NOT apply and the public surface is unchanged.
#[doc(hidden)]
pub mod __eval_test_api {
    pub use crate::internal::comparators::AttrValue;
    pub use crate::internal::eval_logger::{TraceLogLevel, TraceLogger};
    pub use crate::internal::evaluator::{
        evaluate, evaluate_traced_with_attrs, evaluate_with_attrs, EvalResult,
    };
}
