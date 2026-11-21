// SPDX-License-Identifier: MIT

//! Synchronous override evaluation — 7-branch decision tree.
//!
//! Port of:
//! - `packages/sdk-shared/src/override-eval.ts:evaluateOverrideSync` (TS canonical)
//! - `apps/sdk-python/.../override_eval.py:evaluate_override_sync`
//! - `apps/sdk-go/internal/overrideeval/eval.go:EvaluateSync`
//!
//! The 7 branches are byte-identical across every Confeature SDK; the
//! parity corpus is the cross-language gate.
//!
//! Return type semantics:
//! - `(false, _)` → caller falls through to the cache (Branches 1-3).
//! - `(true, Some(value))` → resolved override result (possibly the
//!   supplied default — Branches 4-6 honour the LocalOnly contract:
//!   never fall through). Branch 7 returns the typed override value.

use crate::flag_overrides::OverrideBehaviour;
use crate::internal::evaluator::{self, EvalResult};
use crate::user::User;
use serde_json::Value;
use std::collections::HashMap;

/// Internal trait the evaluator accepts so this module stays free of
/// `crate::FlagOverrides` imports (which would create a public→internal
/// cycle). The client maps `FlagOverrides` → `OverridesView` at the
/// call site.
pub(crate) trait OverridesView {
    /// Returns the override map synchronously, or `None` to signal
    /// "no sync data" (Branch 3 falls through).
    fn get_overrides_sync(&self) -> Option<HashMap<String, Value>>;
    /// Returns the configured behaviour. Only `LocalOnly` is wired in
    /// v1 (Branch 2 short-circuits on the others).
    fn behaviour(&self) -> OverrideBehaviour;
    /// Returns the FULL parsed `config_v6` blob (`{p, f, s}`) when the
    /// underlying source is a rule-bearing full-config source, or `None`
    /// for a flat value-only source.
    ///
    /// Spec 135 / #436: the router ([`evaluate_override_routed`])
    /// dispatches on this — a `Some` resolves `key` through the real
    /// evaluator (salt + segments + rules intact, INV-4); a `None` keeps
    /// the byte-identical flat-map path ([`evaluate_sync`]). Default
    /// returns `None` so existing view adapters need no change.
    fn full_config(&self) -> Option<&Value> {
        None
    }
}

/// Walks the 7-branch decision tree.
///
/// Algorithm — byte-identical to TS / Python / Go / .NET ports:
///
/// 1. `overrides` is `None`                          → `(false, None)`  // fall through
/// 2. `behaviour != LocalOnly`                       → `(false, None)`  // deferred
/// 3. `data_source.get_overrides_sync() == None`     → `(false, None)`
/// 4. key absent                                     → `(true, Some(default))`  // LocalOnly contract
/// 5. raw value is `Null`                            → `(true, Some(default))`  // empty override
/// 6. `type(candidate) != type(default)`             → `(true, Some(default))`
/// 7. happy path                                     → `(true, Some(candidate))`
///
/// `default` is borrowed by reference and cloned ONLY on the
/// fall-through branches — the happy path returns the override value
/// without touching the default.
pub(crate) fn evaluate_sync(
    overrides: Option<&dyn OverridesView>,
    key: &str,
    default: &Value,
) -> (bool, Option<Value>) {
    match evaluate_flat_override(overrides, key, default, FlatOverrideMode::Legacy) {
        FlatOverrideOutcome::FallThrough => (false, None),
        FlatOverrideOutcome::Value(value) => (true, Some(value)),
        _ => (true, Some(default.clone())),
    }
}

#[derive(Clone, Copy)]
pub(crate) enum FlatOverrideMode {
    Legacy,
    #[cfg(feature = "openfeature")]
    Strict,
}

enum FlatOverrideOutcome {
    FallThrough,
    Missing,
    Null,
    WrongKind,
    Value(Value),
}

/// Keep the outcome of the single flat lookup so strict callers can
/// distinguish a served value from a fallback, even when the two are equal.
fn evaluate_flat_override(
    overrides: Option<&dyn OverridesView>,
    key: &str,
    default: &Value,
    mode: FlatOverrideMode,
) -> FlatOverrideOutcome {
    let Some(o) = overrides else {
        return FlatOverrideOutcome::FallThrough;
    };
    if o.behaviour() != OverrideBehaviour::LocalOnly {
        return FlatOverrideOutcome::FallThrough;
    }
    let Some(mut map) = o.get_overrides_sync() else {
        return FlatOverrideOutcome::FallThrough;
    };
    let Some(raw) = map.remove(key) else {
        return FlatOverrideOutcome::Missing;
    };
    if raw.is_null() {
        return FlatOverrideOutcome::Null;
    }
    if mode.accepts(&raw, default) {
        FlatOverrideOutcome::Value(raw)
    } else {
        FlatOverrideOutcome::WrongKind
    }
}

