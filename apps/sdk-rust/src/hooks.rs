// SPDX-License-Identifier: MIT

//! Confeature-SUPERSET hooks API for the Rust SDK (epic #574 / issue #578).
//!
//! # Why this is a superset, not a mirror
//!
//! The upstream `configcat` Rust crate exposes **no** hooks API — there is
//! no `Hooks` struct, no `on_*` callbacks, no event surface to mirror
//! (verified against `configcat` 0.1.5). Principle II (NON-NEGOTIABLE)
//! requires Confeature to be a strict **superset** of the upstream public
//! surface; since upstream has nothing here, this module adds capability
//! without renaming, dropping, or retyping any ConfigCat-published member.
//! Nothing a `configcat` consumer references changes — the hooks are purely
//! additive (a `Hooks` value threaded through the existing `ClientBuilder`).
//!
//! Because there is no upstream Rust contract to copy, the surface mirrors
//! the cross-SDK ConfigCat hooks **concept** — the 4 canonical events
//! shared by the JS / Dart / Java SDKs — adapted to Rust idioms. The
//! design decisions are recorded below.
//!
//! # Design decisions
//!
//! 1. **The 4 canonical events.** `on_client_ready` (fired once, the first
//!    time a config becomes available — cache hydrate or first successful
//!    fetch), `on_config_changed` (a freshly-fetched config, i.e. the
//!    FETCHED path — NOT a 304 Not Modified), `on_flag_evaluated`
//!    (each `get_value_details` evaluation), and `on_error` (a failed
//!    fetch / error path). These are the events every multi-event
//!    ConfigCat SDK exposes.
//!
//! 2. **Multi-subscriber.** Each event holds a
//!    `Vec<Box<dyn Fn(..) + Send + Sync + 'static>>` — the dominant
//!    ConfigCat idiom (JS / Dart / Java are multi-subscriber; Go's
//!    single-field `Hooks` is the outlier). `Send + Sync + 'static`
//!    because callbacks may fire from the background polling thread.
//!
//! 3. **Build-time registration, immutable after build.** Listeners are
//!    registered on the [`ClientBuilder`](crate::ClientBuilder) before
//!    `build()` and the resulting [`Hooks`] is frozen into an `Arc` shared
//!    with the poll task. This deliberately simplifies the hot path: no
//!    `Mutex`/`RwLock` is taken on emission. A future dynamic variant
//!    (post-construction `add_listener`, as in upstream-Dart) can layer an
//!    `RwLock` behind the same `Hooks` type without changing the emission
//!    sites — but it is intentionally out of scope here.
//!
//! 4. **Synchronous, inline, panic-isolated emission.** Each listener runs
//!    inline at the emission site on the calling path (the poll thread for
//!    ready/changed/error, the caller's task for flag-evaluated).
//!    Listeners MUST be fast and non-blocking — a slow listener blocks the
//!    calling path. Each listener is wrapped in
//!    [`std::panic::catch_unwind`] so a panicking listener can neither
//!    poison its siblings nor unwind into SDK internals (which would, on
//!    the poll task, abort the background fetch loop).
//!
//! # Example
//!
//! ```no_run
//! use confeature::{Client, Hooks};
//! use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
//!
//! let ready = Arc::new(AtomicBool::new(false));
//! let ready_cb = ready.clone();
//!
//! let client = Client::builder("configcat-sdk-1/...")
//!     .on_client_ready(move || ready_cb.store(true, Ordering::SeqCst))
//!     .on_config_changed(|| println!("config refreshed"))
//!     .on_error(|err| eprintln!("fetch error: {err}"))
//!     .build()
//!     .unwrap();
//! # let _ = client;
//! ```

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};

/// Runs `f` under [`catch_unwind`] so a panicking listener can neither
/// poison its siblings nor unwind into SDK internals. The result is
/// discarded — a listener panic is swallowed by design (design decision
/// #4 in the module docs).
fn run_isolated<F: FnOnce()>(f: F) {
    let _ = catch_unwind(AssertUnwindSafe(f));
}

