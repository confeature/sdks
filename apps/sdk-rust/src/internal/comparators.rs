// SPDX-License-Identifier: MIT

//! The 36 ConfigCat `UserComparator` operations — port of
//! `packages/sdk-shared/src/comparators.ts` (spec 125, research §R4),
//! plus the attribute-conversion helpers and the canonical
//! number-to-string (ported from the Go SDK's `numberToCanonicalString`,
//! which mirrors JavaScript `Number.prototype.toString`).
//!
//! Each comparator returns a [`MatchOutcome`]: `Match`, `NoMatch`, or
//! `ValidationError` (a conversion / validation failure — bad semver,
//! non-numeric number, non-array array). A `ValidationError` short-
//! circuits the AND group like `NoMatch` but is surfaced (FR-010). No
//! comparator panics.

use crate::internal::hashing::{
    hash_comparison_value, hash_comparison_value_slice, percentage_bucket,
};
use crate::internal::semver::{parse_semver, SemVer};
use std::cmp::Ordering;

// ── UserComparator numeric tags (config-json.ts) ─────────────────────
pub(crate) const TEXT_IS_ONE_OF: u64 = 0;
pub(crate) const TEXT_IS_NOT_ONE_OF: u64 = 1;
pub(crate) const TEXT_CONTAINS_ANY_OF: u64 = 2;
pub(crate) const TEXT_NOT_CONTAINS_ANY_OF: u64 = 3;
pub(crate) const SEMVER_IS_ONE_OF: u64 = 4;
pub(crate) const SEMVER_IS_NOT_ONE_OF: u64 = 5;
pub(crate) const SEMVER_LESS: u64 = 6;
pub(crate) const SEMVER_LESS_OR_EQUALS: u64 = 7;
pub(crate) const SEMVER_GREATER: u64 = 8;
pub(crate) const SEMVER_GREATER_OR_EQUALS: u64 = 9;
pub(crate) const NUMBER_EQUALS: u64 = 10;
pub(crate) const NUMBER_NOT_EQUALS: u64 = 11;
pub(crate) const NUMBER_LESS: u64 = 12;
pub(crate) const NUMBER_LESS_OR_EQUALS: u64 = 13;
pub(crate) const NUMBER_GREATER: u64 = 14;
pub(crate) const NUMBER_GREATER_OR_EQUALS: u64 = 15;
pub(crate) const SENSITIVE_TEXT_IS_ONE_OF: u64 = 16;
pub(crate) const SENSITIVE_TEXT_IS_NOT_ONE_OF: u64 = 17;
pub(crate) const DATETIME_BEFORE: u64 = 18;
pub(crate) const DATETIME_AFTER: u64 = 19;
pub(crate) const SENSITIVE_TEXT_EQUALS: u64 = 20;
pub(crate) const SENSITIVE_TEXT_NOT_EQUALS: u64 = 21;
pub(crate) const SENSITIVE_TEXT_STARTS_WITH_ANY_OF: u64 = 22;
pub(crate) const SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF: u64 = 23;
pub(crate) const SENSITIVE_TEXT_ENDS_WITH_ANY_OF: u64 = 24;
pub(crate) const SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF: u64 = 25;
pub(crate) const SENSITIVE_ARRAY_CONTAINS_ANY_OF: u64 = 26;
pub(crate) const SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF: u64 = 27;
pub(crate) const TEXT_EQUALS: u64 = 28;
pub(crate) const TEXT_NOT_EQUALS: u64 = 29;
pub(crate) const TEXT_STARTS_WITH_ANY_OF: u64 = 30;
pub(crate) const TEXT_NOT_STARTS_WITH_ANY_OF: u64 = 31;
pub(crate) const TEXT_ENDS_WITH_ANY_OF: u64 = 32;
pub(crate) const TEXT_NOT_ENDS_WITH_ANY_OF: u64 = 33;
pub(crate) const ARRAY_CONTAINS_ANY_OF: u64 = 34;
pub(crate) const ARRAY_NOT_CONTAINS_ANY_OF: u64 = 35;