impl FlatOverrideMode {
    fn accepts(self, raw: &Value, default: &Value) -> bool {
        match self {
            // Legacy overrides classify every number together and bypass the
            // type check for a null default, matching the cross-SDK contract.
            Self::Legacy => default.is_null() || same_json_kind(raw, default),
            #[cfg(feature = "openfeature")]
            Self::Strict if default.is_i64() => raw.is_i64(),
            #[cfg(feature = "openfeature")]
            Self::Strict if default.is_f64() => raw.is_f64(),
            #[cfg(feature = "openfeature")]
            Self::Strict => same_json_kind(raw, default),
        }
    }
}

fn local_full_config(overrides: Option<&dyn OverridesView>) -> Option<&Value> {
    overrides
        .filter(|view| view.behaviour() == OverrideBehaviour::LocalOnly)
        .and_then(OverridesView::full_config)
}

/// Rule-bearing LocalOnly overrides resolve with the native evaluator.
/// The other sources use the flat-map path.
pub(crate) fn evaluate_override_routed(
    overrides: Option<&dyn OverridesView>,
    key: &str,
    default: &Value,
    user: Option<&User>,
) -> (bool, Option<Value>) {
    if let Some(config) = local_full_config(overrides) {
        let result = evaluator::evaluate(Some(config), key, default, user);
        return (true, Some(result.value));
    }
    evaluate_sync(overrides, key, default)
}

/// Preserve the evaluator's details for rule-bearing sources and classify
/// flat sources using the same lookup as the value-only path.
pub(crate) fn evaluate_override_routed_details(
    overrides: Option<&dyn OverridesView>,
    key: &str,
    default: &Value,
    user: Option<&User>,
    mode: FlatOverrideMode,
) -> Option<EvalResult> {
    if let Some(config) = local_full_config(overrides) {
        // Retain the salt and segments for the evaluator, as well as the
        // variation ID and match markers it returns.
        return Some(evaluator::evaluate(Some(config), key, default, user));
    }
    let (value, error) = match (evaluate_flat_override(overrides, key, default, mode), mode) {
        (FlatOverrideOutcome::FallThrough, _) => return None,
        (FlatOverrideOutcome::Value(value), _) => (value, ""),
        (_, FlatOverrideMode::Legacy) => (default.clone(), ""),
        #[cfg(feature = "openfeature")]
        (FlatOverrideOutcome::Missing, FlatOverrideMode::Strict) => {
            (default.clone(), "KEY_NOT_FOUND")
        }
        #[cfg(feature = "openfeature")]
        (FlatOverrideOutcome::Null, FlatOverrideMode::Strict) => (default.clone(), "NULL_OVERRIDE"),
        #[cfg(feature = "openfeature")]
        (FlatOverrideOutcome::WrongKind, FlatOverrideMode::Strict) => {
            (default.clone(), "TYPE_MISMATCH")
        }
    };
    Some(EvalResult {
        value,
        error,
        variation_id: String::new(),
        matched_targeting_rule: false,
        matched_percentage_option: false,
    })
}

