// SPDX-License-Identifier: MIT

//! ConfigCat conformance gate (spec 125, SC-001) — the Rust engine replays
//! the vendored upstream evaluation matrix. Mirrors the spec-117 TS reference
//! suite (`packages/sdk-shared/tests/parity-upstream.test.ts`) and the
//! Python / Go / Ruby / PHP / Dart / Elixir ports. The corpus
//! (`packages/test-fixtures-sdk-parity/fixtures/upstream/`, anchor
//! `configcat/go-sdk@08c4882` v9 — see `fixtures/upstream/PROVENANCE.md`) is
//! the oracle: each `(config, key, user) → expected` tuple is checked against
//! the internal evaluator's `EvalResult.value` (and `.variation_id` for the
//! variation-id matrix).
//!
//! Scope = the full conformance surface: US1 targeting rules, US2 the 36
//! comparators, US3 percentage rollout, US4 segments / prerequisites (incl.
//! multilevel + circular detection) / AND-groups, US5 attribute conversion +
//! trimming + typed-attribute validation + variationId / matched detail.
//! Per FR-018 only structured value / identity is asserted — never a textual
//! trace.
//!
//! The loaders port `packages/test-fixtures-sdk-parity/src/upstream-corpus.ts`
//! faithfully — most critically the Go `csv.Reader` LazyQuotes semantics (a
//! `"` only opens a quoted field at the field START), without which every
//! JSON-array attribute cell is corrupted. The CSV is parsed by a hand-rolled
//! LazyQuotes reader; a naive `split(';')` mis-parses the JSON-array cells.
//!
//! Custom attributes are fed through a typed [`AttrValue`] map (the doc-hidden
//! `__eval_test_api`) so the conversion-driver cases can deliver numbers /
//! arrays / epochs un-stringified — the public `confeature::User` stringifies
//! custom values by contract, which would defeat those cases.

mod common;

use confeature::__eval_test_api::{
    evaluate_traced_with_attrs, evaluate_with_attrs, AttrValue, EvalResult, TraceLogLevel,
    TraceLogger,
};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Instant;

const NULL_TOKEN: &str = "##null##";

const PKD: &str = "configcat-sdk-1/PKDVCLf-Hq-h-kCzMp-L7Q/";
const JCP: &str = "configcat-sdk-1/JcPbCGl_1E-K9M-fJOyKyQ/";

/// `dependentFeatureMultipleLevels` is the ONE corpus case whose config blob
/// was NOT captured by the spec-117 vendoring (known DATA gap #401, not an
/// engine gap — see the assertion below: the flag is absent from the
/// `prerequisite_flag` config's `f` map). The multilevel-prerequisite path IS
/// exercised by `multilevel_prerequisite_resolves_through_reconstructed_chain`
/// and the circular-dep chain below. Excluded LOUDLY (the same marker the TS /
/// Python / Ruby / PHP references use), never silently.
const UNVENDORED_EVAL_LOG_KEYS: &[&str] = &["dependentFeatureMultipleLevels"];

// ─────────────────────────────────────────────────────────────────────────
// Setting types (mirror evaluator.rs / config-json.ts discriminators).
// ─────────────────────────────────────────────────────────────────────────

const SETTING_TYPE_INT: u64 = 2;
const SETTING_TYPE_DOUBLE: u64 = 3;

// ─────────────────────────────────────────────────────────────────────────
// CorpusUser — a typed value object the evaluator reads via AttrValue. The
// three well-known attributes are strings (mirroring the public surface);
// custom attributes keep their native JSON type so the conversion driver
// exercises the native-numeric / array / epoch branches un-stringified.
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct CorpusUser {
    identifier: String,
    email: Option<String>,
    country: Option<String>,
    custom: HashMap<String, AttrValue>,
}

impl CorpusUser {
    fn to_attrs(&self) -> HashMap<String, AttrValue> {
        let mut m = HashMap::new();
        m.insert(
            "Identifier".to_string(),
            AttrValue::Str(self.identifier.clone()),
        );
        if let Some(email) = &self.email {
            m.insert("Email".to_string(), AttrValue::Str(email.clone()));
        }
        if let Some(country) = &self.country {
            m.insert("Country".to_string(), AttrValue::Str(country.clone()));
        }
        for (k, v) in &self.custom {
            m.insert(k.clone(), v.clone());
        }
        m
    }

    fn repr(user: Option<&CorpusUser>) -> String {
        match user {
            None => "null".to_string(),
            Some(u) => format!(
                "id={:?} email={:?} country={:?} custom={:?}",
                u.identifier, u.email, u.country, u.custom
            ),
        }
    }
}

/// Evaluate, mapping `None` user to no attrs (so a missing user exercises the
/// fail-open fallback rather than an empty attr map).
fn eval(config: &Value, key: &str, default: &Value, user: Option<&CorpusUser>) -> EvalResult {
    let attrs = user.map(CorpusUser::to_attrs);
    evaluate_with_attrs(Some(config), key, default, attrs.as_ref())
}

// ─────────────────────────────────────────────────────────────────────────
// Matrix → SDK key mapping (verbatim from upstream-corpus.ts).
// ─────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum MatrixKind {
    Value,
    Variation,
}

struct MatrixEntry {
    sdk_key: String,
    kind: MatrixKind,
}