/// Three-valued comparator / condition outcome (data-model §3).
/// `ValidationError` short-circuits the AND group like `NoMatch` but is
/// surfaced to the caller (FR-010).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MatchOutcome {
    Match,
    NoMatch,
    /// A user-attribute validation / conversion failure, with the
    /// human-readable reason (`the User.<attr> attribute is invalid (…)`).
    ValidationError(String),
    /// A malformed CONFIG comparison value (#509). Carries the distinct
    /// `comparison value '<v>' is invalid (<reason>)` text. Surfaced as a
    /// no-match like [`MatchOutcome::ValidationError`] but logged through a
    /// different WARN 3004 site (no "please check the User.<attr>…" suffix).
    ComparisonValueError(String),
}

impl MatchOutcome {
    fn from_bool(b: bool) -> MatchOutcome {
        if b {
            MatchOutcome::Match
        } else {
            MatchOutcome::NoMatch
        }
    }
}

/// A typed user-attribute value (mirrors ConfigCat's
/// `UserAttributeValue`). The public [`crate::User`] only carries
/// strings, so the `Str` variant is the only one produced on the public
/// path; the numeric / array / date variants exist for the typed
/// attribute-conversion corpus (which feeds them un-stringified) and for
/// a future typed-attribute public surface. The numeric / array / date
/// variants are constructed only by the corpus test via the doc-hidden
/// `__eval_test_api` re-export.
#[derive(Debug, Clone)]
pub enum AttrValue {
    Str(String),
    Num(f64),
    Bool(bool),
    StrArray(Vec<String>),
    /// A datetime as Unix seconds (already converted at the boundary).
    DateSeconds(f64),
}

impl AttrValue {
    /// Is this the "missing" sentinel? Mirrors the TS guard
    /// `attrValue == null || attrValue === ""` for user conditions —
    /// the evaluator treats an empty string as missing.
    pub(crate) fn is_empty_string(&self) -> bool {
        matches!(self, AttrValue::Str(s) if s.is_empty())
    }
}

// ── Number → canonical string (JS Number.prototype.toString) ─────────

/// Stringify a finite/non-finite number as ConfigCat's canonical string
/// (common-js `+""`), mirroring JavaScript `Number.prototype.toString`.
/// NaN / ±Infinity print as `NaN` / `Infinity` / `-Infinity`.
pub(crate) fn number_to_canonical_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    js_number_to_string(value)
}

/// Render a finite non-zero float exactly as ECMAScript `Number::toString`
/// (steps 5-10 of 7.1.12.1). Port of the Go SDK's `jsNumberToString`.
fn js_number_to_string(value: f64) -> String {
    let (sign, av) = if value < 0.0 {
        ("-", -value)
    } else {
        ("", value)
    };
    // Shortest round-tripping digits + decimal-point position n.
    let shortest = format!("{av:e}"); // d.ddde±XX form (Rust LowerExp).
    let (digits, point) = shortest_digits_and_point(&shortest);
    let k = digits.len() as i64;
    let n = point;

    if k <= n && n <= 21 {
        format!("{sign}{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let n = n as usize;
        format!("{sign}{}.{}", &digits[..n], &digits[n..])
    } else if -6 < n && n <= 0 {
        format!("{sign}0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let (exp_sign, e) = if e < 0 { ("-", -e) } else { ("+", e) };
        let mant = if k > 1 {
            format!("{}.{}", &digits[..1], &digits[1..])
        } else {
            digits[..1].to_string()
        };
        format!("{sign}{mant}e{exp_sign}{e}")
    }
}

/// Decompose a Rust `LowerExp` float string (`d.ddde±XX`) into
/// (significant digits, point), where `point` is the ECMAScript `n`
/// (count of digits before the decimal point in normalized form).
fn shortest_digits_and_point(s: &str) -> (String, i64) {
    let (mant, exp_val) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], s[i + 1..].parse::<i64>().unwrap_or(0)),
        None => (s, 0),
    };
    let (int_part, frac_part) = match mant.find('.') {
        Some(i) => (&mant[..i], &mant[i + 1..]),
        None => (mant, ""),
    };
    let mut raw: String = format!("{int_part}{frac_part}");
    let mut point = int_part.len() as i64 + exp_val;
    // Strip leading zeros (adjusting point).
    let bytes = raw.as_bytes();
    let mut lead = 0;
    while lead + 1 < bytes.len() && bytes[lead] == b'0' {
        lead += 1;
        point -= 1;
    }
    raw = raw[lead..].to_string();
    // Strip trailing zeros.
    while raw.len() > 1 && raw.ends_with('0') {
        raw.pop();
    }
    if raw.is_empty() {
        raw = "0".to_string();
    }
    (raw, point)
}