/// A non-generic, type-erased view of an evaluation result handed to
/// [`Hooks::on_flag_evaluated`] listeners.
///
/// The public [`EvaluationDetails<T>`](crate::EvaluationDetails) is generic
/// over the resolved value type `T`, which cannot be stored uniformly in a
/// single `Vec<Box<dyn Fn(..)>>` listener list. This struct erases `T` to a
/// [`serde_json::Value`] so one listener list serves every flag type —
/// mirroring the cross-SDK ConfigCat hook concept, where the evaluated-flag
/// callback carries an untyped details snapshot.
#[derive(Debug, Clone)]
pub struct FlagEvaluatedDetails {
    /// Key of the feature flag / setting that was evaluated.
    pub key: String,
    /// Resolved value (or the supplied default on a failure branch), erased
    /// to a JSON value.
    pub value: serde_json::Value,
    /// Variation ID of the resolved value, if the evaluator surfaced one.
    pub variation_id: Option<String>,
    /// `true` when the supplied default was returned (any failure branch).
    pub is_default_value: bool,
    /// Stable error code on a failure branch (`KEY_NOT_FOUND`,
    /// `TYPE_MISMATCH`, …); `None` on the happy path.
    pub error: Option<String>,
}

type ReadyListener = Box<dyn Fn() + Send + Sync + 'static>;
type ConfigChangedListener = Box<dyn Fn() + Send + Sync + 'static>;
type FlagEvaluatedListener = Box<dyn Fn(&FlagEvaluatedDetails) + Send + Sync + 'static>;
type ErrorListener = Box<dyn Fn(&str) + Send + Sync + 'static>;

/// Multi-subscriber event hub for the 4 canonical ConfigCat-concept events.
///
/// Construct via [`Hooks::default`] (or [`Hooks::new`]) and register
/// listeners with the `add_*` methods, or — the idiomatic path — use the
/// `on_*` builder methods on [`ClientBuilder`](crate::ClientBuilder), which
/// thread listeners into the builder's internal `Hooks` for you.
///
/// After `build()` the `Hooks` is frozen behind an `Arc`; emission takes no
/// lock (design decision #3). See the module docs for the full rationale.
#[derive(Default)]
pub struct Hooks {
    ready: Vec<ReadyListener>,
    config_changed: Vec<ConfigChangedListener>,
    flag_evaluated: Vec<FlagEvaluatedListener>,
    error: Vec<ErrorListener>,
    /// One-shot latch so `on_client_ready` fires at most once even if the
    /// SDK observes "config available" more than once (cache restore +
    /// first fetch).
    ready_fired: AtomicBool,
}

impl std::fmt::Debug for Hooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Closures are not Debug — print listener counts, not the funcs.
        f.debug_struct("Hooks")
            .field("ready", &self.ready.len())
            .field("config_changed", &self.config_changed.len())
            .field("flag_evaluated", &self.flag_evaluated.len())
            .field("error", &self.error.len())
            .field("ready_fired", &self.ready_fired.load(Ordering::SeqCst))
            .finish()
    }
}