fn matrix_entry(matrix: &str) -> MatrixEntry {
    let (suffix_base, suffix, kind) = match matrix {
        "testmatrix.csv" => (PKD, "AG6C1ngVb0CvM07un6JisQ", MatrixKind::Value),
        "testmatrix_semantic.csv" => (PKD, "iV8vH2MBakKxkFZylxHmTg", MatrixKind::Value),
        "testmatrix_number.csv" => (PKD, "FCWN-k1dV0iBf8QZrDgjdw", MatrixKind::Value),
        "testmatrix_semantic_2.csv" => (PKD, "U8nt3zEhDEO5S2ulubCopA", MatrixKind::Value),
        "testmatrix_sensitive.csv" => (PKD, "-0YmVOUNgEGKkgRF-rU65g", MatrixKind::Value),
        "testmatrix_segments_old.csv" => (PKD, "y_ZB7o-Xb0Swxth-ZlMSeA", MatrixKind::Value),
        "testmatrix_and_or.csv" => (JCP, "ByMO9yZNn02kXcm72lnY1A", MatrixKind::Value),
        "testmatrix_comparators_v6.csv" => (JCP, "OfQqcTjfFUGBwMKqtyEOrQ", MatrixKind::Value),
        "testmatrix_prerequisite_flag.csv" => (JCP, "JoGwdqJZQ0K2xDy7LnbyOg", MatrixKind::Value),
        "testmatrix_segments.csv" => (JCP, "h99HYXWWNE2bH8eWyLAVMA", MatrixKind::Value),
        "testmatrix_unicode.csv" => (JCP, "Da6w8dBbmUeMUBhh0iEeQQ", MatrixKind::Value),
        "testmatrix_variationId.csv" => (PKD, "spQnkRTIPEWVivZkWM84lQ", MatrixKind::Variation),
        other => panic!("unknown testmatrix file: {other}"),
    };
    MatrixEntry {
        sdk_key: format!("{suffix_base}{suffix}"),
        kind,
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Config loaders.
// ─────────────────────────────────────────────────────────────────────────

fn content_by_key() -> Value {
    common::upstream_json("content-by-key.json")
}

fn eval_log_configs() -> Value {
    common::upstream_json("evaluationlog/_configs-by-key.json")
}

// ─────────────────────────────────────────────────────────────────────────
// CSV parsing — Go csv.Reader with Comma=';' + LazyQuotes=true (port). A `"`
// only opens a quoted field when it is the FIRST char of the field; anywhere
// else it is a literal quote. Getting this wrong corrupts every JSON-array
// attribute cell.
// ─────────────────────────────────────────────────────────────────────────

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut field_start = true;
    let bytes: Vec<char> = line.chars().collect();
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        let ch = bytes[i];
        if in_quotes && ch == '"' && i + 1 < n && bytes[i + 1] == '"' {
            field.push('"');
            i += 1;
        } else if in_quotes && ch == '"' {
            in_quotes = false;
        } else if in_quotes {
            field.push(ch);
        } else if ch == '"' && field_start {
            in_quotes = true;
            field_start = false;
        } else if ch == ';' {
            fields.push(std::mem::take(&mut field));
            field_start = true;
        } else {
            field.push(ch);
            field_start = false;
        }
        i += 1;
    }
    fields.push(field);
    fields
}

/// Parse a CSV cell to its primitive JSON value (mirrors upstream `parseCell`).
fn parse_cell(s: &str) -> Value {
    // Integer (safe-integer range, exact round-trip).
    if is_plain_integer(s) {
        if let Ok(n) = s.parse::<i64>() {
            if n.abs() <= 9_007_199_254_740_991 && n.to_string() == s {
                return Value::Number(n.into());
            }
        }
    }
    // Float.
    if is_decimal(s) {
        if let Ok(f) = s.parse::<f64>() {
            if let Some(num) = serde_json::Number::from_f64(f) {
                return Value::Number(num);
            }
        }
    }
    if s == "True" {
        return Value::Bool(true);
    }
    if s == "False" {
        return Value::Bool(false);
    }
    Value::String(s.to_string())
}

fn is_plain_integer(s: &str) -> bool {
    let t = s.strip_prefix('-').unwrap_or(s);
    !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit())
}

fn is_decimal(s: &str) -> bool {
    // ^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$
    let b = s.as_bytes();
    let mut i = 0;
    let n = b.len();
    if i < n && b[i] == b'-' {
        i += 1;
    }
    let start = i;
    let mut saw_int = false;
    while i < n && b[i].is_ascii_digit() {
        i += 1;
        saw_int = true;
    }
    let mut saw_frac = false;
    if i < n && b[i] == b'.' {
        i += 1;
        while i < n && b[i].is_ascii_digit() {
            i += 1;
            saw_frac = true;
        }
    }
    // require at least one digit (either int part or frac part)
    if !(saw_int || saw_frac) || i == start {
        return false;
    }
    if i < n && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < n && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < n && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == n
}

