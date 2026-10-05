// SPDX-License-Identifier: MIT

//! Error types — all via [`thiserror`] for consistent `Display` +
//! source-chain ergonomics.
//!
//! SDK keys NEVER appear raw in any error message. Wrap sites
//! pass keys through [`crate::internal::sdk_key::redact_sdk_key`]
//! before interpolation.

use thiserror::Error;

/// Failure modes for [`crate::ClientBuilder::build`].
#[derive(Debug, Error)]
pub enum BuildError {
    /// SDK key was empty.
    #[error("confeature: invalid SDK key (empty)")]
    InvalidSdkKey,
    /// One of the builder options was nonsensical.
    #[error("confeature: invalid builder option: {0}")]
    InvalidOption(String),
}

/// Failure modes for [`crate::Client::force_refresh`].
#[derive(Debug, Error)]
pub enum RefreshError {
    /// The client has already been closed.
    #[error("confeature: client is closed")]
    ClientClosed,
    /// The client is in offline mode (spec 095 / #267). No HTTP traffic is
    /// initiated; the customer flips back online via [`crate::Client::online`].
    #[error("confeature: client is offline")]
    Offline,
    /// The fetch attempt failed; the embedded reason carries no SDK key.
    #[error("confeature: refresh failed ({reason})")]
    FetchFailed {
        /// Short, key-free reason code (e.g. `"HTTP 502"`).
        reason: String,
    },
}

/// Failure modes for the synchronous evaluator. Customers don't see
/// this type — it is consumed by the client's `get_value` path which
/// translates it into a returned default + a logged warning.
#[derive(Debug, Error)]
pub enum EvalError {
    /// The requested key is absent from the cache.
    #[error("KEY_NOT_FOUND")]
    KeyNotFound,
    /// The cached config slot is not a boolean.
    #[error("UNSUPPORTED_TYPE")]
    UnsupportedType,
    /// The customer's default is not a boolean.
    #[error("TYPE_MISMATCH")]
    TypeMismatch,
    /// The cache is empty / no config has landed yet.
    #[error("NO_CONFIG")]
    NoConfig,
    /// The cached config does not parse against the expected shape.
    #[error("MALFORMED_CONFIG")]
    MalformedConfig,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_error_displays() {
        assert_eq!(
            BuildError::InvalidSdkKey.to_string(),
            "confeature: invalid SDK key (empty)"
        );
    }

    #[test]
    fn refresh_error_displays_reason() {
        let e = RefreshError::FetchFailed {
            reason: "HTTP 502".to_string(),
        };
        assert!(e.to_string().contains("HTTP 502"));
    }

    #[test]
    fn eval_error_displays_code() {
        assert_eq!(EvalError::KeyNotFound.to_string(), "KEY_NOT_FOUND");
    }
}
