// SPDX-License-Identifier: MIT

use super::Client;
use crate::hooks::FlagEvaluatedDetails;
use crate::internal::override_eval::FlatOverrideMode;
use crate::internal::sdk_key::redact_sdk_key;
use crate::{EvaluationDetails, User};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::atomic::Ordering;

impl Client {
    /// Resolves `key` and returns the typed [`EvaluationDetails<T>`]
    /// envelope. Mirrors upstream `configcat::Client::get_value_details`
    /// 1:1 — same name, same async-ness, same field semantics.
    ///
    /// Internally builds a [`crate::Snapshot`] and delegates to
    /// [`crate::Snapshot::get_value_details`] so the async and sync paths
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
        self.get_value_details_with_mode(key, default, user, FlatOverrideMode::Legacy)
            .await
    }

    #[cfg(feature = "openfeature")]
    pub(crate) fn has_default_user(&self) -> bool {
        self.default_user.is_some()
    }

    #[cfg(feature = "openfeature")]
    pub(crate) async fn get_value_details_strict(
        &self,
        key: &str,
        default: Value,
        user: Option<&User>,
    ) -> EvaluationDetails<Value> {
        self.get_value_details_with_mode(key, default, user, FlatOverrideMode::Strict)
            .await
    }

    // Both entry points use native polling and fire the same evaluation hook.
    async fn get_value_details_with_mode<T>(
        &self,
        key: &str,
        default: T,
        user: Option<&User>,
        mode: FlatOverrideMode,
    ) -> EvaluationDetails<T>
    where
        T: serde::Serialize + DeserializeOwned,
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
        let details = self
            .snapshot()
            .get_value_details_with_mode(key, default, user, mode);
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
}