/// Compact JSON-stringify a string array (JS `JSON.stringify`: no spaces,
/// no HTML escaping). Used for `userAttributeValueToString` of arrays.
fn string_array_to_json(arr: &[String]) -> String {
    serde_json::to_string(arr).unwrap_or_else(|_| "[]".to_string())
}

/// Stringify a user-attribute value exactly as common-js
/// `userAttributeValueToString`.
pub(crate) fn user_attribute_value_to_string(value: &AttrValue) -> String {
    match value {
        AttrValue::Str(s) => s.clone(),
        AttrValue::Bool(b) => b.to_string(),
        AttrValue::Num(n) => number_to_canonical_string(*n),
        AttrValue::StrArray(a) => string_array_to_json(a),
        // common-js: a Date stringifies to its Unix seconds value (a number).
        AttrValue::DateSeconds(s) => number_to_canonical_string(*s),
    }
}

/// Strict whole-string float parse, mirroring common-js
/// `parseFloatStrict`: rejects empty / all-whitespace and a leading `0`
/// followed by a non-digit/non-`.`/non-`e` (octal / hex); else parses.
/// Returns `None` (== NaN) on rejection.
fn parse_float_strict(value: &str) -> Option<f64> {
    if value.is_empty() || value.trim().is_empty() {
        return None;
    }
    // Leading `\s*0[^\d.eE]` → reject (octal / hex).
    let trimmed_start = value.trim_start();
    let tb = trimmed_start.as_bytes();
    if tb.len() >= 2 && tb[0] == b'0' {
        let c = tb[1];
        if !(c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E') {
            return None;
        }
    }
    // JS `+value` parses the WHOLE (trimmed) string. Rust's f64 parser is
    // whole-string by default. Accept JS spellings of the specials.
    let t = value.trim();
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        "NaN" => return Some(f64::NAN),
        _ => {}
    }
    t.parse::<f64>().ok()
}

// ── Attribute → typed value, with three-valued error outcome ─────────

/// `Ok(text)` — string verbatim; else stringified. Never errors.
pub(crate) fn attribute_as_text(value: &AttrValue) -> String {
    match value {
        AttrValue::Str(s) => s.clone(),
        other => user_attribute_value_to_string(other),
    }
}

fn invalid_attr<T>(attr: &str, reason: &str) -> Result<T, String> {
    Err(format!(
        "cannot evaluate, the User.{attr} attribute is invalid ({reason})"
    ))
}

/// Attribute → semver, or a validation error.
pub(crate) fn attribute_as_semver(attr: &str, value: &AttrValue) -> Result<SemVer, String> {
    if let AttrValue::Str(s) = value {
        if let Some(v) = parse_semver(s.trim()) {
            return Ok(v);
        }
    }
    invalid_attr(
        attr,
        &format!(
            "'{}' is not a valid semantic version",
            user_attribute_value_to_string(value)
        ),
    )
}

/// Attribute → number, or a validation error.
pub(crate) fn attribute_as_number(attr: &str, value: &AttrValue) -> Result<f64, String> {
    match value {
        AttrValue::Num(n) => return Ok(*n),
        AttrValue::Str(s) => {
            let normalized = s.replacen(',', ".", 1);
            if let Some(n) = parse_float_strict(&normalized) {
                return Ok(n);
            }
            if s.trim() == "NaN" {
                return Ok(f64::NAN);
            }
        }
        _ => {}
    }
    invalid_attr(
        attr,
        &format!(
            "'{}' is not a valid decimal number",
            user_attribute_value_to_string(value)
        ),
    )
}

/// Attribute → Unix seconds, or a validation error.
pub(crate) fn attribute_as_unix_time_seconds(attr: &str, value: &AttrValue) -> Result<f64, String> {
    match value {
        AttrValue::DateSeconds(s) => return Ok(*s),
        AttrValue::Num(n) => return Ok(*n),
        AttrValue::Str(s) => {
            let normalized = s.replacen(',', ".", 1);
            if let Some(n) = parse_float_strict(&normalized) {
                return Ok(n);
            }
            if s.trim() == "NaN" {
                return Ok(f64::NAN);
            }
        }
        _ => {}
    }
    invalid_attr(
        attr,
        &format!(
            "'{}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)",
            user_attribute_value_to_string(value)
        ),
    )
}

