// SPDX-License-Identifier: MIT

//! Polling mode selector. Mirrors the upstream `configcat` crate's
//! `PollingMode` enum (variants, field names, defaults).

use std::time::Duration;

/// How the SDK keeps the cached config fresh.
///
/// - [`PollingMode::AutoPoll`]: background task fetches on a tick.
/// - [`PollingMode::LazyLoad`]: on-demand fetch when the cached entry
///   is older than `cache_refresh_interval`.
/// - [`PollingMode::ManualPoll`]: no automatic fetches; customer drives
///   [`crate::Client::force_refresh`] explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PollingMode {
    /// Background-task polling.
    AutoPoll {
        /// Interval between successive polls. Default: 60 s.
        poll_interval: Duration,
        /// Upper bound on the first fetch — `Client::builder().build()`
        /// returns once either the first fetch lands or this elapses.
        /// Default: 5 s.
        max_init_wait_time: Duration,
    },
    /// On-demand fetch when stale.
    LazyLoad {
        /// Staleness threshold. Default: 60 s.
        cache_refresh_interval: Duration,
    },
    /// No automatic fetches.
    ManualPoll,
}

impl PollingMode {
    /// Returns the [`PollingMode::AutoPoll`] variant with ConfigCat's
    /// documented defaults (60 s / 5 s).
    pub fn auto_poll_default() -> Self {
        PollingMode::AutoPoll {
            poll_interval: Duration::from_secs(60),
            max_init_wait_time: Duration::from_secs(5),
        }
    }

    /// Returns the [`PollingMode::LazyLoad`] variant with ConfigCat's
    /// documented default (60 s).
    pub fn lazy_load_default() -> Self {
        PollingMode::LazyLoad {
            cache_refresh_interval: Duration::from_secs(60),
        }
    }
}

impl Default for PollingMode {
    fn default() -> Self {
        PollingMode::auto_poll_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_poll_defaults() {
        match PollingMode::auto_poll_default() {
            PollingMode::AutoPoll {
                poll_interval,
                max_init_wait_time,
            } => {
                assert_eq!(poll_interval, Duration::from_secs(60));
                assert_eq!(max_init_wait_time, Duration::from_secs(5));
            }
            _ => panic!("expected AutoPoll"),
        }
    }

    #[test]
    fn lazy_load_default() {
        match PollingMode::lazy_load_default() {
            PollingMode::LazyLoad {
                cache_refresh_interval,
            } => {
                assert_eq!(cache_refresh_interval, Duration::from_secs(60));
            }
            _ => panic!("expected LazyLoad"),
        }
    }

    #[test]
    fn default_is_auto_poll() {
        assert!(matches!(
            PollingMode::default(),
            PollingMode::AutoPoll { .. }
        ));
    }
}
