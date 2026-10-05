// SPDX-License-Identifier: MIT

//! Poll-service trait + 3 implementations (AutoPoll / LazyLoad /
//! ManualPoll).
//!
//! Lifecycle:
//! - `start(callback)` is idempotent. AutoPoll fetches once eagerly
//!   then spawns its background task. LazyLoad / ManualPoll record
//!   the callback without spawning anything.
//! - `force_refresh()` invokes the callback synchronously.
//! - `stop()` cancels the background task (AutoPoll only) via
//!   `JoinHandle::abort()`. Idempotent.

use crate::polling_mode::PollingMode;
use async_trait::async_trait;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

/// Result envelope returned by callback invocations. Mirrors the Go
/// `pollservice.FetchResult` — defined locally so this module doesn't
/// import `internal/config_fetcher` (clean dependency graph).
#[derive(Debug, Clone)]
pub(crate) struct PollFetchResult {
    pub ok: bool,
    pub error: Option<String>,
}

/// Boxed async fetch primitive shared between the poll service and the
/// client. Returns a [`PollFetchResult`].
pub(crate) type FetchCallback =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = PollFetchResult> + Send>> + Send + Sync + 'static>;

/// Result envelope returned by `force_refresh`. Mirrors
/// `crate::RefreshError` at the I/O boundary.
#[derive(Debug, Clone)]
pub(crate) struct RefreshOutcome {
    pub success: bool,
    pub error: Option<String>,
}

/// Polymorphic poll-service trait. The three concrete impls below are
/// returned via [`make_poll_service`].
#[async_trait]
pub(crate) trait PollService: Send + Sync {
    /// Records the callback. AutoPoll additionally fetches once
    /// eagerly + spawns the background task. Idempotent.
    async fn start(&self, callback: FetchCallback);
    /// Stops the background task (AutoPoll only). Idempotent.
    fn stop(&self);
    /// Invokes the callback synchronously.
    async fn force_refresh(&self) -> RefreshOutcome;
    /// LazyLoad on-demand hook. Other modes return immediately.
    async fn maybe_fetch_for_get_value(&self);
}

/// Builds the right [`PollService`] for the given polling mode.
pub(crate) fn make_poll_service(mode: PollingMode) -> Arc<dyn PollService> {
    match mode {
        PollingMode::AutoPoll {
            poll_interval,
            max_init_wait_time,
        } => Arc::new(AutoPollService::new(poll_interval, max_init_wait_time)),
        PollingMode::LazyLoad {
            cache_refresh_interval,
        } => Arc::new(LazyLoadService::new(cache_refresh_interval)),
        PollingMode::ManualPoll => Arc::new(ManualPollService::default()),
    }
}

// ---------------------------------------------------------------------
// AutoPoll
// ---------------------------------------------------------------------

pub(crate) struct AutoPollService {
    poll_interval: Duration,
    max_init_wait_time: Duration,
    started: AtomicBool,
    stopped: AtomicBool,
    callback: Mutex<Option<FetchCallback>>,
    handle: Mutex<Option<JoinHandle<()>>>,
}

impl AutoPollService {
    fn new(poll_interval: Duration, max_init_wait_time: Duration) -> Self {
        Self {
            poll_interval: if poll_interval.is_zero() {
                Duration::from_secs(60)
            } else {
                poll_interval
            },
            max_init_wait_time,
            started: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            callback: Mutex::new(None),
            handle: Mutex::new(None),
        }
    }

    async fn invoke(callback: &FetchCallback) -> PollFetchResult {
        (callback)().await
    }
}

#[async_trait]
impl PollService for AutoPollService {
    async fn start(&self, callback: FetchCallback) {
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut slot) = self.callback.lock() {
            *slot = Some(callback.clone());
        }

        // Eager initial fetch — bounded by max_init_wait_time when
        // positive so a slow first fetch doesn't block builder.build().
        let init_fut = Self::invoke(&callback);
        if self.max_init_wait_time.is_zero() {
            let _ = init_fut.await;
        } else {
            let _ = tokio::time::timeout(self.max_init_wait_time, init_fut).await;
        }

        let interval = self.poll_interval;
        let cb = callback.clone();
        let handle = tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // First tick fires immediately; consume it so we don't
            // double-fetch right after the eager initial call.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let _ = (cb)().await;
            }
        });
        if let Ok(mut slot) = self.handle.lock() {
            *slot = Some(handle);
        }
    }

    fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut slot) = self.handle.lock() {
            if let Some(h) = slot.take() {
                h.abort();
            }
        }
    }

    async fn force_refresh(&self) -> RefreshOutcome {
        let cb = match self.callback.lock().ok().and_then(|g| g.clone()) {
            Some(c) => c,
            None => {
                return RefreshOutcome {
                    success: false,
                    error: Some("poll service not started".into()),
                }
            }
        };
        let r = (cb)().await;
        RefreshOutcome {
            success: r.ok,
            error: r.error,
        }
    }

    async fn maybe_fetch_for_get_value(&self) {}
}

