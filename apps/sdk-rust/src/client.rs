// SPDX-License-Identifier: MIT

//! Top-level customer-facing [`Client`] + fluent [`ClientBuilder`].
//!
//! Construct via `Client::builder(sdk_key).build()?`. The builder
//! mirrors the upstream `configcat` crate's surface 1:1.
//!
//! Concurrency: `get_value` / `snapshot` / `force_refresh` are safe
//! for concurrent use. `close(self)` consumes the client and cancels
//! every spawned task.

use crate::errors::{BuildError, RefreshError};
use crate::evaluation_details::{EvaluationDetails, Value as PrimitiveValue};
use crate::flag_overrides::{FlagOverrides, OverrideBehaviour, OverrideDataSource};
use crate::hooks::{FlagEvaluatedDetails, Hooks};
use crate::internal::cache::{make_cache, Cache, CacheEntry};
use crate::internal::config_fetcher::{ConfigFetcher, FetchStatus};
use crate::internal::evaluator;
use crate::internal::override_eval::{evaluate_override_routed, OverridesView};
use crate::internal::poll_service::{
    make_poll_service, FetchCallback, PollFetchResult, PollService,
};
use crate::internal::sdk_key::{derive_cache_key, is_valid_confeature_key_format, redact_sdk_key};
use crate::logger::{LogFacadeLogger, Logger};
use crate::polling_mode::PollingMode;
use crate::snapshot::Snapshot;
use crate::user::User;
use crate::VERSION;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Fluent builder for [`Client`]. Construct via [`Client::builder`].
pub struct ClientBuilder {
    sdk_key: String,
    polling_mode: PollingMode,
    cache_directory: Option<PathBuf>,
    http_timeout: Option<Duration>,
    base_url: Option<String>,
    logger: Option<Arc<dyn Logger>>,
    flag_overrides: Option<FlagOverrides>,
    http_client: Option<reqwest::Client>,
    default_user: Option<User>,
    hooks: Hooks,
}

impl ClientBuilder {
    /// Sets the polling mode. Default: `PollingMode::auto_poll_default()`.
    pub fn polling_mode(mut self, mode: PollingMode) -> Self {
        self.polling_mode = mode;
        self
    }

    /// Sets the on-disk cache directory. Pass [`crate::flag_overrides::OverrideBehaviour::LocalOnly`]
    /// to disable filesystem writes entirely by passing `":memory:"` as
    /// the path.
    pub fn cache_directory(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cache_directory = Some(dir.into());
        self
    }

    /// Sets the per-request HTTP timeout. Default: 30 s.
    pub fn http_timeout(mut self, timeout: Duration) -> Self {
        self.http_timeout = Some(timeout);
        self
    }

