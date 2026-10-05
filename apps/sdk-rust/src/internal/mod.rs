// SPDX-License-Identifier: MIT

//! Internal helpers (not part of the public API surface).
//!
//! Modules under this tree MUST NOT depend on `crate::Client` or any
//! other public type that would create a public → internal cycle. The
//! 7-branch override-eval helper defines its own decoupled trait so
//! it stays free of `crate::FlagOverrides` imports — the client maps
//! between the two at the boundary.

pub(crate) mod cache;
pub(crate) mod comparators;
pub(crate) mod config_fetcher;
pub(crate) mod eval_log;
pub(crate) mod eval_logger;
pub(crate) mod evaluator;
pub(crate) mod hashing;
pub(crate) mod override_eval;
pub(crate) mod poll_service;
pub(crate) mod sdk_key;
pub(crate) mod semver;