/// Attribute → string array, or a validation error. A string attribute
/// is JSON-parsed; the result must be a string array.
pub(crate) fn attribute_as_string_array(
    attr: &str,
    value: &AttrValue,
) -> Result<Vec<String>, String> {
    if let AttrValue::StrArray(a) = value {
        return Ok(a.clone());
    }
    if let AttrValue::Str(s) = value {
        if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(s) {
            let mut out = Vec::with_capacity(items.len());
            let mut all_str = true;
            for it in &items {
                match it.as_str() {
                    Some(v) => out.push(v.to_string()),
                    None => {
                        all_str = false;
                        break;
                    }
                }
            }
            if all_str {
                return Ok(out);
            }
        }
    }
    invalid_attr(
        attr,
        &format!(
            "'{}' is not a valid string array",
            user_attribute_value_to_string(value)
        ),
    )
}

// ── Text — cleartext (case-sensitive, no trim) ───────────────────────

fn text_equals(text: &str, comparison_value: &str, negate: bool) -> bool {
    (text == comparison_value) != negate
}

fn text_is_one_of(text: &str, list: &[String], negate: bool) -> bool {
    list.iter().any(|v| v == text) != negate
}

fn text_contains_any_of(text: &str, list: &[String], negate: bool) -> bool {
    for item in list {
        if text.contains(item.as_str()) {
            return !negate;
        }
    }
    negate
}

fn text_slice_equals_any_of(text: &str, list: &[String], starts_with: bool, negate: bool) -> bool {
    for item in list {
        if text.len() < item.len() {
            continue;
        }
        let result = if starts_with {
            text.starts_with(item.as_str())
        } else {
            text.ends_with(item.as_str())
        };
        if result {
            return !negate;
        }
    }
    negate
}

// ── Text — sensitive (SHA-256 salted) ────────────────────────────────

fn sensitive_text_equals(
    text: &str,
    comparison_value: &str,
    config_salt: &str,
    context_salt: &str,
    negate: bool,
) -> bool {
    let hash = hash_comparison_value(text, config_salt, context_salt);
    (hash == comparison_value) != negate
}

fn sensitive_text_is_one_of(
    text: &str,
    list: &[String],
    config_salt: &str,
    context_salt: &str,
    negate: bool,
) -> bool {
    let hash = hash_comparison_value(text, config_salt, context_salt);
    list.iter().any(|v| v == &hash) != negate
}

fn sensitive_text_slice_equals_any_of(
    text: &str,
    list: &[String],
    config_salt: &str,
    context_salt: &str,
    starts_with: bool,
    negate: bool,
) -> bool {
    let text_utf8 = text.as_bytes();
    for item in list {
        let Some(idx) = item.find('_') else {
            continue;
        };
        let Ok(slice_len) = item[..idx].parse::<usize>() else {
            continue;
        };
        if text_utf8.len() < slice_len {
            continue;
        }
        let slice = if starts_with {
            &text_utf8[..slice_len]
        } else {
            &text_utf8[text_utf8.len() - slice_len..]
        };
        let hash = hash_comparison_value_slice(slice, config_salt, context_salt);
        if hash == item[idx + 1..] {
            return !negate;
        }
    }
    negate
}

// ── Semver ───────────────────────────────────────────────────────────

fn semver_is_one_of(version: &SemVer, list: &[String], negate: bool) -> bool {
    // Each operand is trimmed first; an operand that is empty AFTER trimming
    // (incl. whitespace-only) is skipped — matching ConfigCat, which trims
    // before the empty check. A non-empty but unparseable operand makes the
    // whole comparator false (backward-compat).
    let mut result = false;
    for item in list {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let Some(version2) = parse_semver(item) else {
            return false;
        };
        if !result && version.compare(&version2) == Ordering::Equal {
            result = true;
        }
    }
    result != negate
}

fn semver_relation(version: &SemVer, comparator: u64, comparison_value: &str) -> bool {
    let Some(version2) = parse_semver(comparison_value.trim()) else {
        return false;
    };
    let cmp = version.compare(&version2);
    match comparator {
        SEMVER_LESS => cmp == Ordering::Less,
        SEMVER_LESS_OR_EQUALS => cmp != Ordering::Greater,
        SEMVER_GREATER => cmp == Ordering::Greater,
        SEMVER_GREATER_OR_EQUALS => cmp != Ordering::Less,
        _ => false,
    }
}

// ── Number ───────────────────────────────────────────────────────────