/// Reports whether two [`Value`]s share a kind for the override-eval
/// type-check.
///
/// Numeric values are treated as one kind regardless of integer vs
/// float JSON encoding — this matches the TS canonical implementation
/// where `typeof 42 === typeof 42.5 === "number"`.
fn same_json_kind(a: &Value, b: &Value) -> bool {
    matches!(
        (a, b),
        (Value::Bool(_), Value::Bool(_))
            | (Value::String(_), Value::String(_))
            | (Value::Number(_), Value::Number(_))
            | (Value::Array(_), Value::Array(_))
            | (Value::Object(_), Value::Object(_))
            | (Value::Null, Value::Null)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Simple test view backed by an `Option<HashMap>` so we can model
    /// the "no sync data" branch without contorting the test helper.
    struct TestView {
        map: Option<HashMap<String, Value>>,
        behaviour: OverrideBehaviour,
    }
    impl OverridesView for TestView {
        fn get_overrides_sync(&self) -> Option<HashMap<String, Value>> {
            self.map.clone()
        }
        fn behaviour(&self) -> OverrideBehaviour {
            self.behaviour
        }
    }

    fn view(map: HashMap<String, Value>, b: OverrideBehaviour) -> TestView {
        TestView {
            map: Some(map),
            behaviour: b,
        }
    }

    #[test]
    fn branch_1_none_falls_through() {
        let (ok, v) = evaluate_sync(None, "k", &json!(false));
        assert!(!ok);
        assert!(v.is_none());
    }

    #[test]
    fn branch_2_non_local_only_falls_through() {
        let vw = view(HashMap::new(), OverrideBehaviour::LocalOverRemote);
        let (ok, v) = evaluate_sync(Some(&vw), "k", &json!(false));
        assert!(!ok);
        assert!(v.is_none());
    }

    #[test]
    fn branch_3_no_sync_data_falls_through() {
        let vw = TestView {
            map: None,
            behaviour: OverrideBehaviour::LocalOnly,
        };
        let (ok, v) = evaluate_sync(Some(&vw), "k", &json!(false));
        assert!(!ok);
        assert!(v.is_none());
    }

    #[test]
    fn branch_4_absent_key_returns_default() {
        let vw = view(HashMap::new(), OverrideBehaviour::LocalOnly);
        let (ok, v) = evaluate_sync(Some(&vw), "missing", &json!(false));
        assert!(ok);
        assert_eq!(v, Some(json!(false)));
    }

    #[test]
    fn branch_5_null_override_returns_default() {
        let mut m = HashMap::new();
        m.insert("k".to_string(), Value::Null);
        let vw = view(m, OverrideBehaviour::LocalOnly);
        let (ok, v) = evaluate_sync(Some(&vw), "k", &json!(true));
        assert!(ok);
        assert_eq!(v, Some(json!(true)));
    }

    #[test]
    fn branch_6_type_mismatch_returns_default() {
        let mut m = HashMap::new();
        m.insert("k".to_string(), json!("string-value"));
        let vw = view(m, OverrideBehaviour::LocalOnly);
        // default is bool; override is string → mismatch → default.
        let (ok, v) = evaluate_sync(Some(&vw), "k", &json!(true));
        assert!(ok);
        assert_eq!(v, Some(json!(true)));
    }

    #[test]
    fn branch_6_null_default_bypasses_type_check() {
        let mut m = HashMap::new();
        m.insert("k".to_string(), json!("string-value"));
        let vw = view(m, OverrideBehaviour::LocalOnly);
        // Null default ⇒ check skipped ⇒ Branch 7 happy path.
        let (ok, v) = evaluate_sync(Some(&vw), "k", &Value::Null);
        assert!(ok);
        assert_eq!(v, Some(json!("string-value")));
    }

    #[test]
    fn branch_7_happy_path_returns_override() {
        let mut m = HashMap::new();
        m.insert("k".to_string(), json!(true));
        let vw = view(m, OverrideBehaviour::LocalOnly);
        let (ok, v) = evaluate_sync(Some(&vw), "k", &json!(false));
        assert!(ok);
        assert_eq!(v, Some(json!(true)));
    }

    // ── Full-config router (spec 135 / #436) ────────────────────────────

    /// View carrying a full `{p, f, s}` config so the router routes through
    /// the real evaluator.
    struct FullConfigView {
        config: Value,
        behaviour: OverrideBehaviour,
    }
    impl OverridesView for FullConfigView {
        fn get_overrides_sync(&self) -> Option<HashMap<String, Value>> {
            // A full-config source exposes flat base values for key
            // enumeration; the router never reads this on the rule path.
            Some(HashMap::new())
        }
        fn behaviour(&self) -> OverrideBehaviour {
            self.behaviour
        }
        fn full_config(&self) -> Option<&Value> {
            Some(&self.config)
        }
    }

    fn rules_config() -> Value {
        // One CONTAINS rule on Email serving "Dog"; base value "Cat".
        json!({
            "p": { "s": "YqM/XOUIrdUYmTgGMfYyQI6P2q+WrwipFKnw5vaKQss=" },
            "f": {
                "flag": {
                    "i": "ce564c3a",
                    "t": 1,
                    "v": { "s": "Cat" },
                    "r": [
                        {
                            "c": [{ "u": { "a": "Email", "c": 2, "l": ["@configcat.com"] } }],
                            "s": { "i": "d0cd8f06", "v": { "s": "Dog" } }
                        }
                    ]
                }
            },
            "s": []
        })
    }

    #[test]
    fn router_full_config_resolves_base_value_without_user() {
        let vw = FullConfigView {
            config: rules_config(),
            behaviour: OverrideBehaviour::LocalOnly,
        };
        // No user → rule needing Email can't match → base value "Cat".
        let (ok, v) = evaluate_override_routed(Some(&vw), "flag", &json!("default"), None);
        assert!(ok);
        assert_eq!(v, Some(json!("Cat")));
    }

    #[test]
    fn router_full_config_resolves_rule_with_user() {
        let vw = FullConfigView {
            config: rules_config(),
            behaviour: OverrideBehaviour::LocalOnly,
        };
        let user = User::new("12345").with_email("joe@configcat.com");
        let (ok, v) = evaluate_override_routed(Some(&vw), "flag", &json!("default"), Some(&user));
        assert!(ok);
        assert_eq!(v, Some(json!("Dog")), "Email CONTAINS @configcat.com → Dog");
    }

    #[test]
    fn router_full_config_non_local_only_falls_through() {
        let vw = FullConfigView {
            config: rules_config(),
            behaviour: OverrideBehaviour::LocalOverRemote,
        };
        let (ok, v) = evaluate_override_routed(Some(&vw), "flag", &json!("default"), None);
        assert!(!ok);
        assert!(v.is_none());
    }

    #[test]
    fn router_flat_map_source_keeps_flat_path() {
        // A flat view (no full config) routes through the byte-identical
        // flat-map path — Branch 7 happy path.
        let mut m = HashMap::new();
        m.insert("k".to_string(), json!(true));
        let vw = view(m, OverrideBehaviour::LocalOnly);
        let (ok, v) = evaluate_override_routed(Some(&vw), "k", &json!(false), None);
        assert!(ok);
        assert_eq!(v, Some(json!(true)));
    }
}