    /// Sets the CDN base URL. Default: `https://cdn-global.confeature.io`.
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into());
        self
    }

    /// Sets the logger. Default: [`LogFacadeLogger`] at
    /// [`crate::LogLevel::Error`].
    pub fn logger(mut self, logger: Arc<dyn Logger>) -> Self {
        self.logger = Some(logger);
        self
    }

    /// Sets the flag-override bundle.
    pub fn flag_overrides(mut self, overrides: FlagOverrides) -> Self {
        self.flag_overrides = Some(overrides);
        self
    }

    /// Injects a custom `reqwest::Client` (useful for testing against
    /// `wiremock` or for sharing connection pools with the host app).
    ///
    /// The config URL carries the SDK key. The client the SDK builds
    /// itself disables `Referer`, so a redirect never hands that URL to
    /// the next host; an injected client keeps its own settings — build it
    /// with `reqwest::ClientBuilder::referer(false)` for the same guarantee.
    pub fn http_client(mut self, client: reqwest::Client) -> Self {
        self.http_client = Some(client);
        self
    }

    /// Sets the default [`User`] applied when `get_value` is called
    /// with `user = None`.
    pub fn default_user(mut self, user: User) -> Self {
        self.default_user = Some(user);
        self
    }

    /// Replaces the builder's [`Hooks`] hub with a pre-assembled one.
    ///
    /// Confeature-SUPERSET surface (epic #574 / #578) — additive over the
    /// upstream `configcat` crate, which has no hooks API. Listeners
    /// registered here are merged with any added via the `on_*` convenience
    /// methods (the convenience methods append to the current `hooks`).
    pub fn hooks(mut self, hooks: Hooks) -> Self {
        self.hooks = hooks;
        self
    }

    /// Registers a client-ready listener (fired once, the first time a
    /// config becomes available — cache hydrate or first successful fetch).
    /// Confeature-SUPERSET surface — see [`Hooks`].
    pub fn on_client_ready<F>(mut self, f: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.hooks.add_on_client_ready(f);
        self
    }

    /// Registers a config-changed listener (fired on a freshly-fetched
    /// config — the FETCHED path, NOT a 304 Not Modified).
    /// Confeature-SUPERSET surface — see [`Hooks`].
    pub fn on_config_changed<F>(mut self, f: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.hooks.add_on_config_changed(f);
        self
    }

    /// Registers a flag-evaluated listener (fired on each
    /// [`Client::get_value_details`] evaluation).
    /// Confeature-SUPERSET surface — see [`Hooks`].
    pub fn on_flag_evaluated<F>(mut self, f: F) -> Self
    where
        F: Fn(&FlagEvaluatedDetails) + Send + Sync + 'static,
    {
        self.hooks.add_on_flag_evaluated(f);
        self
    }

    /// Registers an error listener (fired on a failed fetch / error path).
    /// Confeature-SUPERSET surface — see [`Hooks`].
    pub fn on_error<F>(mut self, f: F) -> Self
    where
        F: Fn(&str) + Send + Sync + 'static,
    {
        self.hooks.add_on_error(f);
        self
    }

    /// Validates configuration + builds the [`Client`].
    ///
    /// Validation:
    /// - Empty SDK key                              → [`BuildError::InvalidSdkKey`].
    /// - Invalid SDK-key format                     → logged WARN (redacted), continues.
    /// - `http_timeout` set to `Duration::ZERO`     → [`BuildError::InvalidOption`].
    /// - `flag_overrides` with a deferred behaviour → accepted; the
    ///   evaluator returns the supplied default at eval time.
    ///
    /// `Client::builder` is NOT async; constructing the client does
    /// not perform I/O. The eager initial fetch happens when the
    /// returned client's polling-mode task is started (AutoPoll only),
    /// which is scheduled on the current Tokio runtime.
    pub fn build(self) -> Result<Client, BuildError> {
        if self.sdk_key.is_empty() {
            return Err(BuildError::InvalidSdkKey);
        }
        if let Some(t) = self.http_timeout {
            if t.is_zero() {
                return Err(BuildError::InvalidOption("http_timeout must be > 0".into()));
            }
        }
        let logger: Arc<dyn Logger> = self
            .logger
            .unwrap_or_else(|| Arc::new(LogFacadeLogger::default()));

        if !is_valid_confeature_key_format(&self.sdk_key) {
            logger.warning(&format!(
                "INVALID_SDK_KEY format; continuing — runtime is lenient (sdkKey={})",
                redact_sdk_key(&self.sdk_key)
            ));
        }

        let cache_key = derive_cache_key(&self.sdk_key);
        let cache: Arc<dyn Cache> = Arc::from(make_cache(
            self.cache_directory.clone(),
            &cache_key,
            self.sdk_key.clone(),
            logger.clone(),
        ));

        let fetcher = Arc::new(
            ConfigFetcher::new(
                self.base_url,
                self.sdk_key.clone(),
                VERSION,
                self.http_timeout,
                self.http_client,
                logger.clone(),
            )
            .map_err(BuildError::InvalidOption)?,
        );

        let poll = make_poll_service(self.polling_mode);

        let config_slot: Arc<RwLock<Option<Value>>> = Arc::new(RwLock::new(None));
        let etag_slot: Arc<RwLock<Option<String>>> = Arc::new(RwLock::new(None));
        let fetch_time_slot: Arc<AtomicI64> = Arc::new(AtomicI64::new(0));

        // Freeze the hooks hub behind an Arc shared with the poll task
        // (build-time/immutable-after-build → no lock on the emission hot
        // path; see `hooks` module docs, design decision #3).
        let hooks = Arc::new(self.hooks);

        // Restore any persisted cache entry so the first get_value can
        // resolve against on-disk state before the first fetch lands.
        if let Some(entry) = cache.read() {
            if let Ok(mut g) = config_slot.write() {
                *g = Some(entry.body.clone());
            }
            if let Ok(mut g) = etag_slot.write() {
                *g = Some(entry.etag.clone());
            }
            // Cache `fetched_at` is epoch seconds (f64) — widen to millis
            // for the EvaluationDetails contract.
            let millis = (entry.fetched_at * 1000.0) as i64;
            fetch_time_slot.store(millis, Ordering::Relaxed);
            // Config became available from on-disk state — this is the
            // first "client ready" signal (one-shot; latched in Hooks).
            hooks.fire_client_ready();
        }

        let client = Client {
            sdk_key: self.sdk_key,
            logger,
            flag_overrides: self.flag_overrides,
            default_user: self.default_user,
            fetcher,
            cache,
            poll: poll.clone(),
            config: config_slot,
            etag: etag_slot,
            fetch_time_unix_millis: fetch_time_slot,
            closed: Arc::new(AtomicBool::new(false)),
            offline: Arc::new(AtomicBool::new(false)),
            hooks,
        };

        // Skip starting the poll service when LocalOnly overrides are in
        // effect — the override-eval path handles every call, no fetch
        // needed (matches Python's offline-LocalOnly behaviour).
        let should_start = !matches!(
            client.flag_overrides.as_ref().map(FlagOverrides::behaviour),
            Some(OverrideBehaviour::LocalOnly)
        );
        if should_start {
            let cb = client.fetch_callback();
            // Best-effort: if no Tokio runtime is available, fall back
            // to manual-poll semantics (the polling task simply isn't
            // started). This keeps the builder usable from sync tests.
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let p = poll.clone();
                handle.spawn(async move {
                    p.start(cb).await;
                });
            }
        }

        Ok(client)
    }
}