fn number_relation(num: f64, comparator: u64, comparison_value: f64) -> bool {
    match comparator {
        NUMBER_EQUALS => num == comparison_value,
        NUMBER_NOT_EQUALS => num != comparison_value,
        NUMBER_LESS => num < comparison_value,
        NUMBER_LESS_OR_EQUALS => num <= comparison_value,
        NUMBER_GREATER => num > comparison_value,
        NUMBER_GREATER_OR_EQUALS => num >= comparison_value,
        _ => false,
    }
}

// ── Datetime (Unix seconds) ──────────────────────────────────────────

fn datetime_relation(seconds: f64, comparison_value: f64, before: bool) -> bool {
    if before {
        seconds < comparison_value
    } else {
        seconds > comparison_value
    }
}

// ── Array (cleartext + sensitive) ────────────────────────────────────

fn array_contains_any_of(array: &[String], list: &[String], negate: bool) -> bool {
    for item in array {
        if list.iter().any(|v| v == item) {
            return !negate;
        }
    }
    negate
}

fn sensitive_array_contains_any_of(
    array: &[String],
    list: &[String],
    config_salt: &str,
    context_salt: &str,
    negate: bool,
) -> bool {
    for item in array {
        let hash = hash_comparison_value(item, config_salt, context_salt);
        if list.iter().any(|v| v == &hash) {
            return !negate;
        }
    }
    negate
}

/// A decoded user condition operand bundle (the `s`/`d`/`l` fields).
pub(crate) struct ConditionOperands<'a> {
    /// The comparator numeric tag (`c`).
    pub comparator: u64,
    /// String operand (`s`).
    pub string_value: &'a str,
    /// Number operand (`d`).
    pub double_value: f64,
    /// Whether the `d` slot was present in the config (vs. defaulted to
    /// `0.0`). Drives the #509 comparison-value validation for the number /
    /// datetime comparators.
    pub double_present: bool,
    /// List operand (`l`).
    pub list: &'a [String],
}

// ── Comparison value (config operand) → typed value (#509) ───────────
//
// configcat-common validates the CONFIG comparison value BEFORE the user
// attribute for the semver relations, number relations, and datetime
// comparators; a malformed operand surfaces a DISTINCT comparison-value
// error (no "please check the User.<attr>…" suffix), which wins even when
// the user attribute is ALSO malformed. Mirrors evaluator.ts
// `invalidComparisonValue` + comparators.ts `comparisonValueAs*`.

fn invalid_comparison_value(value: &str, reason: &str) -> String {
    format!("comparison value '{value}' is invalid ({reason})")
}

/// Render a numeric operand for the comparison-value error message,
/// mirroring TS's `String(value)`: an absent operand prints `undefined`,
/// else the canonical number string.
fn comparison_value_number_string(value: f64, present: bool) -> String {
    if !present {
        return "undefined".to_string();
    }
    number_to_canonical_string(value)
}

/// Validate a semver config operand (trimmed before parsing; the error
/// reports the UNTRIMMED operand).
fn comparison_value_as_semver(value: &str) -> Result<(), String> {
    if parse_semver(value.trim()).is_some() {
        return Ok(());
    }
    Err(invalid_comparison_value(
        value,
        &format!("'{value}' is not a valid semantic version"),
    ))
}

/// Validate a number config operand (absent / NaN → error).
fn comparison_value_as_number(value: f64, present: bool) -> Result<(), String> {
    if present && !value.is_nan() {
        return Ok(());
    }
    let s = comparison_value_number_string(value, present);
    Err(invalid_comparison_value(
        &s,
        &format!("'{s}' is not a valid decimal number"),
    ))
}

/// Validate a datetime config operand (absent / NaN → error).
fn comparison_value_as_unix_time_seconds(value: f64, present: bool) -> Result<(), String> {
    if present && !value.is_nan() {
        return Ok(());
    }
    let s = comparison_value_number_string(value, present);
    Err(invalid_comparison_value(
        &s,
        &format!(
            "'{s}' is not a valid Unix timestamp (number of seconds elapsed since Unix epoch)"
        ),
    ))
}

