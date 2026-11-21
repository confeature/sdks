// SPDX-License-Identifier: MIT

//! Immutable view over the last-known config + a detached reference to
//! the flag-override bundle. All methods are synchronous and safe to
//! call after the source [`crate::Client`] has been closed.
//!
//! `Snapshot::get_value` consults overrides FIRST via the 7-branch
//! decision tree, then falls through to the cached config.

use crate::evaluation_details::{collect_all_values, EvaluationDetails, Value as PrimitiveValue};
use crate::internal::evaluator;
use crate::internal::override_eval::{
    evaluate_override_routed, evaluate_override_routed_details, FlatOverrideMode, OverridesView,
};
use crate::user::User;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;

/// Detached, immutable view over the last successfully-fetched config
/// plus a reference to the flag-override view. Construct via
/// [`crate::Client::snapshot`].
pub struct Snapshot {
    config: Option<Value>,
    overrides: Option<Box<dyn OverridesView>>,
    default_user: Option<User>,
    fetch_time_unix_millis: i64,
}

impl Snapshot {
    pub(crate) fn new(
        config: Option<Value>,
        overrides: Option<Box<dyn OverridesView>>,
        default_user: Option<User>,
        fetch_time_unix_millis: i64,
    ) -> Self {
        Self {
            config,
            overrides,
            default_user,
            fetch_time_unix_millis,
        }
    }

    /// Returns the wall-clock time (epoch milliseconds) of the active
    /// config's last successful fetch. `0` if no fetch has succeeded
    /// and no cache entry was restored.
    #[must_use]
    pub fn fetch_time_unix_millis(&self) -> i64 {
        self.fetch_time_unix_millis
    }

    /// Resolves `key` against the snapshot. Honours overrides
    /// synchronously before falling through to the cached config.
    pub fn get_value<T>(&self, key: &str, default: T, user: Option<&User>) -> T
    where
        T: serde::Serialize + DeserializeOwned + Clone,
    {
        let default_value = match serde_json::to_value(&default) {
            Ok(v) => v,
            Err(_) => return default,
        };
        let resolved = self.get_value_inner(key, &default_value, user);
        match serde_json::from_value(resolved) {
            Ok(v) => v,
            Err(_) => default,
        }
    }

    pub(crate) fn get_value_inner(&self, key: &str, default: &Value, user: Option<&User>) -> Value {
        let eval_user = user.or(self.default_user.as_ref());
        // Override path FIRST — spec-036 correctness. The router (spec 135
        // / #436) threads the user so a full-config override source
        // resolves targeting rules through the real evaluator; the flat-map
        // source keeps the byte-identical value-only path.
        if let Some(view) = self.overrides.as_deref() {
            let (handled, v) = evaluate_override_routed(Some(view), key, default, eval_user);
            if handled {
                return v.unwrap_or_else(|| default.clone());
            }
        }
        let r = evaluator::evaluate(self.config.as_ref(), key, default, eval_user);
        r.value
    }

    /// Resolves `key` against the snapshot and returns the typed
    /// [`EvaluationDetails<T>`] envelope. Mirrors the async
    /// [`crate::Client::get_value_details`] semantics in a synchronous,
    /// snapshot-bound form. Honours overrides FIRST via the 7-branch
    /// decision tree.
    pub fn get_value_details<T>(
        &self,
        key: &str,
        default: T,
        user: Option<&User>,
    ) -> EvaluationDetails<T>
    where
        T: serde::Serialize + DeserializeOwned + Clone,
    {
        self.get_value_details_with_mode(key, default, user, FlatOverrideMode::Legacy)
    }