/// Build a CorpusUser from the first four CSV columns (port `userFromRow`).
/// Custom attributes from the CSV are always strings (the native-typed branch
/// is exercised by the conversion driver instead).
fn user_from_row(line: &[String], custom_key: &str) -> Option<CorpusUser> {
    if line.is_empty() || line.first().map(String::as_str) == Some(NULL_TOKEN) {
        return None;
    }
    let set_or_null = |v: Option<&String>| -> Option<String> {
        match v {
            None => None,
            Some(s) if s.is_empty() || s == NULL_TOKEN => None,
            Some(s) => Some(s.clone()),
        }
    };
    let identifier = line.first().cloned().unwrap_or_default();
    let email = set_or_null(line.get(1));
    let country = set_or_null(line.get(2));
    let custom_val = set_or_null(line.get(3));
    let mut custom = HashMap::new();
    if let Some(v) = custom_val {
        custom.insert(custom_key.to_string(), AttrValue::Str(v));
    }
    Some(CorpusUser {
        identifier,
        email,
        country,
        custom,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// Matrix loader.
// ─────────────────────────────────────────────────────────────────────────

struct MatrixTuple {
    matrix: String,
    key: String,
    user: Option<CorpusUser>,
    kind: MatrixKind,
    /// For Value matrices, the expected primitive; for Variation matrices, a
    /// `Value::String` of the raw variation id.
    expected: Value,
    config: Value,
}

fn load_matrix(matrix: &str) -> Vec<MatrixTuple> {
    let entry = matrix_entry(matrix);
    let content = content_by_key();
    let config = content
        .get(&entry.sdk_key)
        .unwrap_or_else(|| panic!("no config for matrix {matrix} (sdkKey {})", entry.sdk_key))
        .clone();

    let text = common::upstream_text(matrix);
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.is_empty())
        .collect();
    let header = parse_csv_line(lines[0]);
    let custom_key = header
        .get(3)
        .cloned()
        .unwrap_or_else(|| "Custom1".to_string());
    let setting_keys: Vec<String> = header.iter().skip(4).cloned().collect();

    let mut tuples = Vec::new();
    for line in lines.iter().skip(1) {
        let cols = parse_csv_line(line);
        let user = user_from_row(&cols, &custom_key);
        for (c, key) in setting_keys.iter().enumerate() {
            let raw = cols.get(c + 4).cloned().unwrap_or_default();
            let expected = match entry.kind {
                MatrixKind::Value => parse_cell(&raw),
                MatrixKind::Variation => Value::String(raw),
            };
            tuples.push(MatrixTuple {
                matrix: matrix.to_string(),
                key: key.clone(),
                user: user.clone(),
                kind: entry.kind,
                expected,
                config: config.clone(),
            });
        }
    }
    tuples
}

// ─────────────────────────────────────────────────────────────────────────
// evaluationlog/<scenario> loader (port loadEvalLogScenario).
// ─────────────────────────────────────────────────────────────────────────

struct EvalLogTuple {
    scenario: String,
    key: String,
    default_value: Value,
    user: Option<CorpusUser>,
    expected_value: Value,
    config: Value,
}

/// Convert a raw eval-log user object into a CorpusUser. Custom attributes
/// keep their native JSON type (so a numeric / bool custom attr reaches the
/// comparator un-stringified, exercising the native-typed branch).
fn eval_log_user(raw: Option<&Value>) -> Option<CorpusUser> {
    let obj = raw?.as_object()?;
    if obj.is_empty() {
        return None;
    }
    let mut identifier = String::new();
    let mut email = None;
    let mut country = None;
    let mut custom: HashMap<String, AttrValue> = HashMap::new();
    for (k, v) in obj {
        match k.as_str() {
            "Identifier" => identifier = json_to_string_coerce(v),
            "Email" => email = Some(json_to_string_coerce(v)),
            "Country" => country = Some(json_to_string_coerce(v)),
            _ => {
                custom.insert(k.clone(), json_to_attr(v));
            }
        }
    }
    Some(CorpusUser {
        identifier,
        email,
        country,
        custom,
    })
}

fn json_to_string_coerce(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn json_to_attr(v: &Value) -> AttrValue {
    match v {
        Value::String(s) => AttrValue::Str(s.clone()),
        Value::Bool(b) => AttrValue::Bool(*b),
        Value::Number(n) => AttrValue::Num(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => {
            let mut strs = Vec::with_capacity(items.len());
            let mut all_str = true;
            for it in items {
                match it.as_str() {
                    Some(s) => strs.push(s.to_string()),
                    None => {
                        all_str = false;
                        break;
                    }
                }
            }
            if all_str {
                AttrValue::StrArray(strs)
            } else {
                // Non-string array → stringify the JSON (matches the public
                // contract's string fallback).
                AttrValue::Str(v.to_string())
            }
        }
        Value::Null => AttrValue::Str(String::new()),
        Value::Object(_) => AttrValue::Str(v.to_string()),
    }
}

fn eval_log_config(suite: &Value) -> Value {
    if let Some(over) = suite.get("jsonOverride").and_then(Value::as_str) {
        return common::upstream_json(&format!("evaluationlog/_overrides/{over}"));
    }
    if let Some(sdk_key) = suite.get("sdkKey").and_then(Value::as_str) {
        let content = content_by_key();
        if let Some(cfg) = content.get(sdk_key) {
            return cfg.clone();
        }
        let extra = eval_log_configs();
        if let Some(cfg) = extra.get(sdk_key) {
            return cfg.clone();
        }
        panic!("no config for eval-log sdkKey {sdk_key}");
    }
    panic!("eval-log suite has neither jsonOverride nor sdkKey");
}

fn load_eval_log_scenario(scenario: &str) -> Vec<EvalLogTuple> {
    let suite = common::upstream_json(&format!("evaluationlog/{scenario}.json"));
    let config = eval_log_config(&suite);
    let tests = suite
        .get("tests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for t in &tests {
        let Some(obj) = t.as_object() else { continue };
        out.push(EvalLogTuple {
            scenario: scenario.to_string(),
            key: obj
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            default_value: obj.get("defaultValue").cloned().unwrap_or(Value::Null),
            user: eval_log_user(obj.get("user")),
            expected_value: obj.get("returnValue").cloned().unwrap_or(Value::Null),
            config: config.clone(),
        });
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────
// Assertion helpers.
// ─────────────────────────────────────────────────────────────────────────

fn setting_type(config: &Value, key: &str) -> Option<u64> {
    config.get("f")?.get(key)?.get("t").and_then(Value::as_u64)
}

/// Type-appropriate default matching the resolved primitive kind. The strict
/// evaluator distinguishes int (t=2) from double (t=3), so the default must be
/// the SAME numeric kind the setting type expects.
fn default_for(expected: &Value, stype: Option<u64>) -> Value {
    match expected {
        Value::Bool(_) => Value::Bool(false),
        Value::Number(_) => {
            if stype == Some(SETTING_TYPE_DOUBLE) {
                Value::Number(serde_json::Number::from_f64(0.0).unwrap())
            } else {
                Value::Number(0i64.into())
            }
        }
        _ => Value::String("__default__".to_string()),
    }
}

/// Cast a JSON-decoded eval-log default to the type implied by `t`.
fn coerce_default(default: &Value, stype: Option<u64>) -> Value {
    match (default, stype) {
        (Value::Bool(_), _) => default.clone(),
        (Value::Number(n), Some(SETTING_TYPE_DOUBLE)) if n.is_i64() => {
            Value::Number(serde_json::Number::from_f64(n.as_f64().unwrap_or(0.0)).unwrap())
        }
        (Value::Number(n), Some(SETTING_TYPE_INT)) if n.as_i64().is_none() => {
            Value::Number((n.as_f64().unwrap_or(0.0) as i64).into())
        }
        _ => default.clone(),
    }
}

/// A default value of the kind the setting type expects (so the strict
/// type-guard passes and evaluation proceeds — used by the variation matrix,
/// whose variation id is value-independent).
fn default_for_setting_type(stype: Option<u64>) -> Value {
    match stype {
        Some(0) => Value::Bool(false),
        Some(SETTING_TYPE_INT) => Value::Number(0i64.into()),
        Some(SETTING_TYPE_DOUBLE) => Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
        _ => Value::String("__default__".to_string()),
    }
}

/// Numeric-tolerant equality (5 == 5.0); booleans must not equate with numbers.
fn value_equal(actual: &Value, expected: &Value) -> bool {
    match expected {
        Value::Number(en) => {
            let Value::Number(an) = actual else {
                return false;
            };
            let ef = en.as_f64();
            let af = an.as_f64();
            match (af, ef) {
                (Some(a), Some(e)) => a == e || (a.is_nan() && e.is_nan()),
                _ => false,
            }
        }
        Value::Bool(_) => actual == expected,
        _ => actual == expected,
    }
}

fn assert_matrix_tuple(t: &MatrixTuple, failures: &mut Vec<String>) {
    let label = format!(
        "{} {} user={}",
        t.matrix,
        t.key,
        CorpusUser::repr(t.user.as_ref())
    );
    match t.kind {
        MatrixKind::Variation => {
            // The variation id is independent of the resolved value, but the
            // strict evaluator type-guards the default against the setting
            // type before evaluating — so feed a type-matched default (a
            // mismatch would short-circuit to a fail-closed empty variation).
            let default = default_for_setting_type(setting_type(&t.config, &t.key));
            let r = eval(&t.config, &t.key, &default, t.user.as_ref());
            let actual = Value::String(r.variation_id);
            if actual != t.expected {
                failures.push(format!("{label}: actual={actual} expected={}", t.expected));
            }
        }
        MatrixKind::Value => {
            let default = default_for(&t.expected, setting_type(&t.config, &t.key));
            let r = eval(&t.config, &t.key, &default, t.user.as_ref());
            if !value_equal(&r.value, &t.expected) {
                failures.push(format!(
                    "{label}: actual={} expected={}",
                    r.value, t.expected
                ));
            }
        }
    }
}

fn assert_eval_log_value(t: &EvalLogTuple, failures: &mut Vec<String>) {
    let stype = setting_type(&t.config, &t.key);
    let default = if t.default_value.is_null() {
        default_for(&t.expected_value, stype)
    } else {
        coerce_default(&t.default_value, stype)
    };
    let label = format!(
        "{} {} user={}",
        t.scenario,
        t.key,
        CorpusUser::repr(t.user.as_ref())
    );
    let r = eval(&t.config, &t.key, &default, t.user.as_ref());
    if !value_equal(&r.value, &t.expected_value) {
        failures.push(format!(
            "{label}: actual={} expected={}",
            r.value, t.expected_value
        ));
    }
}

fn comparison_config(fixture: &str) -> Value {
    common::upstream_json(&format!("{fixture}.json"))
}

fn assert_no_failures(failures: &[String]) {
    assert!(
        failures.is_empty(),
        "{} drift — Constitution Principle II NON-NEGOTIABLE; fix the \
         evaluator, never the corpus.\n{}",
        failures.len(),
        failures.join("\n")
    );
}

// =========================================================================
// US1 / US2 — value + comparator matrices
// =========================================================================

#[test]
fn value_matrices() {
    for matrix in [
        "testmatrix.csv",
        "testmatrix_comparators_v6.csv",
        "testmatrix_semantic.csv",
        "testmatrix_semantic_2.csv",
        "testmatrix_number.csv",
        "testmatrix_sensitive.csv",
        "testmatrix_unicode.csv",
    ] {
        let tuples = load_matrix(matrix);
        assert!(!tuples.is_empty(), "{matrix} produced no tuples");
        let mut failures = Vec::new();
        for t in &tuples {
            assert_matrix_tuple(t, &mut failures);
        }
        assert_no_failures(&failures);
    }
}

// =========================================================================
// US1 — targeting-rule eval-log scenarios
// =========================================================================

#[test]
fn targeting_rule_scenarios() {
    for scenario in ["1_targeting_rule", "2_targeting_rules", "simple_value"] {
        let tuples = load_eval_log_scenario(scenario);
        assert!(!tuples.is_empty(), "{scenario} produced no tuples");
        let mut failures = Vec::new();
        for t in &tuples {
            assert_eval_log_value(t, &mut failures);
        }
        assert_no_failures(&failures);
    }
}

#[test]
fn matched_targeting_rule_is_reported() {
    let cases = load_eval_log_scenario("1_targeting_rule");
    let matching = cases
        .iter()
        .find(|c| c.expected_value == Value::String("Dog".to_string()))
        .expect("a Dog-matching case in 1_targeting_rule");
    let r = eval(
        &matching.config,
        &matching.key,
        &Value::String("default".to_string()),
        matching.user.as_ref(),
    );
    assert_eq!(r.value, Value::String("Dog".to_string()));
    assert!(r.matched_targeting_rule);
    assert!(!r.matched_percentage_option);
    assert_eq!(r.variation_id, "d0cd8f06");
}

#[test]
fn no_user_serves_fallback_and_never_throws() {
    let cases = load_eval_log_scenario("1_targeting_rule");
    let no_user = cases
        .iter()
        .find(|c| c.user.is_none())
        .expect("a no-user case in 1_targeting_rule");
    let r = eval(
        &no_user.config,
        &no_user.key,
        &Value::String("default".to_string()),
        None,
    );
    assert_eq!(r.value, Value::String("Cat".to_string())); // fallback
    assert_eq!(r.error, ""); // a value was cleanly resolved
    assert!(!r.matched_targeting_rule);
}

// =========================================================================
// US3 — percentage rollout
// =========================================================================

#[test]
fn percentage_scenarios() {
    for scenario in [
        "options_based_on_user_id",
        "options_based_on_custom_attr",
        "options_after_targeting_rule",
        "options_within_targeting_rule",
    ] {
        let tuples = load_eval_log_scenario(scenario);
        assert!(!tuples.is_empty(), "{scenario} produced no tuples");
        let mut failures = Vec::new();
        for t in &tuples {
            assert_eval_log_value(t, &mut failures);
        }
        assert_no_failures(&failures);
    }
}

/// Percentage bucketing must be repeat-invariant (FR percentage determinism).
#[test]
fn percentage_bucketing_is_deterministic() {
    let cases = load_eval_log_scenario("options_based_on_user_id");
    let with_user = cases
        .iter()
        .find(|c| c.user.is_some())
        .expect("a with-user case in options_based_on_user_id");
    let stype = setting_type(&with_user.config, &with_user.key);
    let default = default_for(&with_user.expected_value, stype);
    let first = eval(
        &with_user.config,
        &with_user.key,
        &default,
        with_user.user.as_ref(),
    );
    for _ in 0..20 {
        let again = eval(
            &with_user.config,
            &with_user.key,
            &default,
            with_user.user.as_ref(),
        );
        assert_eq!(
            first.value, again.value,
            "percentage bucketing must be repeat-invariant"
        );
        assert_eq!(first.variation_id, again.variation_id);
    }
    assert!(value_equal(&first.value, &with_user.expected_value));
    assert!(first.matched_percentage_option);
}

// =========================================================================
// US4 — segments / prerequisites / AND-OR matrices + scenarios
// =========================================================================

#[test]
fn us4_matrices() {
    for matrix in [
        "testmatrix_and_or.csv",
        "testmatrix_segments.csv",
        "testmatrix_segments_old.csv",
        "testmatrix_prerequisite_flag.csv",
    ] {
        let tuples = load_matrix(matrix);
        assert!(!tuples.is_empty(), "{matrix} produced no tuples");
        let mut failures = Vec::new();
        for t in &tuples {
            assert_matrix_tuple(t, &mut failures);
        }
        assert_no_failures(&failures);
    }
}

#[test]
fn us4_eval_log_scenarios() {
    // Guard the #401 data-gap marker is still valid: the unvendored key MUST
    // be absent from the prerequisite_flag config (else the exclusion is
    // stale and we'd be skipping a case we could actually run).
    let prereq_cfg = eval_log_config(&common::upstream_json(
        "evaluationlog/prerequisite_flag.json",
    ));
    for skipped in UNVENDORED_EVAL_LOG_KEYS {
        assert!(
            prereq_cfg.get("f").and_then(|f| f.get(*skipped)).is_none(),
            "data-gap marker {skipped:?} (#401) is stale — the flag is now \
             vendored in the prerequisite_flag config; remove the exclusion \
             and assert it directly."
        );
    }

    let mut total_run = 0usize;
    for scenario in ["segment", "prerequisite_flag", "and_rules"] {
        let tuples = load_eval_log_scenario(scenario);
        assert!(!tuples.is_empty(), "{scenario} produced no tuples");
        let mut failures = Vec::new();
        for t in &tuples {
            if UNVENDORED_EVAL_LOG_KEYS.contains(&t.key.as_str()) {
                continue;
            }
            total_run += 1;
            assert_eval_log_value(t, &mut failures);
        }
        assert_no_failures(&failures);
    }
    assert!(total_run > 0, "us4 eval-log scenarios ran no tuples");
}

/// Compensates for the #401 data gap: a reconstructed A → B → C multilevel
/// prerequisite chain proves the engine recurses correctly (as PHP / Dart do).
#[test]
fn multilevel_prerequisite_resolves_through_reconstructed_chain() {
    let config = serde_json::json!({
        "p": { "u": "", "r": 0, "s": "salt" },
        "s": [],
        "f": {
            "mainFeatureWithoutUserCondition": { "t": 0, "v": { "b": true }, "i": "main", "r": [] },
            "intermediateFeature": {
                "t": 0, "v": { "b": false }, "i": "inter",
                "r": [{
                    "c": [
                        { "p": { "f": "mainFeatureWithoutUserCondition", "c": 0, "v": { "b": true } } },
                        { "p": { "f": "mainFeatureWithoutUserCondition", "c": 0, "v": { "b": true } } }
                    ],
                    "s": { "v": { "b": true }, "i": "interT" }
                }]
            },
            "dependentFeatureMultipleLevels": {
                "t": 1, "v": { "s": "Cat" }, "i": "dep",
                "r": [{
                    "c": [{ "p": { "f": "intermediateFeature", "c": 0, "v": { "b": true } } }],
                    "s": { "v": { "s": "Dog" }, "i": "depDog" }
                }]
            }
        }
    });
    let r = evaluate_with_attrs(
        Some(&config),
        "dependentFeatureMultipleLevels",
        &Value::String("default".to_string()),
        None,
    );
    assert_eq!(r.value, Value::String("Dog".to_string()));
    assert!(r.matched_targeting_rule);
}

// =========================================================================
// US4 — circular-dependency termination (SC-004): bounded + fail-closed,
// never a panic / stack overflow.
// =========================================================================

#[test]
fn circular_dep_scenarios_bounded_fallback() {
    let tuples = load_eval_log_scenario("circular_dep");
    assert!(!tuples.is_empty(), "circular_dep produced no tuples");
    let mut failures = Vec::new();
    for t in &tuples {
        let start = Instant::now();
        let r = eval(
            &t.config,
            &t.key,
            &Value::String("default".to_string()),
            t.user.as_ref(),
        );
        let elapsed = start.elapsed();
        if elapsed.as_secs_f64() >= 1.0 {
            failures.push(format!(
                "{} took too long ({elapsed:?}) — cycle not bounded",
                t.key
            ));
        }
        if r.value != Value::String("default".to_string()) {
            failures.push(format!(
                "{} value={} (expected fail-closed default)",
                t.key, r.value
            ));
        }
        if r.error.is_empty() {
            failures.push(format!("{} resolved with no error code", t.key));
        }
    }
    assert_no_failures(&failures);
}

#[test]
fn direct_two_flag_cycle_terminates() {
    let config = serde_json::json!({
        "p": { "u": "", "r": 0, "s": "salt" },
        "s": [],
        "f": {
            "flagA": {
                "t": 1, "v": { "s": "A" }, "i": "a",
                "r": [{ "c": [{ "p": { "f": "flagB", "c": 0, "v": { "b": true } } }], "s": { "v": { "s": "AA" }, "i": "aa" } }]
            },
            "flagB": {
                "t": 1, "v": { "s": "B" }, "i": "b",
                "r": [{ "c": [{ "p": { "f": "flagA", "c": 0, "v": { "b": true } } }], "s": { "v": { "s": "BB" }, "i": "bb" } }]
            }
        }
    });
    let start = Instant::now();
    let r = evaluate_with_attrs(
        Some(&config),
        "flagA",
        &Value::String("default".to_string()),
        None,
    );
    assert!(
        start.elapsed().as_secs_f64() < 1.0,
        "a direct two-flag cycle must terminate bounded"
    );
    assert_eq!(r.value, Value::String("default".to_string()));
    assert!(!r.error.is_empty());
}

// =========================================================================
// US5 — normalization / conversion / trimming (comparison_*.json drivers)
// =========================================================================

#[test]
fn comparison_attribute_conversion() {
    let config = comparison_config("comparison_attribute_conversion");
    struct Case {
        key: &'static str,
        custom1: AttrValue,
        expected: &'static str,
    }
    let driver = vec![
        Case {
            key: "numberToStringConversion",
            custom1: AttrValue::Num(0.12345),
            expected: "1",
        },
        Case {
            key: "numberToStringConversionInt",
            custom1: AttrValue::Num(125.0),
            expected: "4",
        },
        Case {
            key: "numberToStringConversionPositiveExp",
            custom1: AttrValue::Num(-1.23456789e96),
            expected: "2",
        },
        Case {
            key: "numberToStringConversionNegativeExp",
            custom1: AttrValue::Num(-1.23456789e-96),
            expected: "4",
        },
        Case {
            key: "numberToStringConversionNaN",
            custom1: AttrValue::Num(f64::NAN),
            expected: "3",
        },
        Case {
            key: "numberToStringConversionPositiveInf",
            custom1: AttrValue::Num(f64::INFINITY),
            expected: "4",
        },
        Case {
            key: "numberToStringConversionNegativeInf",
            custom1: AttrValue::Num(f64::NEG_INFINITY),
            expected: "3",
        },
        Case {
            key: "dateToStringConversion",
            custom1: AttrValue::DateSeconds(1680307199.999),
            expected: "3",
        },
        Case {
            key: "dateToStringConversionNaN",
            custom1: AttrValue::DateSeconds(f64::NAN),
            expected: "3",
        },
        Case {
            key: "dateToStringConversionPositiveInf",
            custom1: AttrValue::DateSeconds(f64::INFINITY),
            expected: "1",
        },
        Case {
            key: "dateToStringConversionNegativeInf",
            custom1: AttrValue::DateSeconds(f64::NEG_INFINITY),
            expected: "5",
        },
        Case {
            key: "stringArrayToStringConversion",
            custom1: AttrValue::StrArray(vec!["read".into(), "Write".into(), " eXecute ".into()]),
            expected: "4",
        },
        Case {
            key: "stringArrayToStringConversionEmpty",
            custom1: AttrValue::StrArray(vec![]),
            expected: "5",
        },
        Case {
            key: "stringArrayToStringConversionSpecialChars",
            custom1: AttrValue::StrArray(vec!["+<>%\"'\\/\t\r\n".into()]),
            expected: "3",
        },
        Case {
            key: "stringArrayToStringConversionUnicode",
            custom1: AttrValue::StrArray(vec!["äöüÄÖÜçéèñışğâ¢™✓😀".into()]),
            expected: "2",
        },
    ];
    let mut failures = Vec::new();
    for c in &driver {
        let mut custom = HashMap::new();
        custom.insert("Custom1".to_string(), c.custom1.clone());
        let user = CorpusUser {
            identifier: "12345".to_string(),
            email: None,
            country: None,
            custom,
        };
        let r = eval(
            &config,
            c.key,
            &Value::String("default".to_string()),
            Some(&user),
        );
        if r.value != Value::String(c.expected.to_string()) {
            failures.push(format!(
                "{}: actual={} expected={:?}",
                c.key, r.value, c.expected
            ));
        }
    }
    assert_no_failures(&failures);
}

/// Native-typed custom attributes must reach the numeric comparator
/// un-stringified and evaluate identically to their string spelling — this
/// exercises the `AttrValue::Num` branch, not only the string→float coercion
/// path that the matrix CSVs and (all-string) eval-log scenarios cover.
#[test]
fn native_numeric_custom_attribute_matches_string_form() {
    let config = serde_json::json!({
        "p": { "u": "", "r": 0, "s": "salt" },
        "s": [],
        "f": {
            "numericGate": {
                "t": 1,
                "a": "Custom1",
                "v": { "s": "no-match" },
                "i": "ng",
                "r": [{
                    // c=15 is NUMBER_GREATER_OR_EQUALS.
                    "c": [{ "u": { "a": "Custom1", "c": 15, "d": 18.0 } }],
                    "s": { "v": { "s": "match" }, "i": "m" }
                }]
            }
        }
    });
    let cases: Vec<(&str, AttrValue, &str)> = vec![
        ("native-int-pass", AttrValue::Num(21.0), "match"),
        ("native-float-pass", AttrValue::Num(18.0), "match"),
        ("native-int-fail", AttrValue::Num(17.0), "no-match"),
        ("native-float-fail", AttrValue::Num(17.999), "no-match"),
        ("string-int-pass", AttrValue::Str("21".into()), "match"),
        ("string-float-pass", AttrValue::Str("18.0".into()), "match"),
        ("string-int-fail", AttrValue::Str("17".into()), "no-match"),
        // ±Infinity must parse in the NUMBER comparator path (f64::INFINITY,
        // not a parse error): +inf >= 18 matches, -inf does not.
        (
            "native-pos-inf-pass",
            AttrValue::Num(f64::INFINITY),
            "match",
        ),
        (
            "native-neg-inf-fail",
            AttrValue::Num(f64::NEG_INFINITY),
            "no-match",
        ),
        (
            "string-pos-inf-pass",
            AttrValue::Str("Infinity".into()),
            "match",
        ),
        (
            "string-neg-inf-fail",
            AttrValue::Str("-Infinity".into()),
            "no-match",
        ),
    ];
    let mut failures = Vec::new();
    for (label, attr, expected) in &cases {
        let mut custom = HashMap::new();
        custom.insert("Custom1".to_string(), attr.clone());
        let user = CorpusUser {
            identifier: "12345".to_string(),
            email: None,
            country: None,
            custom,
        };
        let r = eval(
            &config,
            "numericGate",
            &Value::String("default".to_string()),
            Some(&user),
        );
        if r.value != Value::String((*expected).to_string()) {
            failures.push(format!("{label}: actual={} expected={expected:?}", r.value));
        }
    }
    assert_no_failures(&failures);
}

#[test]
fn comparison_attribute_trimming() {
    let config = comparison_config("comparison_attribute_trimming");
    let mut custom = HashMap::new();
    custom.insert("Version".to_string(), AttrValue::Str(" 1.0.0 ".into()));
    custom.insert("Number".to_string(), AttrValue::Str(" 3 ".into()));
    custom.insert("Date".to_string(), AttrValue::Str(" 1705253400 ".into()));
    let user = CorpusUser {
        identifier: " 12345 ".into(),
        email: None,
        country: Some("[\" USA \"]".into()),
        custom,
    };
    let mut failures = Vec::new();
    for (key, expected) in trimming_driver() {
        let r = eval(
            &config,
            key,
            &Value::String("default".to_string()),
            Some(&user),
        );
        if r.value != Value::String(expected.to_string()) {
            failures.push(format!("{key}: actual={} expected={expected:?}", r.value));
        }
    }
    assert_no_failures(&failures);
}

#[test]
fn comparison_value_trimming() {
    let config = comparison_config("comparison_value_trimming");
    let mut custom = HashMap::new();
    custom.insert("Version".to_string(), AttrValue::Str("1.0.0".into()));
    custom.insert("Number".to_string(), AttrValue::Str("3".into()));
    custom.insert("Date".to_string(), AttrValue::Str("1705253400".into()));
    let user = CorpusUser {
        identifier: "12345".into(),
        email: None,
        country: Some("[\"USA\"]".into()),
        custom,
    };
    let mut failures = Vec::new();
    for (key, expected) in value_trimming_driver() {
        let r = eval(
            &config,
            key,
            &Value::String("default".to_string()),
            Some(&user),
        );
        if r.value != Value::String(expected.to_string()) {
            failures.push(format!("{key}: actual={} expected={expected:?}", r.value));
        }
    }
    assert_no_failures(&failures);
}

// =========================================================================
// US5 — typed-attribute validation outcomes (FR-010) + list truncation
// =========================================================================

#[test]
fn validation_scenarios() {
    for scenario in [
        "semver_validation",
        "number_validation",
        "epoch_date_validation",
        "list_truncation",
    ] {
        let tuples = load_eval_log_scenario(scenario);
        assert!(!tuples.is_empty(), "{scenario} produced no tuples");
        let mut failures = Vec::new();
        for t in &tuples {
            assert_eval_log_value(t, &mut failures);
        }
        assert_no_failures(&failures);
    }
}

// =========================================================================
// US5 — variationId + matched rule/option detail (FR-011)
// =========================================================================

#[test]
fn variation_id_matrix() {
    let tuples = load_matrix("testmatrix_variationId.csv");
    assert!(!tuples.is_empty());
    let mut failures = Vec::new();
    for t in &tuples {
        assert_matrix_tuple(t, &mut failures);
    }
    assert_no_failures(&failures);
}

#[test]
fn segment_matched_flag_reports_value_and_variation_id() {
    let cases = load_eval_log_scenario("segment");
    let m = cases
        .iter()
        .find(|c| c.key == "featureWithSegmentTargeting" && c.user.is_some())
        .expect("a with-user segment-targeting case");
    let r = eval(&m.config, &m.key, &Value::Bool(false), m.user.as_ref());
    assert_eq!(r.value, Value::Bool(true));
    assert!(r.matched_targeting_rule);
    assert!(!r.variation_id.is_empty());
}

// -------------------------------------------------------------------------
// Trimming driver tables (ported verbatim from upstream-corpus.ts).
// -------------------------------------------------------------------------

fn trimming_driver() -> Vec<(&'static str, &'static str)> {
    let mut out: Vec<(&str, &str)> = Vec::new();
    for key in [
        "isoneof",
        "isnotoneof",
        "isoneofhashed",
        "isnotoneofhashed",
        "equalshashed",
        "notequalshashed",
        "arraycontainsanyofhashed",
        "arraynotcontainsanyofhashed",
        "equals",
        "notequals",
        "startwithanyof",
        "notstartwithanyof",
        "endswithanyof",
        "notendswithanyof",
        "arraycontainsanyof",
        "arraynotcontainsanyof",
        "startwithanyofhashed",
        "notstartwithanyofhashed",
        "endswithanyofhashed",
        "notendswithanyofhashed",
    ] {
        out.push((key, "no trim"));
    }
    for (k, v) in [
        ("semverisoneof", "4 trim"),
        ("semverisnotoneof", "5 trim"),
        ("semverless", "6 trim"),
        ("semverlessequals", "7 trim"),
        ("semvergreater", "8 trim"),
        ("semvergreaterequals", "9 trim"),
        ("numberequals", "10 trim"),
        ("numbernotequals", "11 trim"),
        ("numberless", "12 trim"),
        ("numberlessequals", "13 trim"),
        ("numbergreater", "14 trim"),
        ("numbergreaterequals", "15 trim"),
        ("datebefore", "18 trim"),
        ("dateafter", "19 trim"),
    ] {
        out.push((k, v));
    }
    out.push(("containsanyof", "no trim"));
    out.push(("notcontainsanyof", "no trim"));
    out
}

fn value_trimming_driver() -> Vec<(&'static str, &'static str)> {
    let mut out: Vec<(&str, &str)> = Vec::new();
    for key in [
        "isoneof",
        "isnotoneof",
        "containsanyof",
        "notcontainsanyof",
        "isoneofhashed",
        "isnotoneofhashed",
        "equalshashed",
        "notequalshashed",
        "arraycontainsanyofhashed",
        "arraynotcontainsanyofhashed",
        "equals",
        "notequals",
        "startwithanyof",
        "notstartwithanyof",
        "endswithanyof",
        "notendswithanyof",
        "arraycontainsanyof",
        "arraynotcontainsanyof",
        "startwithanyofhashed",
        "notstartwithanyofhashed",
        "endswithanyofhashed",
        "notendswithanyofhashed",
    ] {
        out.push((key, "no trim"));
    }
    for (k, v) in [
        ("semverisoneof", "4 trim"),
        ("semverisnotoneof", "5 trim"),
        ("semverless", "6 trim"),
        ("semverlessequals", "7 trim"),
        ("semvergreater", "8 trim"),
        ("semvergreaterequals", "9 trim"),
    ] {
        out.push((k, v));
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────
// Evaluation-log TRACE fidelity (ADR 0003 / epic #494, Rust slice of #501).
//
// Replays packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json
// (the cross-language byte-oracle; each tuple carries a Confeature-canonical
// `expectedTrace`) through `evaluate_traced_with_attrs` and asserts the emitted
// trace is byte-identical. Mirrors the Go (`parity_evallog_trace_test.go`) and
// Python (`test_eval_log_trace_fidelity`) ports. Unlike the value test above,
// the corpus carries a self-contained config per tuple, so
// `dependentFeatureMultipleLevels` IS covered here (no vendoring carve-out).
// ─────────────────────────────────────────────────────────────────────────

/// The 14 scenarios that carry an `expectedTrace`.
const TRACE_SCENARIOS: &[&str] = &[
    "simple_value",
    "1_targeting_rule",
    "2_targeting_rules",
    "and_rules",
    "options_based_on_user_id",
    "options_based_on_custom_attr",
    "options_after_targeting_rule",
    "options_within_targeting_rule",
    "list_truncation",
    "number_validation",
    "circular_dep",
    "prerequisite_flag",
    "semver_validation",
    "epoch_date_validation",
];

/// Records each emitted `(level, event_id, message)` for the capture string.
/// `level()` reports `Info` so the evaluator builds the trace. Mirrors the
/// Go/Python inline test loggers.
#[derive(Default)]
struct CaptureTraceLogger {
    calls: Vec<(TraceLogLevel, String, String)>,
}

impl TraceLogger for CaptureTraceLogger {
    fn level(&self) -> TraceLogLevel {
        TraceLogLevel::Info
    }
    fn log(&mut self, level: TraceLogLevel, event_id: &str, message: &str) {
        self.calls
            .push((level, event_id.to_string(), message.to_string()));
    }
}

fn trace_level_label(level: TraceLogLevel) -> &'static str {
    match level {
        TraceLogLevel::Error => "ERROR",
        TraceLogLevel::Warn => "WARN",
        TraceLogLevel::Info => "INFO",
        TraceLogLevel::Debug => "DEBUG",
        TraceLogLevel::Off => "?",
    }
}

/// Build the typed-attribute map from the corpus tuple's LOWERCASE user object
/// (`{identifier, email?, country?, custom?}`) — the same shape the Go/Python
/// trace tests consume. Predefined keys map to the capitalized attribute names
/// the evaluator's trace header expects; custom values keep their native type.
fn trace_attrs(user: Option<&Value>) -> Option<HashMap<String, AttrValue>> {
    let obj = user?.as_object()?;
    if obj.is_empty() {
        return None;
    }
    let mut m: HashMap<String, AttrValue> = HashMap::new();
    if let Some(v) = obj.get("identifier") {
        m.insert(
            "Identifier".to_string(),
            AttrValue::Str(json_to_string_coerce(v)),
        );
    }
    if let Some(v) = obj.get("email") {
        m.insert(
            "Email".to_string(),
            AttrValue::Str(json_to_string_coerce(v)),
        );
    }
    if let Some(v) = obj.get("country") {
        m.insert(
            "Country".to_string(),
            AttrValue::Str(json_to_string_coerce(v)),
        );
    }
    if let Some(custom) = obj.get("custom").and_then(Value::as_object) {
        for (k, v) in custom {
            m.insert(k.clone(), json_to_attr(v));
        }
    }
    if m.is_empty() {
        None
    } else {
        Some(m)
    }
}

/// Coerce a numeric default to the type the setting expects (port of the Go
/// `traceDefault` / Python `_trace_default`): the corpus decodes `3.1415`'s
/// caller default as the integer `0`, but the strict evaluator wants an `f64`
/// for a `t=3` (double) setting — otherwise a TYPE_MISMATCH fires before the
/// trace is built. Only numeric defaults need this; others pass through.
fn trace_default(default: Value, config: &Value, key: &str) -> Value {
    let Some(n) = default.as_f64() else {
        return default;
    };
    let setting_type = config
        .get("f")
        .and_then(|f| f.get(key))
        .and_then(|s| s.get("t"))
        .and_then(Value::as_u64);
    match setting_type {
        Some(SETTING_TYPE_DOUBLE) => serde_json::json!(n),
        Some(SETTING_TYPE_INT) => serde_json::json!(n as i64),
        _ => default,
    }
}

#[test]
fn eval_log_trace_fidelity() {
    let path = common::workspace_root()
        .join("packages")
        .join("test-fixtures-sdk-parity")
        .join("fixtures")
        .join("parity-evaluationlog.json");
    let raw =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let tuples: Vec<Value> =
        serde_json::from_str(&raw).expect("parity-evaluationlog.json parses as a tuple array");
    assert!(
        !tuples.is_empty(),
        "parity-evaluationlog.json produced no tuples"
    );

    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut failures: Vec<String> = Vec::new();

    for t in &tuples {
        let Some(expected) = t.get("expectedTrace").and_then(Value::as_str) else {
            continue;
        };
        let scenario = t
            .get("scenario")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !TRACE_SCENARIOS.contains(&scenario) {
            continue;
        }
        let key = t.get("key").and_then(Value::as_str).unwrap_or_default();
        let config = t.get("config").cloned().unwrap_or(Value::Null);
        let default = trace_default(
            t.get("defaultValue").cloned().unwrap_or(Value::Null),
            &config,
            key,
        );
        let attrs = trace_attrs(t.get("user"));

        let mut logger = CaptureTraceLogger::default();
        let _ = evaluate_traced_with_attrs(
            Some(&config),
            key,
            &default,
            attrs.as_ref(),
            Some(&mut logger),
        );
        let actual = logger
            .calls
            .iter()
            .map(|(level, event_id, message)| {
                format!("{}: [{event_id}] {message}", trace_level_label(*level))
            })
            .collect::<Vec<_>>()
            .join("\n");

        *seen.entry(scenario.to_string()).or_insert(0) += 1;
        if actual != expected {
            failures.push(format!(
                "trace mismatch for {scenario}/{key}\n--- want ---\n{expected}\n--- got ---\n{actual}"
            ));
        }
    }

    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    // Every trace-bearing scenario must have asserted >=1 tuple (guards a
    // silently shrinking oracle / a renamed scenario).
    for scenario in TRACE_SCENARIOS {
        assert!(
            seen.get(*scenario).copied().unwrap_or(0) > 0,
            "trace scenario {scenario:?} carried no asserted tuples"
        );
    }
}