/// Dispatch one user condition to its comparator (port of
/// `evaluator.ts::evaluateUserCondition`'s switch). The caller has
/// already ensured the attribute is present and non-empty.
///
/// `config_salt` is `config.p.s`; `context_salt` is the setting key (user
/// conditions) or the segment name (segment conditions).
pub(crate) fn evaluate_user_condition(
    attr_name: &str,
    attr_value: &AttrValue,
    ops: &ConditionOperands,
    config_salt: &str,
    context_salt: &str,
) -> MatchOutcome {
    let sv = ops.string_value;
    let dv = ops.double_value;
    let list = ops.list;
    let cmp = ops.comparator;

    match cmp {
        TEXT_EQUALS | TEXT_NOT_EQUALS => MatchOutcome::from_bool(text_equals(
            &attribute_as_text(attr_value),
            sv,
            cmp == TEXT_NOT_EQUALS,
        )),
        SENSITIVE_TEXT_EQUALS | SENSITIVE_TEXT_NOT_EQUALS => {
            MatchOutcome::from_bool(sensitive_text_equals(
                &attribute_as_text(attr_value),
                sv,
                config_salt,
                context_salt,
                cmp == SENSITIVE_TEXT_NOT_EQUALS,
            ))
        }
        TEXT_IS_ONE_OF | TEXT_IS_NOT_ONE_OF => MatchOutcome::from_bool(text_is_one_of(
            &attribute_as_text(attr_value),
            list,
            cmp == TEXT_IS_NOT_ONE_OF,
        )),
        SENSITIVE_TEXT_IS_ONE_OF | SENSITIVE_TEXT_IS_NOT_ONE_OF => {
            MatchOutcome::from_bool(sensitive_text_is_one_of(
                &attribute_as_text(attr_value),
                list,
                config_salt,
                context_salt,
                cmp == SENSITIVE_TEXT_IS_NOT_ONE_OF,
            ))
        }
        TEXT_STARTS_WITH_ANY_OF | TEXT_NOT_STARTS_WITH_ANY_OF => {
            MatchOutcome::from_bool(text_slice_equals_any_of(
                &attribute_as_text(attr_value),
                list,
                true,
                cmp == TEXT_NOT_STARTS_WITH_ANY_OF,
            ))
        }
        SENSITIVE_TEXT_STARTS_WITH_ANY_OF | SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF => {
            MatchOutcome::from_bool(sensitive_text_slice_equals_any_of(
                &attribute_as_text(attr_value),
                list,
                config_salt,
                context_salt,
                true,
                cmp == SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF,
            ))
        }
        TEXT_ENDS_WITH_ANY_OF | TEXT_NOT_ENDS_WITH_ANY_OF => {
            MatchOutcome::from_bool(text_slice_equals_any_of(
                &attribute_as_text(attr_value),
                list,
                false,
                cmp == TEXT_NOT_ENDS_WITH_ANY_OF,
            ))
        }
        SENSITIVE_TEXT_ENDS_WITH_ANY_OF | SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF => {
            MatchOutcome::from_bool(sensitive_text_slice_equals_any_of(
                &attribute_as_text(attr_value),
                list,
                config_salt,
                context_salt,
                false,
                cmp == SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF,
            ))
        }
        TEXT_CONTAINS_ANY_OF | TEXT_NOT_CONTAINS_ANY_OF => {
            MatchOutcome::from_bool(text_contains_any_of(
                &attribute_as_text(attr_value),
                list,
                cmp == TEXT_NOT_CONTAINS_ANY_OF,
            ))
        }
        SEMVER_IS_ONE_OF | SEMVER_IS_NOT_ONE_OF => {
            match attribute_as_semver(attr_name, attr_value) {
                Ok(v) => {
                    MatchOutcome::from_bool(semver_is_one_of(&v, list, cmp == SEMVER_IS_NOT_ONE_OF))
                }
                Err(e) => MatchOutcome::ValidationError(e),
            }
        }
        SEMVER_LESS | SEMVER_LESS_OR_EQUALS | SEMVER_GREATER | SEMVER_GREATER_OR_EQUALS => {
            // #509: validate the CONFIG operand BEFORE the user attribute.
            if let Err(e) = comparison_value_as_semver(sv) {
                return MatchOutcome::ComparisonValueError(e);
            }
            match attribute_as_semver(attr_name, attr_value) {
                Ok(v) => MatchOutcome::from_bool(semver_relation(&v, cmp, sv)),
                Err(e) => MatchOutcome::ValidationError(e),
            }
        }
        NUMBER_EQUALS
        | NUMBER_NOT_EQUALS
        | NUMBER_LESS
        | NUMBER_LESS_OR_EQUALS
        | NUMBER_GREATER
        | NUMBER_GREATER_OR_EQUALS => {
            if let Err(e) = comparison_value_as_number(dv, ops.double_present) {
                return MatchOutcome::ComparisonValueError(e);
            }
            match attribute_as_number(attr_name, attr_value) {
                Ok(n) => MatchOutcome::from_bool(number_relation(n, cmp, dv)),
                Err(e) => MatchOutcome::ValidationError(e),
            }
        }
        DATETIME_BEFORE | DATETIME_AFTER => {
            if let Err(e) = comparison_value_as_unix_time_seconds(dv, ops.double_present) {
                return MatchOutcome::ComparisonValueError(e);
            }
            match attribute_as_unix_time_seconds(attr_name, attr_value) {
                Ok(s) => MatchOutcome::from_bool(datetime_relation(s, dv, cmp == DATETIME_BEFORE)),
                Err(e) => MatchOutcome::ValidationError(e),
            }
        }
        ARRAY_CONTAINS_ANY_OF | ARRAY_NOT_CONTAINS_ANY_OF => {
            match attribute_as_string_array(attr_name, attr_value) {
                Ok(a) => MatchOutcome::from_bool(array_contains_any_of(
                    &a,
                    list,
                    cmp == ARRAY_NOT_CONTAINS_ANY_OF,
                )),
                Err(e) => MatchOutcome::ValidationError(e),
            }
        }
        SENSITIVE_ARRAY_CONTAINS_ANY_OF | SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF => {
            match attribute_as_string_array(attr_name, attr_value) {
                Ok(a) => MatchOutcome::from_bool(sensitive_array_contains_any_of(
                    &a,
                    list,
                    config_salt,
                    context_salt,
                    cmp == SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
                )),
                Err(e) => MatchOutcome::ValidationError(e),
            }
        }
        _ => MatchOutcome::ValidationError(format!("unknown comparator {cmp}")),
    }
}