impl Hooks {
    /// Constructs an empty [`Hooks`] with no listeners registered.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `true` when no listener is registered for any event. The
    /// emission sites short-circuit on this so the no-hooks hot path is
    /// free of any iteration.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.ready.is_empty()
            && self.config_changed.is_empty()
            && self.flag_evaluated.is_empty()
            && self.error.is_empty()
    }

    /// Registers a listener for the client-ready event (fired once).
    pub fn add_on_client_ready<F>(&mut self, f: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.ready.push(Box::new(f));
    }

    /// Registers a listener for the config-changed event (FETCHED path).
    pub fn add_on_config_changed<F>(&mut self, f: F)
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.config_changed.push(Box::new(f));
    }

    /// Registers a listener for the flag-evaluated event.
    pub fn add_on_flag_evaluated<F>(&mut self, f: F)
    where
        F: Fn(&FlagEvaluatedDetails) + Send + Sync + 'static,
    {
        self.flag_evaluated.push(Box::new(f));
    }

    /// Registers a listener for the error event.
    pub fn add_on_error<F>(&mut self, f: F)
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        self.error.push(Box::new(f));
    }

    /// Fires every client-ready listener — at most once across the client's
    /// lifetime. Subsequent calls are no-ops (the latch is set the first
    /// time). Each listener is panic-isolated.
    pub(crate) fn fire_client_ready(&self) {
        if self.ready_fired.swap(true, Ordering::SeqCst) {
            return;
        }
        for f in &self.ready {
            run_isolated(f);
        }
    }

    /// Fires every config-changed listener. Each listener is panic-isolated.
    pub(crate) fn fire_config_changed(&self) {
        for f in &self.config_changed {
            run_isolated(f);
        }
    }

    /// Fires every flag-evaluated listener. Each listener is panic-isolated.
    pub(crate) fn fire_flag_evaluated(&self, details: &FlagEvaluatedDetails) {
        for f in &self.flag_evaluated {
            run_isolated(|| f(details));
        }
    }

    /// Fires every error listener. Each listener is panic-isolated.
    pub(crate) fn fire_error(&self, err: &str) {
        for f in &self.error {
            run_isolated(|| f(err));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    #[test]
    fn each_event_fires() {
        let ready = Arc::new(AtomicUsize::new(0));
        let changed = Arc::new(AtomicUsize::new(0));
        let evaluated = Arc::new(AtomicUsize::new(0));
        let errored = Arc::new(AtomicUsize::new(0));

        let mut hooks = Hooks::new();
        {
            let c = ready.clone();
            hooks.add_on_client_ready(move || {
                c.fetch_add(1, Ordering::SeqCst);
            });
        }
        {
            let c = changed.clone();
            hooks.add_on_config_changed(move || {
                c.fetch_add(1, Ordering::SeqCst);
            });
        }
        {
            let c = evaluated.clone();
            hooks.add_on_flag_evaluated(move |_d| {
                c.fetch_add(1, Ordering::SeqCst);
            });
        }
        {
            let c = errored.clone();
            hooks.add_on_error(move |_e| {
                c.fetch_add(1, Ordering::SeqCst);
            });
        }

        hooks.fire_client_ready();
        hooks.fire_config_changed();
        hooks.fire_flag_evaluated(&FlagEvaluatedDetails {
            key: "k".into(),
            value: serde_json::json!(true),
            variation_id: None,
            is_default_value: false,
            error: None,
        });
        hooks.fire_error("boom");

        assert_eq!(ready.load(Ordering::SeqCst), 1);
        assert_eq!(changed.load(Ordering::SeqCst), 1);
        assert_eq!(evaluated.load(Ordering::SeqCst), 1);
        assert_eq!(errored.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn client_ready_fires_at_most_once() {
        let ready = Arc::new(AtomicUsize::new(0));
        let mut hooks = Hooks::new();
        let c = ready.clone();
        hooks.add_on_client_ready(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        hooks.fire_client_ready();
        hooks.fire_client_ready();
        hooks.fire_client_ready();
        assert_eq!(ready.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn multiple_subscribers_all_fire() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut hooks = Hooks::new();
        for _ in 0..3 {
            let c = counter.clone();
            hooks.add_on_config_changed(move || {
                c.fetch_add(1, Ordering::SeqCst);
            });
        }
        hooks.fire_config_changed();
        assert_eq!(counter.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn panicking_listener_does_not_poison_siblings() {
        let after = Arc::new(AtomicUsize::new(0));
        let mut hooks = Hooks::new();
        hooks.add_on_error(|_e| panic!("listener blew up"));
        let c = after.clone();
        hooks.add_on_error(move |_e| {
            c.fetch_add(1, Ordering::SeqCst);
        });
        // The first listener panics; the second MUST still run.
        hooks.fire_error("trigger");
        assert_eq!(after.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn is_empty_reflects_registration() {
        let mut hooks = Hooks::new();
        assert!(hooks.is_empty());
        hooks.add_on_error(|_e| {});
        assert!(!hooks.is_empty());
    }
}
