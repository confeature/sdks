// SPDX-License-Identifier: MIT

//! Targeting-rule parity gate (spec 135 / #436, epic #382, US3) — the
//! `CORPUS_RULES` corpus injected through the full-config offline override.
//!
//! Unlike the flat `parity-corpus` / `parity-corpus-typed` corpora (which
//! feed a value-only `overridesMap` via [`confeature::MapOverrideDataSource`]),
//! the rule corpus carries the whole `{p, f, s}` config and is injected via
//! [`confeature::create_flag_overrides_from_config`] +
//! [`confeature::OverrideBehaviour::LocalOnly`]. The SDK then resolves
//! targeting rules / segments / % options offline through the real Rust
//! evaluator, exactly as it would against a CDN-served config — no network
//! round-trip.
//!
//! Runner contract (mirrors `apps/sdk-node/tests/parity/parity-rules.test.ts`
//! and sdk-python's `tests/parity/test_parity_rules.py`): every tuple branches
//! on the config's `injectionMode`:
//!   - `"full-config"` → capability-probe `create_flag_overrides_from_config`.
//!     If this SDK exposes it, build the override and assert the PUBLIC
//!     `client.get_value` returns `tuple.expected`. If it does NOT, SKIP with
//!     a reason — NEVER fall back to the flat-map path (SC-004: no
//!     `"full-config"` tuple is ever resolved on the map path, and a skip is
//!     reported with its reason).
//!
//! sdk-rust HAS adopted the full-config path (the factory is a compiled-in
//! crate-root export), so every loaded rule tuple runs and passes; there are no
//! skips for this family.
//!
//! Constitution invariant (Principle II NON-NEGOTIABLE): every tuple MUST
//! pass byte-for-byte. If a tuple drifts, STOP and investigate the
//! override-eval / evaluator code — never mutate the corpus to make the test
//! green.

mod common;

use confeature::user::UserValue;
use confeature::{create_flag_overrides_from_config, Client, OverrideBehaviour, PollingMode, User};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

/// Map a corpus `custom` attribute value (a raw `serde_json::Value`) onto a
/// typed [`UserValue`], honouring the typed-attribute corpus encoding
/// (spec 151 / #468, US2):
///
/// - JSON string  → [`UserValue::String`] (the verbatim string path —
///   byte-identical to the pre-typed `with_custom` behaviour).
/// - JSON bool    → bool (collapses onto the string path, exactly as the
///   upstream `configcat` crate's `UserValue` has no `Bool` variant —
///   `true`/`false` stringify the ConfigCat way).
/// - JSON integer → [`UserValue::Int`] / [`UserValue::UInt`].
/// - JSON float   → [`UserValue::Float`].
/// - JSON array   → [`UserValue::StringVec`] (every element MUST be a
///   string; the conversion corpus only carries string arrays). An empty
///   array is a legitimate value (`stringArrayToStringConversionEmpty`).
/// - `{"$date": <epoch-seconds>}` → [`UserValue::DateTime`] (Unix epoch
///   seconds, fractional part preserved).
/// - `{"$num": "NaN" | "Infinity" | "-Infinity"}` → [`UserValue::Float`]
///   carrying the matching non-finite f64 (spec / #479). This tag exists
///   because `JSON.stringify(NaN | Infinity | -Infinity)` collapses to a
///   lossy `null`, so the corpus carries the special floats as a tagged
///   object instead. The evaluator stringifies these to `"NaN"` /
///   `"Infinity"` / `"-Infinity"` (Principle II, matching the canonical TS
///   number→string conversion), driving the {number,date}ToStringConversion
///   {NaN,PositiveInf,NegativeInf} tuples.
///
/// Panics with a descriptive message on an unexpected encoding so a future
/// corpus shape can never be silently mis-routed onto the wrong typed path.
fn corpus_value_to_user_value(key: &str, v: &Value) -> UserValue {
    match v {
        Value::String(s) => UserValue::String(s.clone()),
        Value::Bool(b) => UserValue::from(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                UserValue::Int(i)
            } else if let Some(u) = n.as_u64() {
                UserValue::UInt(u)
            } else {
                // A finite float (the conversion corpus carries `0.12345`,
                // `-1.23456789e+96`, etc.). `as_f64` is total for any JSON
                // number that is not an i64/u64.
                UserValue::Float(n.as_f64().unwrap_or_else(|| {
                    panic!("custom attr {key:?}: non-finite JSON number {n} unsupported")
                }))
            }
        }
        Value::Array(items) => {
            let strings: Vec<String> = items
                .iter()
                .map(|item| match item {
                    Value::String(s) => s.clone(),
                    other => panic!(
                        "custom attr {key:?}: array element is not a string ({other}); \
                         the conversion corpus only carries string arrays"
                    ),
                })
                .collect();
            UserValue::StringVec(strings)
        }
        Value::Object(map) => {
            // The non-finite-number encoding: `{"$num": "NaN" | "Infinity" |
            // "-Infinity"}` (spec / #479). `JSON.stringify` collapses these
            // floats to `null`, so the corpus tags them as an object; decode
            // back to the matching non-finite f64 and let the evaluator
            // stringify it the ConfigCat way ("NaN" / "Infinity" / "-Infinity").
            if let Some(num) = map.get("$num") {
                let s = num.as_str().unwrap_or_else(|| {
                    panic!(
                        "custom attr {key:?}: `$num` tag value is not a string ({v}); \
                         expected \"NaN\" | \"Infinity\" | \"-Infinity\""
                    )
                });
                let f = match s {
                    "NaN" => f64::NAN,
                    "Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    other => panic!(
                        "custom attr {key:?}: unknown `$num` tag {other:?}; \
                         expected \"NaN\" | \"Infinity\" | \"-Infinity\""
                    ),
                };
                return UserValue::Float(f);
            }
            // The Date encoding: `{"$date": <epoch-seconds>}`.
            let date = map.get("$date").and_then(Value::as_f64).unwrap_or_else(|| {
                panic!(
                    "custom attr {key:?}: object value is not the `{{\"$date\": n}}` \
                     date encoding or `{{\"$num\": s}}` non-finite encoding ({v})"
                )
            });
            UserValue::DateTime(date)
        }
        Value::Null => panic!("custom attr {key:?}: null custom value is not a valid encoding"),
    }
}