/// Compute the percentage bucket for a keying attribute string.
pub(crate) fn bucket_for(setting_key: &str, attr_value: &str) -> u64 {
    percentage_bucket(setting_key, attr_value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_number_strings_match_js() {
        assert_eq!(number_to_canonical_string(0.0), "0");
        assert_eq!(number_to_canonical_string(125.0), "125");
        assert_eq!(number_to_canonical_string(0.12345), "0.12345");
        assert_eq!(number_to_canonical_string(f64::NAN), "NaN");
        assert_eq!(number_to_canonical_string(f64::INFINITY), "Infinity");
        assert_eq!(number_to_canonical_string(f64::NEG_INFINITY), "-Infinity");
        // Exponential forms (JS Number.prototype.toString).
        assert_eq!(
            number_to_canonical_string(-1.23456789e96),
            "-1.23456789e+96"
        );
        assert_eq!(
            number_to_canonical_string(-12345.6789e-100),
            "-1.23456789e-96"
        );
        assert_eq!(number_to_canonical_string(1680307199.999), "1680307199.999");
        // small/large fixed boundaries
        assert_eq!(number_to_canonical_string(1e21), "1e+21");
        assert_eq!(number_to_canonical_string(1e-7), "1e-7");
        assert_eq!(number_to_canonical_string(0.0000001), "1e-7");
        assert_eq!(
            number_to_canonical_string(100000000000000000000.0),
            "100000000000000000000"
        );
    }

    #[test]
    fn array_to_json_compact() {
        assert_eq!(
            string_array_to_json(&["read".into(), "Write".into(), " eXecute ".into()]),
            r#"["read","Write"," eXecute "]"#
        );
        assert_eq!(string_array_to_json(&[]), "[]");
    }

    #[test]
    fn parse_float_strict_rejects_octalish_and_junk() {
        assert_eq!(parse_float_strict("12abc"), None);
        assert_eq!(parse_float_strict("0x10"), None);
        assert_eq!(parse_float_strict(""), None);
        assert_eq!(parse_float_strict("   "), None);
        assert_eq!(parse_float_strict("3.25"), Some(3.25));
        assert_eq!(parse_float_strict("0"), Some(0.0));
        assert_eq!(parse_float_strict("0.5"), Some(0.5));
    }

    #[test]
    fn number_attr_comma_normalized() {
        let v = AttrValue::Str("3,25".to_string());
        assert_eq!(attribute_as_number("Custom1", &v).unwrap(), 3.25);
    }
}
