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
    evaluate_override_routed, evaluate_override_routed_details, OverridesView,
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
        let user_clone = user.cloned().or_else(|| self.default_user.clone());
        let default_value = match serde_json::to_value(&default) {
            Ok(v) => v,
            Err(_) => {
                return EvaluationDetails::err(
                    key,
                    default,
                    self.fetch_time_unix_millis,
                    user_clone,
                    "MALFORMED_DEFAULT",
                );
            }
        };

        // Override path FIRST. The router (spec 135 / #436) threads the
        // user so a full-config override source resolves targeting rules
        // through the real evaluator; the flat-map source keeps the
        // byte-identical value-only path.
        let details_user = user.or(self.default_user.as_ref());
        if let Some(view) = self.overrides.as_deref() {
            // Full-config source → resolve through the DETAILS-aware router
            // (spec 152 / #475, US2; mirrors the sdk-shared #395 fix) so
            // `variation_id` + matched rule / option propagate through the
            // override path instead of being dropped to the value alone.
            let (details_handled, result) =
                evaluate_override_routed_details(Some(view), key, &default_value, details_user);
            if details_handled {
                if let Some(r) = result {
                    if r.error.is_empty() {
                        let matched_rule = r.matched_targeting_rule;
                        let matched_option = r.matched_percentage_option;
                        let variation_id = r.variation_id;
                        return match serde_json::from_value::<T>(r.value) {
                            Ok(value) => {
                                let mut details = EvaluationDetails::ok(
                                    key,
                                    value,
                                    self.fetch_time_unix_millis,
                                    user_clone,
                                );
                                if !variation_id.is_empty() {
                                    details.variation_id = Some(variation_id);
                                }
                                if matched_rule {
                                    details.matched_targeting_rule = Some(crate::TargetingRule);
                                }
                                if matched_option {
                                    details.matched_percentage_option =
                                        Some(crate::PercentageOption);
                                }
                                details
                            }
                            Err(_) => EvaluationDetails::err(
                                key,
                                default,
                                self.fetch_time_unix_millis,
                                user_clone,
                                "TYPE_MISMATCH",
                            ),
                        };
                    }
                    return EvaluationDetails::err(
                        key,
                        default,
                        self.fetch_time_unix_millis,
                        user_clone,
                        r.error,
                    );
                }
            }

            // Flat / value-only source → keep the byte-identical value-only
            // routed path (no rule details to surface).
            let (handled, v) =
                evaluate_override_routed(Some(view), key, &default_value, details_user);
            if handled {
                let resolved_json = v.unwrap_or_else(|| default_value.clone());
                // Branch 4-6 return the default verbatim; Branch 7
                // returns the override candidate. We distinguish by
                // direct map lookup: present + non-null + same kind →
                // happy path; otherwise default-with-no-error (the
                // LocalOnly contract is "fall back to default silently"
                // on a missing / typed-mismatched override entry, so
                // no error code surfaces).
                match serde_json::from_value::<T>(resolved_json) {
                    Ok(value) => {
                        return EvaluationDetails::ok(
                            key,
                            value,
                            self.fetch_time_unix_millis,
                            user_clone,
                        );
                    }
                    Err(_) => {
                        return EvaluationDetails::err(
                            key,
                            default,
                            self.fetch_time_unix_millis,
                            user_clone,
                            "TYPE_MISMATCH",
                        );
                    }
                }
            }
        }

        // Fall through to the evaluator.
        let eval_user = user.or(self.default_user.as_ref());
        let r = evaluator::evaluate(self.config.as_ref(), key, &default_value, eval_user);
        if r.error.is_empty() {
            let matched_rule = r.matched_targeting_rule;
            let matched_option = r.matched_percentage_option;
            match serde_json::from_value::<T>(r.value) {
                Ok(value) => {
                    let mut details =
                        EvaluationDetails::ok(key, value, self.fetch_time_unix_millis, user_clone);
                    if !r.variation_id.is_empty() {
                        details.variation_id = Some(r.variation_id);
                    }
                    if matched_rule {
                        details.matched_targeting_rule = Some(crate::TargetingRule);
                    }
                    if matched_option {
                        details.matched_percentage_option = Some(crate::PercentageOption);
                    }
                    details
                }
                Err(_) => EvaluationDetails::err(
                    key,
                    default,
                    self.fetch_time_unix_millis,
                    user_clone,
                    "TYPE_MISMATCH",
                ),
            }
        } else {
            EvaluationDetails::err(
                key,
                default,
                self.fetch_time_unix_millis,
                user_clone,
                r.error,
            )
        }
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