const PARITY_SDK_KEY: &str =
    "confeature-sdk-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

#[derive(Debug, Deserialize)]
struct ParityTuple {
    description: String,
    #[serde(rename = "configId")]
    config_id: String,
    key: String,
    #[serde(rename = "defaultValue")]
    default_value: Value,
    user: Option<CorpusUser>,
    expected: Value,
    /// Optional expected `variationId` (spec 152 / #475, US2). When
    /// present, the runner ALSO asserts the PUBLIC
    /// `get_value_details().variation_id` equals this string, in addition
    /// to the value assertion. Tuples without it stay value-only.
    #[serde(rename = "expectedVariationId", default)]
    expected_variation_id: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct CorpusUser {
    #[serde(default)]
    identifier: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    country: Option<String>,
    /// Custom attributes keyed by name. Each value is a raw
    /// `serde_json::Value` so the runner can honour the typed-attribute
    /// corpus encoding (string / number / bool / array / `{"$date": n}` /
    /// `{"$num": "NaN"|"Infinity"|"-Infinity"}`) and route it onto the
    /// matching public `User::with_custom_value` typed path — no
    /// `expected a string` crash on a number/array/date/non-finite float.
    #[serde(default)]
    custom: Option<HashMap<String, Value>>,
}

impl CorpusUser {
    fn to_user(&self) -> User {
        let mut u = User::new(self.identifier.clone().unwrap_or_default());
        if let Some(email) = &self.email {
            u = u.with_email(email);
        }
        if let Some(country) = &self.country {
            u = u.with_country(country);
        }
        if let Some(custom) = &self.custom {
            for (k, v) in custom {
                // A JSON-string custom attribute MUST take the verbatim
                // string path (byte-identical to the pre-typed
                // `with_custom`), so no string-attribute tuple regresses;
                // every other JSON type maps onto its typed `UserValue`.
                u = u.with_custom_value(k, corpus_value_to_user_value(k, v));
            }
        }
        u
    }
}

#[derive(Debug, Deserialize)]
struct ParityConfigRecord {
    id: String,
    #[serde(rename = "injectionMode")]
    injection_mode: String,
    /// The full `{p, f, s}` config blob (present for `injectionMode:
    /// "full-config"`).
    config: Value,
}

/// Setting-type discriminators (mirrors the evaluator's `SETTING_TYPE_*`).
const SETTING_TYPE_INT: u64 = 2;
const SETTING_TYPE_DOUBLE: u64 = 3;

/// Read a setting's `t` discriminator out of a full-config blob.
fn setting_type(config: &Value, key: &str) -> Option<u64> {
    config.get("f")?.get(key)?.get("t").and_then(Value::as_u64)
}

/// Pick a TYPED default that matches the setting's declared type (spec 152 /
/// #475, US2). The strict Rust evaluator distinguishes int (t=2) from double
/// (t=3) — a DELIBERATE Principle-II contract — so the corpus default (often
/// the i64-encoded `-1`) must be widened to the kind the setting expects:
///
/// - DOUBLE (t=3, the `decimal` tuples) → an f64 (`-1` becomes `-1.0`), so the
///   evaluator's `is_f64()` guard passes and the double value resolves.
/// - INT (t=2, the `whole` tuples) → an i64 (left as-is).
/// - bool / string → passed through verbatim.
///
/// This is the same "match the typed default to the setting type" approach
/// python (`_default_value_for` widens to float for t=3), go
/// (`GetFloatValueDetails` for t=3), and swift use in their runners — the
/// decimal tuples resolve WITHOUT relaxing the evaluator's type guard.
fn typed_default(config: &Value, key: &str, default: &Value) -> Value {
    match (default, setting_type(config, key)) {
        // Widen a whole-number default to f64 for a DOUBLE setting.
        (Value::Number(n), Some(SETTING_TYPE_DOUBLE)) => n
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or_else(|| default.clone()),
        // Narrow a (possibly float-encoded) default to i64 for an INT setting.
        (Value::Number(n), Some(SETTING_TYPE_INT)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .map(|i| Value::Number(i.into()))
            .unwrap_or_else(|| default.clone()),
        _ => default.clone(),
    }
}

fn load_corpus() -> Vec<ParityTuple> {
    let path = common::parity_corpus_rules_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read rules parity corpus {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse parity-corpus-rules.json: {e}"))
}

fn load_configs() -> HashMap<String, ParityConfigRecord> {
    let path = common::parity_configs_rules_path();
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read rules parity configs {}: {e}", path.display()));
    let records: Vec<ParityConfigRecord> = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("parse parity-configs-rules.json: {e}"));
    records.into_iter().map(|r| (r.id.clone(), r)).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn parity_corpus_rules_byte_identical() {
    let tuples = load_corpus();
    let configs = load_configs();

    // Growth-tolerant non-empty floor. `CORPUS_RULES` is append-only (the 8
    // foundational #383 tuples are never removed) and grows with every
    // comparator spec, so we assert only that the fixture actually loaded — not
    // a hardcoded total that re-trips on every growth. Per-tuple correctness is
    // covered by the per-tuple assertions below, and JSON↔TS sync is owned by
    // the central `check:exports` gate, so this guard is purely a non-empty
    // smoke and never needs a per-spec bump.
    assert!(
        tuples.len() >= 8,
        "rule corpus is non-empty (append-only floor: at least the 8 \
         foundational rule tuples), got {} — looks empty/truncated, \
         regenerate via `pnpm run export:corpus` in \
         packages/test-fixtures-sdk-parity/",
        tuples.len()
    );

    let mut failures: Vec<String> = Vec::new();
    let mut skips: Vec<String> = Vec::new();
    let mut ran = 0usize;

    for tuple in &tuples {
        let cfg = configs.get(&tuple.config_id).unwrap_or_else(|| {
            panic!(
                "rule corpus references unknown configId={:?}; \
                 regenerate fixtures via `pnpm run export:corpus`",
                tuple.config_id
            )
        });

        // Branch on injectionMode. SC-004: a "full-config" tuple is NEVER
        // resolved on the flat-map path. This SDK has adopted the
        // full-config factory (compiled-in crate-root export), so the
        // capability probe always passes; the skip branch is retained so a
        // future fixture that adds a non-full-config rule tuple is reported
        // with its reason rather than silently mis-routed.
        if cfg.injection_mode != "full-config" {
            skips.push(format!(
                "{:?} → injectionMode={:?} not supported by the rules runner",
                tuple.description, cfg.injection_mode
            ));
            continue;
        }

        let overrides =
            create_flag_overrides_from_config(cfg.config.clone(), OverrideBehaviour::LocalOnly);
        let client = Client::builder(PARITY_SDK_KEY)
            .polling_mode(PollingMode::ManualPoll)
            .flag_overrides(overrides)
            .cache_directory(std::path::PathBuf::from(":memory:"))
            .build()
            .expect("client build");

        // Pick a typed default that matches the setting's declared type
        // (spec 152 / #475, US2). The strict evaluator distinguishes int
        // (t=2) from double (t=3), so the i64-encoded corpus default `-1`
        // must be widened to f64 for the `decimal` tuples — mirroring the
        // python/go/swift runners — rather than relaxing the evaluator.
        let default = typed_default(&cfg.config, &tuple.key, &tuple.default_value);

        let user_owned = tuple.user.as_ref().map(CorpusUser::to_user);
        let actual: Value = client
            .get_value::<Value>(&tuple.key, default.clone(), user_owned.as_ref())
            .await;

        ran += 1;
        // Numeric-aware value comparison (spec 152 / #475, US2). The 4
        // decimal variationId tuples expose the `serde_json::Value::Number`
        // strict-equality nuance: int `0` vs float `0.0`, and the
        // edge-precision doubles `-2147483647.2147484` /
        // `0.12345678912345678`. When BOTH sides are JSON numbers, compare
        // as f64 (exact f64 equality — total for the precision doubles, and
        // int-vs-float compare equal). Every non-number comparison keeps
        // strict `Value` equality, so bool / string / array / object
        // tuples are NOT weakened.
        if !values_equal(&actual, &tuple.expected) {
            failures.push(format!(
                "Rule parity drift on {:?}\n  expected: {} ({})\n  actual:   {} ({})",
                tuple.description,
                tuple.expected,
                value_kind(&tuple.expected),
                actual,
                value_kind(&actual),
            ));
        }

        // variationId assertion (spec 152 / #475, US2) — only for tuples
        // carrying `expectedVariationId`. Asserts the PUBLIC
        // `get_value_details().variation_id` (Principle II: against the
        // SDK's public surface) IN ADDITION to the value above. This is
        // the gate for the #395 override→get_value_details propagation
        // class: a full-config override must surface variation_id, not
        // drop it.
        if let Some(expected_vid) = &tuple.expected_variation_id {
            let details = client
                .get_value_details::<Value>(&tuple.key, default.clone(), user_owned.as_ref())
                .await;
            match &details.variation_id {
                Some(vid) if vid == expected_vid => {}
                other => {
                    failures.push(format!(
                        "variationId drift on {:?}\n  expected variation_id: {:?}\n  \
                         actual variation_id:   {:?}",
                        tuple.description, expected_vid, other,
                    ));
                }
            }
        }

        client.close();
    }

    if !skips.is_empty() {
        // A skip is reported with its reason (no false-green) — but for
        // sdk-rust every rule tuple is full-config, so any skip is a fixture
        // regression worth surfacing loudly.
        panic!(
            "{} rule tuple(s) skipped — sdk-rust expects every rule tuple to \
             be full-config (SC-004).\n\n{}",
            skips.len(),
            skips.join("\n")
        );
    }

    // Growth-tolerant: every LOADED tuple must have run (stronger than a fixed
    // number, and never needs a per-spec bump as the corpus grows).
    assert_eq!(
        ran,
        tuples.len(),
        "expected every loaded rule tuple to run, ran {ran} of {}",
        tuples.len()
    );

    if !failures.is_empty() {
        panic!(
            "{}/{} rule parity tuples drifted — Constitution Principle II \
             NON-NEGOTIABLE; investigate the evaluator / override-eval \
             code, do NOT mutate the corpus.\n\n{}",
            failures.len(),
            tuples.len(),
            failures.join("\n\n"),
        );
    }
}

/// Numeric-aware value equality for the parity comparison (spec 152 /
/// #475, US2).
///
/// When BOTH sides are JSON numbers, compares as `f64` so the
/// `serde_json::Value::Number` strict-equality nuance never trips a
/// false drift: an int-encoded `0` and a float-encoded `0.0` compare
/// equal, and the edge-precision decimal doubles
/// (`-2147483647.2147484`, `0.12345678912345678`) compare with exact
/// `f64` equality (they round-trip to the same `f64` bit pattern through
/// `serde_json`, so exact equality is correct — no epsilon needed).
///
/// Every NON-number comparison falls back to strict `Value` equality, so
/// bool / string / array / object / null tuples are NOT weakened.
fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(xf), Some(yf)) => xf == yf,
            // A non-f64-representable number (shouldn't occur in this
            // corpus) falls back to strict equality.
            _ => x == y,
        },
        _ => a == b,
    }
}

fn value_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