/// Top-level entry point. Construct via [`Client::builder`].
///
/// Cloning is intentionally NOT implemented — the consuming `close(self)`
/// API would be ambiguous on a clonable handle. Customers needing a
/// shared handle wrap in `Arc<Client>` at the call site.
///
/// [`std::fmt::Debug`] is implemented manually so neither the raw SDK
/// key nor any internal channel state leaks into a `{:?}` print site.
pub struct Client {
    sdk_key: String,
    logger: Arc<dyn Logger>,
    flag_overrides: Option<FlagOverrides>,
    default_user: Option<User>,
    fetcher: Arc<ConfigFetcher>,
    cache: Arc<dyn Cache>,
    poll: Arc<dyn PollService>,
    config: Arc<RwLock<Option<Value>>>,
    etag: Arc<RwLock<Option<String>>>,
    /// Wall-clock time (epoch milliseconds) of the active config's last
    /// successful fetch. Populated on fetch + cache restore; surfaced by
    /// [`Client::get_value_details`] and [`Snapshot::get_value_details`].
    fetch_time_unix_millis: Arc<AtomicI64>,
    closed: Arc<AtomicBool>,
    /// Spec 095 / #267 — mirrors `configcat::Client.is_offline()`. Cloned into the
    /// `fetch_callback` closure so the AutoPoll task + LazyLoad on-demand fetch + ManualPoll
    /// force_refresh all observe the same flag.
    offline: Arc<AtomicBool>,
    /// Confeature-SUPERSET hooks hub (epic #574 / #578). Shared with the
    /// poll task's fetch callback for the ready / config-changed / error
    /// emissions; consulted inline by `get_value_details` for the
    /// flag-evaluated emission. Frozen at build time (no lock on emit).
    hooks: Arc<Hooks>,
}

impl Client {
    /// Returns a fluent [`ClientBuilder`] seeded with `sdk_key`.
    pub fn builder(sdk_key: impl Into<String>) -> ClientBuilder {
        ClientBuilder {
            sdk_key: sdk_key.into(),
            polling_mode: PollingMode::default(),
            cache_directory: None,
            http_timeout: None,
            base_url: None,
            logger: None,
            flag_overrides: None,
            http_client: None,
            default_user: None,
            hooks: Hooks::new(),
        }
    }

