// SPDX-License-Identifier: MIT

//! Typed result envelope returned by [`crate::Client::get_value_details`]
//! and [`crate::Snapshot::get_value_details`].
//!
//! Mirrors upstream `configcat::EvaluationDetails<T>` 1:1 field-for-field
//! (spec 084 / #266). A customer migrating from the `configcat` crate
//! keeps their field accessors unchanged.
//!
//! [`EvaluationDetails::variation_id`],
//! [`EvaluationDetails::matched_targeting_rule`], and
//! [`EvaluationDetails::matched_percentage_option`] are populated by the
//! evaluator: `variation_id` carries the resolved value's identity, and
//! the two matched-* flags surface a present [`TargetingRule`] /
//! [`PercentageOption`] when a rule or percentage option decided the
//! value (else `None`). These propagate through BOTH the cache-driven
//! eval and the full-config override path (spec 152 / #475, US2 — the
//! `get_value_details` override path mirrors the sdk-shared #395 fix).

use crate::user::User;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Primitive feature-flag / setting value.
///
/// Mirrors upstream `configcat::Value` 1:1 — same 4 variants, same
/// `#[serde(untagged)]` representation — so a `HashMap<String, Value>`
/// returned from [`crate::Client::get_all_values`] is byte-identical
/// in JSON shape to upstream's return.
#[derive(PartialEq, Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    /// A bool feature flag's value.
    Bool(bool),
    /// A whole-number setting's value.
    Int(i64),
    /// A decimal-number setting's value.
    Float(f64),
    /// A text setting's value.
    String(String),
}

impl Value {
    /// Returns `Some(b)` if `self` is [`Value::Bool`], else `None`.
    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        if let Value::Bool(v) = self {
            Some(*v)
        } else {
            None
        }
    }

    /// Returns `Some(n)` if `self` is [`Value::Int`], else `None`.
    #[must_use]
    pub fn as_int(&self) -> Option<i64> {
        if let Value::Int(v) = self {
            Some(*v)
        } else {
            None
        }
    }

    /// Returns `Some(n)` if `self` is [`Value::Float`], else `None`.
    #[must_use]
    pub fn as_float(&self) -> Option<f64> {
        if let Value::Float(v) = self {
            Some(*v)
        } else {
            None
        }
    }

    /// Returns `Some(s)` if `self` is [`Value::String`], else `None`.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        if let Value::String(v) = self {
            Some(v.as_str())
        } else {
            None
        }
    }
}

/// Placeholder for the targeting rule that matched during evaluation.
///
/// v1 evaluator does not surface targeting rules — every
/// [`EvaluationDetails::matched_targeting_rule`] is `None`. The type
/// exists today so customer code referencing it compiles unchanged
/// when targeting roll-out lands.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TargetingRule;

/// Placeholder for the percentage option that selected the evaluated
/// value.
///
/// v1 evaluator does not surface percentage options — every
/// [`EvaluationDetails::matched_percentage_option`] is `None`. See
/// [`TargetingRule`] for the placeholder rationale.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PercentageOption;

