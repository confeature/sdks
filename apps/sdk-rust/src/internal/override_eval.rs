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
    // Branch 1.
    let Some(o) = overrides else {
        return (false, None);
    };

    // Branch 2.
    if o.behaviour() != OverrideBehaviour::LocalOnly {
        return (false, None);
    }

    // Branch 3.
    let Some(map) = o.get_overrides_sync() else {
        return (false, None);
    };

    // From here we are committed to the LocalOnly contract — never
    // fall through.

    // Branch 4.
    let Some(raw) = map.get(key) else {
        return (true, Some(default.clone()));
    };

    // Branch 5.
    if raw.is_null() {
        return (true, Some(default.clone()));
    }

    // Branch 6 — type-mismatch check. A `Null` default bypasses the
    // check (matches the TS `defaultValue !== null` semantics).
    if !default.is_null() && !same_json_kind(raw, default) {
        return (true, Some(default.clone()));
    }

    // Branch 7 — happy path.
    (true, Some(raw.clone()))
}

/// Full-config override resolution — Rust port of the canonical TS
/// `evaluateFullConfigOverrideSync` (spec 135 / #436, epic #382, US3),
/// mirroring sdk-python's `evaluate_full_config_override_sync` and
/// sdk-dart's `evaluateFullConfigOverrideSync`.
///
/// When the override source is a full-config source (its
/// [`OverridesView::full_config`] returns `Some`), resolves `key` through
/// the real Rust evaluator so targeting rules / segments / prerequisites /
/// percentage options apply offline — the rule-bearing sibling of
/// [`evaluate_sync`]'s flat lookup.
///
/// Returns:
/// - `(false, None)` → overrides absent, behaviour non-LocalOnly, or the
///   source is NOT a full-config source (caller falls through to the
///   flat-map helper / normal eval).
/// - `(true, Some(value))` → the rule-resolved value. LocalOnly contract:
///   never fall through to the cache — the evaluator already returns the
///   supplied `default` for any non-clean resolution, preserving the
///   contract.
///
/// INV-4: the evaluator receives the FULL config blob (`{p, f, s}`) — salt
/// (`p.s`) + segments (`s`), never just `f` (the spec-129 dropped-salt
/// regression class). The evaluator never panics — any failure resolves to
/// the caller's `default`.
fn evaluate_full_config_sync(
    overrides: Option<&dyn OverridesView>,
    key: &str,
    default: &Value,
    user: Option<&User>,
) -> (bool, Option<Value>) {
    let Some(o) = overrides else {
        return (false, None);
    };
    if o.behaviour() != OverrideBehaviour::LocalOnly {
        return (false, None);
    }
    let Some(config) = o.full_config() else {
        return (false, None);
    };
    // Pass the FULL config blob (salt + segments + f), never just `f`
    // (INV-4).
    let r = evaluator::evaluate(Some(config), key, default, user);
    (true, Some(r.value))
}

/// Shared override router — Rust port of the canonical TS
/// `evaluateOverride` (spec 135 / #436), mirroring sdk-python's
/// `evaluate_override` and sdk-dart's `evaluateOverride`.
///
/// Dispatches between the flat-map path and the full-config path so the
/// `get_value` call sites change minimally: a full-config source (one
/// whose [`OverridesView::full_config`] returns `Some`) routes through the
/// real evaluator with `user` threaded; every other source (map / custom)
/// keeps the existing byte-identical flat-map resolution.
///
/// Returns the same `(bool, Option<Value>)` contract as [`evaluate_sync`]:
/// - `(false, _)` → no override applies; caller falls through to the
///   normal cache-driven eval.
/// - `(true, Some(value))` → resolved override result.
///
/// Dispatch is on the source TYPE (full-config vs flat), NOT on the
/// resolved value — a full-config source whose evaluator returns the
/// default still stays on the rule path, never the flat path (which would
/// mis-read rule-bearing settings as value-only).
pub(crate) fn evaluate_override_routed(
    overrides: Option<&dyn OverridesView>,
    key: &str,
    default: &Value,
    user: Option<&User>,
) -> (bool, Option<Value>) {
    // Full-config source → ALWAYS resolve through the evaluator.
    if let Some(o) = overrides {
        if o.behaviour() == OverrideBehaviour::LocalOnly && o.full_config().is_some() {
            return evaluate_full_config_sync(overrides, key, default, user);
        }
    }
    // Every other source (map / custom) keeps the byte-identical flat-map
    // path.
    evaluate_sync(overrides, key, default)
}

/// Details-aware override router — the `get_value_details` sibling of
/// [`evaluate_override_routed`] (spec 152 / #475, US2). Mirrors the
/// canonical TS `evaluateOverrideDetails` (the sdk-shared #395 fix that
/// stopped the override path dropping `variationId` /
/// `matchedTargetingRule` / `matchedPercentageOption` for
/// `getValueDetails`).
///
/// For a FULL-CONFIG LocalOnly source, resolves `key` through the real
/// evaluator and returns the WHOLE [`EvalResult`] — so the caller can
/// populate `variation_id` + matched rule / option on the
/// `EvaluationDetails` envelope, rather than only the value (the gap the
/// value-only [`evaluate_override_routed`] left behind).
///
/// Returns:
/// - `(false, None)` → overrides absent, behaviour non-LocalOnly, or the
///   source is NOT a full-config source (caller falls through to the
///   flat-map / cache path; for a flat source it must call
///   [`evaluate_override_routed`] for the value).
/// - `(true, Some(result))` → the rule-resolved [`EvalResult`] (value +
///   variation_id + matched rule / option). LocalOnly contract: never
///   fall through.
pub(crate) fn evaluate_override_routed_details(
    overrides: Option<&dyn OverridesView>,
    key: &str,
    default: &Value,
    user: Option<&User>,
) -> (bool, Option<EvalResult>) {
    let Some(o) = overrides else {
        return (false, None);
    };
    if o.behaviour() != OverrideBehaviour::LocalOnly {
        return (false, None);
    }
    let Some(config) = o.full_config() else {
        // Flat / value-only source — no rule details to surface; the
        // caller routes through the value-only path.
        return (false, None);
    };
    // Pass the FULL config blob (salt + segments + f), never just `f`
    // (INV-4). Propagate the whole EvalResult so the details envelope
    // keeps variation_id + matched rule / option (the #395 fix).
    let r = evaluator::evaluate(Some(config), key, default, user);
    (true, Some(r))
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