    fn fetch_callback(&self) -> FetchCallback {
        let fetcher = self.fetcher.clone();
        let cache = self.cache.clone();
        let config = self.config.clone();
        let etag = self.etag.clone();
        let fetch_time = self.fetch_time_unix_millis.clone();
        let offline = self.offline.clone();
        let hooks = self.hooks.clone();
        Arc::new(move || {
            let fetcher = fetcher.clone();
            let cache = cache.clone();
            let config = config.clone();
            let etag = etag.clone();
            let fetch_time = fetch_time.clone();
            let offline = offline.clone();
            let hooks = hooks.clone();
            Box::pin(async move {
                if offline.load(Ordering::SeqCst) {
                    // Offline — no HTTP. Mirrors upstream's "OFFLINE_MODE" semantics.
                    return PollFetchResult {
                        ok: false,
                        error: Some("OFFLINE_MODE".to_string()),
                    };
                }
                let prev_etag = etag.read().ok().and_then(|g| g.clone());
                let r = fetcher.fetch(prev_etag.as_deref()).await;
                match r.status {
                    FetchStatus::Fetched => {
                        if let Some(body) = r.body.clone() {
                            if let Ok(mut g) = config.write() {
                                *g = Some(body.clone());
                            }
                            if let Ok(mut g) = etag.write() {
                                *g = r.etag.clone();
                            }
                            let now_millis = now_unix_millis();
                            fetch_time.store(now_millis, Ordering::Relaxed);
                            cache.write(&CacheEntry {
                                body,
                                etag: r.etag.unwrap_or_default(),
                                fetched_at: CacheEntry::now_seconds(),
                            });
                            // A fresh config landed (FETCHED path, NOT 304):
                            // config-changed fires every time; client-ready
                            // fires once (latched in Hooks).
                            hooks.fire_client_ready();
                            hooks.fire_config_changed();
                        }
                        PollFetchResult {
                            ok: true,
                            error: None,
                        }
                    }
                    FetchStatus::NotModified => {
                        if let Some(new_etag) = r.etag.clone() {
                            if let Ok(mut g) = etag.write() {
                                *g = Some(new_etag);
                            }
                        }
                        // Validated-still-fresh is still a "fetch event"
                        // — refresh the wall-clock so customers see the
                        // latest probe time.
                        fetch_time.store(now_unix_millis(), Ordering::Relaxed);
                        PollFetchResult {
                            ok: true,
                            error: None,
                        }
                    }
                    FetchStatus::Failed => {
                        // Failed fetch / error path — fire the error hook
                        // with the fetcher's key-free reason code.
                        let reason = r.error.clone().unwrap_or_default();
                        hooks.fire_error(&reason);
                        PollFetchResult {
                            ok: false,
                            error: r.error,
                        }
                    }
                }
            })
        })
    }

    /// Resolves `key` with the supplied `default`. Returns `default`
    /// and logs a warning when the client is closed, the setting type
    /// discriminator is unknown, the default's type does not match the
    /// setting's type, or the cache is empty.
    ///
    /// The four-type evaluator (`SettingType` = boolean / string / int /
    /// double; see `internal::evaluator`) resolves every `T ∈ {bool,
    /// String, i64, f64}` against the corresponding setting type. `T`
    /// must implement `serde::Serialize + Deserialize` — the default
    /// and the resolved value round-trip through `serde_json::Value`,
    /// so any `T` that serialises to one of the four JSON kinds the
    /// evaluator emits resolves cleanly; for other `T`s the call falls
    /// back to the supplied default when `from_value` fails.
    pub async fn get_value<T>(&self, key: &str, default: T, user: Option<&User>) -> T
    where
        T: serde::Serialize + DeserializeOwned + Clone,
    {
        let default_value = match serde_json::to_value(&default) {
            Ok(v) => v,
            Err(_) => return default,
        };
        let resolved = self.get_value_inner(key, &default_value, user).await;
        match serde_json::from_value(resolved) {
            Ok(v) => v,
            Err(_) => default,
        }
    }