/// Typed result envelope returned by
/// [`crate::Client::get_value_details`] and
/// [`crate::Snapshot::get_value_details`].
///
/// Mirrors upstream `configcat::EvaluationDetails<T>` 1:1 with two
/// documented Confeature-side shape adjustments:
/// - `fetch_time_unix_millis: i64` (epoch milliseconds) rather than
///   `fetch_time: Option<chrono::DateTime<Utc>>` — keeps the SDK
///   `chrono`-free and matches the cross-language `EvaluationDetails`
///   shape adopted by sdk-java / sdk-android / sdk-kotlin-mp /
///   sdk-dotnet (spec 080 + siblings).
/// - `error: Option<String>` rather than `Option<ClientError>` — the
///   evaluator emits stable string error codes (`KEY_NOT_FOUND`,
///   `TYPE_MISMATCH`, …) that mirror the cross-language corpus; no
///   `ClientError` ladder is required.
#[derive(Debug, Clone)]
pub struct EvaluationDetails<T> {
    /// Key of the feature flag or setting that was evaluated.
    pub key: String,
    /// Resolved value, or the supplied default on any failure branch.
    pub value: T,
    /// Variation ID of the resolved value. `None` in v1 (placeholder).
    pub variation_id: Option<String>,
    /// Epoch-millis wall-clock time of the active config's last fetch.
    /// `0` when no fetch has succeeded and no cache entry was restored.
    pub fetch_time_unix_millis: i64,
    /// User context passed to the evaluation (cloned from the call
    /// site), or `None` when no user was supplied.
    pub user: Option<User>,
    /// `true` when the supplied default was returned (any failure
    /// branch).
    pub is_default_value: bool,
    /// Stable error code on every failure branch (`KEY_NOT_FOUND`,
    /// `TYPE_MISMATCH`, `NO_CONFIG`, …); `None` on the happy path.
    pub error: Option<String>,
    /// Targeting rule that matched. `None` in v1 (placeholder).
    pub matched_targeting_rule: Option<TargetingRule>,
    /// Percentage option selected. `None` in v1 (placeholder).
    pub matched_percentage_option: Option<PercentageOption>,
}

impl<T> EvaluationDetails<T> {
    /// Constructs the "happy path" envelope. Internal helper — public
    /// fields stay the migration surface.
    pub(crate) fn ok(key: &str, value: T, fetch_time_unix_millis: i64, user: Option<User>) -> Self {
        Self {
            key: key.to_owned(),
            value,
            variation_id: None,
            fetch_time_unix_millis,
            user,
            is_default_value: false,
            error: None,
            matched_targeting_rule: None,
            matched_percentage_option: None,
        }
    }

    /// Constructs the "default + error code" envelope. `error` is one
    /// of the evaluator's stable string codes.
    pub(crate) fn err(
        key: &str,
        default: T,
        fetch_time_unix_millis: i64,
        user: Option<User>,
        error: &str,
    ) -> Self {
        Self {
            key: key.to_owned(),
            value: default,
            variation_id: None,
            fetch_time_unix_millis,
            user,
            is_default_value: true,
            error: Some(error.to_owned()),
            matched_targeting_rule: None,
            matched_percentage_option: None,
        }
    }
}

/// Coerces an arbitrary [`serde_json::Value`] into a [`Value`] for the
/// `get_all_values` aggregate. Returns `None` for shapes outside the
/// four-primitive enum (arrays / objects / nulls).
pub(crate) fn coerce_json_value(v: &serde_json::Value) -> Option<Value> {
    match v {
        serde_json::Value::Bool(b) => Some(Value::Bool(*b)),
        serde_json::Value::String(s) => Some(Value::String(s.clone())),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(Value::Int(i))
            } else {
                n.as_f64().map(Value::Float)
            }
        }
        _ => None,
    }
}