    pub(crate) fn get_value_details_with_mode<T>(
        &self,
        key: &str,
        default: T,
        user: Option<&User>,
        mode: FlatOverrideMode,
    ) -> EvaluationDetails<T>
    where
        T: serde::Serialize + DeserializeOwned,
    {
        let user = user.or(self.default_user.as_ref());
        let default_value = serde_json::to_value(&default);
        let fallback = |code| {
            EvaluationDetails::err(
                key,
                default,
                self.fetch_time_unix_millis,
                user.cloned(),
                code,
            )
        };
        let Ok(default_value) = default_value else {
            return fallback("MALFORMED_DEFAULT");
        };

        let result = evaluate_override_routed_details(
            self.overrides.as_deref(),
            key,
            &default_value,
            user,
            mode,
        )
        .unwrap_or_else(|| evaluator::evaluate(self.config.as_ref(), key, &default_value, user));

        if !result.error.is_empty() {
            return fallback(result.error);
        }
        let Ok(value) = serde_json::from_value(result.value) else {
            return fallback("TYPE_MISMATCH");
        };
        let mut details =
            EvaluationDetails::ok(key, value, self.fetch_time_unix_millis, user.cloned());
        details.variation_id = (!result.variation_id.is_empty()).then_some(result.variation_id);
        details.matched_targeting_rule = result
            .matched_targeting_rule
            .then_some(crate::TargetingRule);
        details.matched_percentage_option = result
            .matched_percentage_option
            .then_some(crate::PercentageOption);
        details
    }

    /// Returns the aggregate `(key, value)` view over the snapshot's
    /// cached config + override map (overrides supersede cache on key
    /// collisions). Mirrors [`crate::Client::get_all_values`] in a
    /// synchronous, snapshot-bound form.
    #[must_use]
    pub fn get_all_values(&self) -> HashMap<String, PrimitiveValue> {
        let overrides_map = self
            .overrides
            .as_deref()
            .and_then(OverridesView::get_overrides_sync);
        collect_all_values(self.config.as_ref(), overrides_map.as_ref())
    }

    /// Returns the union of keys present in the cached config + the
    /// override map. Sorted ascending for deterministic test output.
    pub fn get_all_keys(&self) -> Vec<String> {
        let mut seen = std::collections::BTreeSet::<String>::new();
        if let Some(cfg) = &self.config {
            if let Some(obj) = cfg.get("f").and_then(Value::as_object) {
                for k in obj.keys() {
                    seen.insert(k.clone());
                }
            }
        }
        if let Some(view) = self.overrides.as_deref() {
            if let Some(map) = view.get_overrides_sync() {
                for k in map.keys() {
                    seen.insert(k.clone());
                }
            }
        }
        seen.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flag_overrides::OverrideBehaviour;
    use serde_json::json;
    use std::collections::HashMap;

    struct StubView {
        map: Option<HashMap<String, Value>>,
        behaviour: OverrideBehaviour,
    }
    impl OverridesView for StubView {
        fn get_overrides_sync(&self) -> Option<HashMap<String, Value>> {
            self.map.clone()
        }
        fn behaviour(&self) -> OverrideBehaviour {
            self.behaviour
        }
    }

    fn cfg() -> Value {
        json!({
            "f": {
                "feature.on": { "t": 0, "v": { "b": true } },
            }
        })
    }

    #[test]
    fn empty_snapshot_returns_default() {
        let s = Snapshot::new(None, None, None, 0);
        let got: bool = s.get_value("x", false, None);
        assert!(!got);
    }

    #[test]
    fn snapshot_resolves_cached_value() {
        let s = Snapshot::new(Some(cfg()), None, None, 0);
        let got: bool = s.get_value("feature.on", false, None);
        assert!(got);
    }

    #[test]
    fn snapshot_override_wins_over_cache() {
        let mut m = HashMap::new();
        m.insert("feature.on".to_string(), json!(false));
        let view = Box::new(StubView {
            map: Some(m),
            behaviour: OverrideBehaviour::LocalOnly,
        });
        let s = Snapshot::new(Some(cfg()), Some(view), None, 0);
        let got: bool = s.get_value("feature.on", true, None);
        assert!(!got, "override (false) must beat cache (true)");
    }

    #[test]
    fn get_all_keys_unions_cache_and_overrides() {
        let mut m = HashMap::new();
        m.insert("from-overrides".to_string(), json!(true));
        let view = Box::new(StubView {
            map: Some(m),
            behaviour: OverrideBehaviour::LocalOnly,
        });
        let s = Snapshot::new(Some(cfg()), Some(view), None, 0);
        let keys = s.get_all_keys();
        assert!(keys.contains(&"feature.on".to_string()));
        assert!(keys.contains(&"from-overrides".to_string()));
        assert_eq!(keys.len(), 2);
    }

    #[test]
    fn get_all_keys_handles_empty_inputs() {
        let s = Snapshot::new(None, None, None, 0);
        assert!(s.get_all_keys().is_empty());
    }
}