    /// Synchronous variant — resolves against the current snapshot
    /// without any I/O (no LazyLoad refresh, no poll start). Mirrors
    /// [`Client::get_value`]'s four-type evaluator behaviour: `T ∈
    /// {bool, String, i64, f64}` resolves against the matching
    /// `SettingType`; other `T`s fall back to the supplied default
    /// when the round-trip through `serde_json::Value` fails.
    pub fn get_value_sync<T>(&self, key: &str, default: T, user: Option<&User>) -> T
    where
        T: serde::Serialize + DeserializeOwned + Clone,
    {
        let default_value = match serde_json::to_value(&default) {
            Ok(v) => v,
            Err(_) => return default,
        };
        let resolved = self.snapshot().get_value_inner(key, &default_value, user);
        match serde_json::from_value(resolved) {
            Ok(v) => v,
            Err(_) => default,
        }
    }

    async fn get_value_inner(&self, key: &str, default: &Value, user: Option<&User>) -> Value {
        if self.closed.load(Ordering::SeqCst) {
            self.logger.warning(&format!(
                "get_value called after close (sdkKey={}, key={})",
                redact_sdk_key(&self.sdk_key),
                key
            ));
            return default.clone();
        }

        // Override path FIRST. The router (spec 135 / #436) threads the
        // user so a full-config override source resolves targeting rules
        // through the real evaluator; the flat-map source keeps the
        // byte-identical value-only path.
        if let Some(view) = self.overrides_view() {
            let eval_user = user.or(self.default_user.as_ref());
            let (handled, v) =
                evaluate_override_routed(Some(view.as_ref()), key, default, eval_user);
            if handled {
                return v.unwrap_or_else(|| default.clone());
            }
            if let Some(fo) = &self.flag_overrides {
                if fo.behaviour() != OverrideBehaviour::LocalOnly {
                    self.logger.warning(&format!(
                        "override behaviour not implemented (sdkKey={}, behaviour={:?})",
                        redact_sdk_key(&self.sdk_key),
                        fo.behaviour()
                    ));
                }
            }
        }

        // LazyLoad: trigger an on-demand fetch if stale.
        self.poll.maybe_fetch_for_get_value().await;

        let config = self.config.read().ok().and_then(|g| g.clone());
        let eval_user = user.or(self.default_user.as_ref());
        let r = evaluator::evaluate(config.as_ref(), key, default, eval_user);
        r.value
    }

    /// Returns an immutable [`Snapshot`] of the last-known config + a
    /// detached reference to the flag-override view.
    pub fn snapshot(&self) -> Snapshot {
        let config = self.config.read().ok().and_then(|g| g.clone());
        Snapshot::new(
            config,
            self.overrides_view(),
            self.default_user.clone(),
            self.fetch_time_unix_millis.load(Ordering::Relaxed),
        )
    }

    /// Resolves `key` and returns the typed [`EvaluationDetails<T>`]
    /// envelope. Mirrors upstream `configcat::Client::get_value_details`
    /// 1:1 — same name, same async-ness, same field semantics.
    ///
    /// Internally builds a [`Snapshot`] and delegates to
    /// [`Snapshot::get_value_details`] so the async and sync paths
    /// share the resolution + error-code wiring. The async behaviour
    /// is preserved (LazyLoad refresh, closed-client check) on the
    /// client side before the snapshot is built.
    pub async fn get_value_details<T>(
        &self,
        key: &str,
        default: T,
        user: Option<&User>,
    ) -> EvaluationDetails<T>
    where
        T: serde::Serialize + DeserializeOwned + Clone,
    {
        if self.closed.load(Ordering::SeqCst) {
            self.logger.warning(&format!(
                "get_value_details called after close (sdkKey={}, key={})",
                redact_sdk_key(&self.sdk_key),
                key
            ));
            // `close()` consumes `self` in Rust — this branch is only
            // reachable when a clone of the internal `closed` flag flips
            // (e.g. mid-call concurrent close on a wrapping `Arc<Client>`).
            return EvaluationDetails::err(
                key,
                default,
                self.fetch_time_unix_millis.load(Ordering::Relaxed),
                user.cloned().or_else(|| self.default_user.clone()),
                "CLIENT_CLOSED",
            );
        }
        // LazyLoad: trigger an on-demand fetch if stale.
        self.poll.maybe_fetch_for_get_value().await;
        let details = self.snapshot().get_value_details(key, default, user);
        // Confeature-SUPERSET flag-evaluated hook (epic #574 / #578). Fired
        // inline on the caller's task with a type-erased view of the result.
        // Short-circuit the serialize when no listener is registered.
        if !self.hooks.is_empty() {
            let value = serde_json::to_value(&details.value).unwrap_or(Value::Null);
            self.hooks.fire_flag_evaluated(&FlagEvaluatedDetails {
                key: details.key.clone(),
                value,
                variation_id: details.variation_id.clone(),
                is_default_value: details.is_default_value,
                error: details.error.clone(),
            });
        }
        details
    }