impl Drop for AutoPollService {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---------------------------------------------------------------------
// LazyLoad
// ---------------------------------------------------------------------

pub(crate) struct LazyLoadService {
    cache_refresh_interval: Duration,
    callback: Mutex<Option<FetchCallback>>,
    last_fetched_at_ns: AtomicI64,
}

impl LazyLoadService {
    fn new(cache_refresh_interval: Duration) -> Self {
        Self {
            cache_refresh_interval: if cache_refresh_interval.is_zero() {
                Duration::from_secs(60)
            } else {
                cache_refresh_interval
            },
            callback: Mutex::new(None),
            last_fetched_at_ns: AtomicI64::new(0),
        }
    }

    fn now_ns() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as i64)
            .unwrap_or(0)
    }
}

#[async_trait]
impl PollService for LazyLoadService {
    async fn start(&self, callback: FetchCallback) {
        if let Ok(mut slot) = self.callback.lock() {
            *slot = Some(callback);
        }
    }

    fn stop(&self) {}

    async fn force_refresh(&self) -> RefreshOutcome {
        let cb = match self.callback.lock().ok().and_then(|g| g.clone()) {
            Some(c) => c,
            None => {
                return RefreshOutcome {
                    success: false,
                    error: Some("poll service not started".into()),
                }
            }
        };
        let r = (cb)().await;
        if r.ok {
            self.last_fetched_at_ns
                .store(Self::now_ns(), Ordering::SeqCst);
        }
        RefreshOutcome {
            success: r.ok,
            error: r.error,
        }
    }

    async fn maybe_fetch_for_get_value(&self) {
        let cb = match self.callback.lock().ok().and_then(|g| g.clone()) {
            Some(c) => c,
            None => return,
        };
        let last = self.last_fetched_at_ns.load(Ordering::SeqCst);
        if last != 0 {
            let elapsed_ns = Self::now_ns().saturating_sub(last);
            let elapsed_ms = (elapsed_ns / 1_000_000) as u64;
            if Duration::from_millis(elapsed_ms) < self.cache_refresh_interval {
                return;
            }
        }
        let r = (cb)().await;
        if r.ok {
            self.last_fetched_at_ns
                .store(Self::now_ns(), Ordering::SeqCst);
        }
    }
}

// ---------------------------------------------------------------------
// ManualPoll
// ---------------------------------------------------------------------

#[derive(Default)]
pub(crate) struct ManualPollService {
    callback: Mutex<Option<FetchCallback>>,
}

#[async_trait]
impl PollService for ManualPollService {
    async fn start(&self, callback: FetchCallback) {
        if let Ok(mut slot) = self.callback.lock() {
            *slot = Some(callback);
        }
    }

    fn stop(&self) {}

    async fn force_refresh(&self) -> RefreshOutcome {
        let cb = match self.callback.lock().ok().and_then(|g| g.clone()) {
            Some(c) => c,
            None => {
                return RefreshOutcome {
                    success: false,
                    error: Some("poll service not started".into()),
                }
            }
        };
        let r = (cb)().await;
        RefreshOutcome {
            success: r.ok,
            error: r.error,
        }
    }

    async fn maybe_fetch_for_get_value(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn counting_callback() -> (Arc<AtomicUsize>, FetchCallback) {
        let counter = Arc::new(AtomicUsize::new(0));
        let cb_counter = counter.clone();
        let cb: FetchCallback = Arc::new(move || {
            let c = cb_counter.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
                PollFetchResult {
                    ok: true,
                    error: None,
                }
            })
        });
        (counter, cb)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn manual_poll_force_refresh_invokes_callback() {
        let svc = ManualPollService::default();
        let (counter, cb) = counting_callback();
        svc.start(cb).await;
        let r = svc.force_refresh().await;
        assert!(r.success);
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lazy_load_caches_within_interval() {
        let svc = LazyLoadService::new(Duration::from_secs(60));
        let (counter, cb) = counting_callback();
        svc.start(cb).await;
        svc.maybe_fetch_for_get_value().await;
        svc.maybe_fetch_for_get_value().await;
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn manual_poll_without_start_fails() {
        let svc = ManualPollService::default();
        let r = svc.force_refresh().await;
        assert!(!r.success);
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn auto_poll_runs_initial_fetch_and_stop_is_idempotent() {
        let svc = AutoPollService::new(Duration::from_millis(100), Duration::from_millis(10));
        let (counter, cb) = counting_callback();
        svc.start(cb).await;
        // The initial fetch ran once eagerly.
        assert!(counter.load(Ordering::SeqCst) >= 1);
        svc.stop();
        svc.stop(); // idempotent — no panic.
    }
}