/// Iterates the cached `f` object plus the override map (if any),
/// emitting `(key, Value)` tuples. Used by `get_all_values` on both
/// the `Client` and the `Snapshot`. Override entries supersede cache
/// entries on key collisions, matching the 7-branch override-eval
/// LocalOnly contract.
pub(crate) fn collect_all_values(
    config: Option<&serde_json::Value>,
    overrides: Option<&HashMap<String, serde_json::Value>>,
) -> HashMap<String, Value> {
    let mut out: HashMap<String, Value> = HashMap::new();
    if let Some(cfg) = config {
        if let Some(obj) = cfg.get("f").and_then(serde_json::Value::as_object) {
            for (k, setting) in obj {
                if let Some(setting_obj) = setting.as_object() {
                    if let Some(v_slot) =
                        setting_obj.get("v").and_then(serde_json::Value::as_object)
                    {
                        // Try each typed slot in turn — first match wins.
                        if let Some(b) = v_slot.get("b").and_then(serde_json::Value::as_bool) {
                            out.insert(k.clone(), Value::Bool(b));
                        } else if let Some(s) = v_slot.get("s").and_then(serde_json::Value::as_str)
                        {
                            out.insert(k.clone(), Value::String(s.to_owned()));
                        } else if let Some(i) = v_slot.get("i").and_then(serde_json::Value::as_i64)
                        {
                            out.insert(k.clone(), Value::Int(i));
                        } else if let Some(f) = v_slot.get("d").and_then(serde_json::Value::as_f64)
                        {
                            out.insert(k.clone(), Value::Float(f));
                        }
                    }
                }
            }
        }
    }
    if let Some(map) = overrides {
        for (k, v) in map {
            if let Some(coerced) = coerce_json_value(v) {
                out.insert(k.clone(), coerced);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn value_accessors_round_trip() {
        assert_eq!(Value::Bool(true).as_bool(), Some(true));
        assert_eq!(Value::Int(42).as_int(), Some(42));
        assert_eq!(Value::Float(0.25).as_float(), Some(0.25));
        assert_eq!(Value::String("hi".into()).as_str(), Some("hi"));
        // Wrong-variant accessors return None.
        assert_eq!(Value::Bool(true).as_int(), None);
        assert_eq!(Value::Int(1).as_str(), None);
    }

    #[test]
    fn ok_envelope_has_no_error() {
        let d = EvaluationDetails::<bool>::ok("k", true, 12345, None);
        assert_eq!(d.key, "k");
        assert!(d.value);
        assert_eq!(d.fetch_time_unix_millis, 12345);
        assert!(!d.is_default_value);
        assert!(d.error.is_none());
        assert!(d.variation_id.is_none());
        assert!(d.matched_targeting_rule.is_none());
        assert!(d.matched_percentage_option.is_none());
    }

    #[test]
    fn err_envelope_sets_default_flag_and_error() {
        let d = EvaluationDetails::<bool>::err("k", false, 0, None, "KEY_NOT_FOUND");
        assert!(d.is_default_value);
        assert_eq!(d.error.as_deref(), Some("KEY_NOT_FOUND"));
    }

    #[test]
    fn coerce_handles_primitives() {
        assert_eq!(coerce_json_value(&json!(true)), Some(Value::Bool(true)));
        assert_eq!(coerce_json_value(&json!(42)), Some(Value::Int(42)));
        assert_eq!(coerce_json_value(&json!(0.25)), Some(Value::Float(0.25)));
        assert_eq!(
            coerce_json_value(&json!("x")),
            Some(Value::String("x".into()))
        );
        // Arrays / objects / nulls are non-primitive — skipped.
        assert_eq!(coerce_json_value(&json!(null)), None);
        assert_eq!(coerce_json_value(&json!([1, 2])), None);
        assert_eq!(coerce_json_value(&json!({"k": "v"})), None);
    }

    #[test]
    fn collect_all_values_reads_typed_slots() {
        let cfg = json!({
            "f": {
                "feature.on":     { "t": 0, "v": { "b": true } },
                "feature.greet":  { "t": 1, "v": { "s": "hi" } },
                "feature.count":  { "t": 2, "v": { "i": 7 } },
                "feature.ratio":  { "t": 3, "v": { "d": 0.5 } },
            }
        });
        let out = collect_all_values(Some(&cfg), None);
        assert_eq!(out.get("feature.on"), Some(&Value::Bool(true)));
        assert_eq!(out.get("feature.greet"), Some(&Value::String("hi".into())));
        assert_eq!(out.get("feature.count"), Some(&Value::Int(7)));
        assert_eq!(out.get("feature.ratio"), Some(&Value::Float(0.5)));
    }

    #[test]
    fn collect_all_values_overrides_supersede_cache() {
        let cfg = json!({ "f": { "feature.x": { "t": 0, "v": { "b": true } } } });
        let mut overrides = HashMap::new();
        overrides.insert("feature.x".to_string(), json!(false));
        overrides.insert("feature.new".to_string(), json!("only-override"));
        let out = collect_all_values(Some(&cfg), Some(&overrides));
        assert_eq!(out.get("feature.x"), Some(&Value::Bool(false)));
        assert_eq!(
            out.get("feature.new"),
            Some(&Value::String("only-override".into()))
        );
    }

    #[test]
    fn collect_all_values_returns_empty_without_config_or_overrides() {
        let out = collect_all_values(None, None);
        assert!(out.is_empty());
    }
}