    /// Returns the aggregate `(key, value)` view across the cached
    /// config + override map (overrides supersede cache on key
    /// collisions). Mirrors upstream `configcat::Client::get_all_values`
    /// 1:1 — same name, same async-ness; the return type is a
    /// `HashMap<String, Value>` where [`crate::Value`] is a 4-variant
    /// primitive enum byte-identical in JSON shape to upstream's `Value`.
    pub async fn get_all_values(&self, user: Option<&User>) -> HashMap<String, PrimitiveValue> {
        let _ = user; // v1 evaluator ignores the user; signature is for API parity.
        if self.closed.load(Ordering::SeqCst) {
            return HashMap::new();
        }
        // LazyLoad: trigger an on-demand fetch if stale.
        self.poll.maybe_fetch_for_get_value().await;
        self.snapshot().get_all_values()
    }

    /// Triggers an immediate fetch + cache update. Returns when the
    /// fetch completes.
    pub async fn force_refresh(&self) -> Result<(), RefreshError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(RefreshError::ClientClosed);
        }
        if let Some(fo) = &self.flag_overrides {
            if fo.behaviour() == OverrideBehaviour::LocalOnly {
                // LocalOnly never fetches; treat refresh as a no-op success.
                return Ok(());
            }
        }
        if self.offline.load(Ordering::SeqCst) {
            // Offline — no HTTP. Mirrors upstream's "OFFLINE_MODE" semantics.
            return Err(RefreshError::Offline);
        }
        // Make sure the callback is registered (ManualPoll / LazyLoad
        // would otherwise return "not started"). start() is idempotent
        // on AutoPoll.
        self.poll.start(self.fetch_callback()).await;
        let r = self.poll.force_refresh().await;
        if r.success {
            Ok(())
        } else {
            Err(RefreshError::FetchFailed {
                reason: r.error.unwrap_or_default(),
            })
        }
    }

    /// Suspends HTTP polling; subsequent reads serve from the cached config.
    /// Idempotent.
    ///
    /// Mirrors `configcat::Client.offline()` (spec 095 / #267). Closed clients log a warning and
    /// no-op. LocalOnly clients are a silent no-op (LocalOnly never polls).
    pub fn offline(&self) {
        if self.closed.load(Ordering::SeqCst) {
            self.logger.warning(&format!(
                "offline called after close. sdkKey={}",
                redact_sdk_key(&self.sdk_key)
            ));
            return;
        }
        if let Some(fo) = &self.flag_overrides {
            if fo.behaviour() == OverrideBehaviour::LocalOnly {
                return;
            }
        }
        self.offline.store(true, Ordering::SeqCst);
    }

    /// Re-enables HTTP polling. Idempotent.
    ///
    /// Mirrors `configcat::Client.online()` (spec 095 / #267). Closed clients log a warning and
    /// no-op. LocalOnly clients log a warning and no-op (LocalOnly never polls — the flag has
    /// no effect).
    pub fn online(&self) {
        if self.closed.load(Ordering::SeqCst) {
            self.logger.warning(&format!(
                "online called after close. sdkKey={}",
                redact_sdk_key(&self.sdk_key)
            ));
            return;
        }
        if let Some(fo) = &self.flag_overrides {
            if fo.behaviour() == OverrideBehaviour::LocalOnly {
                self.logger.warning(&format!(
                    "Client is configured to use the LocalOnly override behaviour, thus online has \
                     no effect. sdkKey={}",
                    redact_sdk_key(&self.sdk_key)
                ));
                return;
            }
        }
        self.offline.store(false, Ordering::SeqCst);
    }

    /// Returns `true` when HTTP polling is suspended.
    ///
    /// Mirrors `configcat::Client.is_offline()` (spec 095 / #267). Closed clients return `true`.
    /// LocalOnly clients return `true` (mirrors upstream — LocalOnly never polls, so the client
    /// is always "offline" with respect to remote config).
    pub fn is_offline(&self) -> bool {
        if self.closed.load(Ordering::SeqCst) {
            return true;
        }
        if let Some(fo) = &self.flag_overrides {
            if fo.behaviour() == OverrideBehaviour::LocalOnly {
                return true;
            }
        }
        self.offline.load(Ordering::SeqCst)
    }

    /// Consuming close — cancels every spawned task. Idempotent in
    /// the sense that the underlying poll service's stop() is
    /// idempotent; the consuming signature prevents double-close at
    /// the type level.
    pub fn close(self) {
        // Mark closed BEFORE stopping so any racing get_value sees
        // the flag and returns the default.
        self.closed.store(true, Ordering::SeqCst);
        self.poll.stop();
    }

    /// Returns a heap-allocated [`OverridesView`] adapter when
    /// overrides are configured. Decouples the public
    /// `FlagOverrides` type from the internal `override_eval`
    /// trait.
    fn overrides_view(&self) -> Option<Box<dyn OverridesView>> {
        let fo = self.flag_overrides.as_ref()?;
        // `OverrideDataSource: Send + Sync`, so we can hold a `&dyn`
        // borrow alongside the behaviour. To avoid lifetime gymnastics
        // we materialise the snapshot map (+ any full config, INV-4) once
        // per call here.
        let map = fo.data_source.get_overrides_sync();
        let full_config = fo.data_source.full_config().cloned();
        Some(Box::new(StaticOverridesView {
            map,
            behaviour: fo.behaviour(),
            full_config,
        }))
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        // Safety net for customers who forget to call close().
        self.closed.store(true, Ordering::SeqCst);
        self.poll.stop();
    }
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // NEVER print the raw SDK key — pass through `redact_sdk_key`.
        f.debug_struct("Client")
            .field("sdk_key", &redact_sdk_key(&self.sdk_key))
            .field("closed", &self.closed.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for ClientBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientBuilder")
            .field("sdk_key", &redact_sdk_key(&self.sdk_key))
            .field("polling_mode", &self.polling_mode)
            .field("cache_directory", &self.cache_directory)
            .field("http_timeout", &self.http_timeout)
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

/// Internal [`OverridesView`] adapter that owns a snapshot of the
/// override map taken at evaluation time. Snapshotting avoids
/// borrowing the customer's `&dyn OverrideDataSource` across the
/// evaluator boundary.
pub(crate) struct StaticOverridesView {
    pub(crate) map: Option<HashMap<String, Value>>,
    pub(crate) behaviour: OverrideBehaviour,
    /// The full `{p, f, s}` config when the source is a full-config
    /// source (spec 135 / #436). `None` for flat value-only sources;
    /// drives the router's dispatch (INV-4: salt + segments retained).
    pub(crate) full_config: Option<Value>,
}

impl OverridesView for StaticOverridesView {
    fn get_overrides_sync(&self) -> Option<HashMap<String, Value>> {
        self.map.clone()
    }
    fn behaviour(&self) -> OverrideBehaviour {
        self.behaviour
    }
    fn full_config(&self) -> Option<&Value> {
        self.full_config.as_ref()
    }
}

/// Re-exported convenience: takes any [`OverrideDataSource`] and
/// produces a [`StaticOverridesView`] snapshot.
#[allow(dead_code)]
pub(crate) fn snapshot_view(
    ds: &dyn OverrideDataSource,
    behaviour: OverrideBehaviour,
) -> StaticOverridesView {
    StaticOverridesView {
        map: ds.get_overrides_sync(),
        behaviour,
        full_config: ds.full_config().cloned(),
    }
}

/// Returns the current wall-clock as epoch milliseconds. Used to
/// stamp `EvaluationDetails::fetch_time_unix_millis` at fetch and
/// cache-restore sites.
fn now_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}
