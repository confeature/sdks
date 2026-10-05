// SPDX-License-Identifier: MIT

//! ConfigCat-compatible evaluation-log trace builder (ADR 0003 / epic
//! #494).
//!
//! Rust port of the spec-117 TS reference
//! (`packages/sdk-shared/src/eval-log.ts` `EvaluateLogBuilder`) and the Go
//! / Python ports (`apps/sdk-go/internal/evaluator/eval_log.go`,
//! `apps/sdk-python/src/confeature_client/eval_log.py`). Produces the
//! byte-identical indented textual trace ConfigCat's SDKs emit during flag
//! evaluation — its `evaluationlog/` corpus (replayed via
//! `packages/test-fixtures-sdk-parity/fixtures/parity-evaluationlog.json`)
//! is the byte-oracle. This builder is the analogue of the TS class
//! line-for-line so the federation ports stay consistent.
//!
//! The trace is emitted via the trace logger at INFO under event id 5000
//! (ConfigCat's verbosity contract) — see `evaluator::evaluate_traced`.

use crate::internal::comparators::{
    number_to_canonical_string, ARRAY_CONTAINS_ANY_OF, ARRAY_NOT_CONTAINS_ANY_OF, DATETIME_AFTER,
    DATETIME_BEFORE, NUMBER_EQUALS, NUMBER_GREATER, NUMBER_GREATER_OR_EQUALS, NUMBER_LESS,
    NUMBER_LESS_OR_EQUALS, NUMBER_NOT_EQUALS, SEMVER_GREATER, SEMVER_GREATER_OR_EQUALS,
    SEMVER_IS_NOT_ONE_OF, SEMVER_IS_ONE_OF, SEMVER_LESS, SEMVER_LESS_OR_EQUALS,
    SENSITIVE_ARRAY_CONTAINS_ANY_OF, SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF,
    SENSITIVE_TEXT_ENDS_WITH_ANY_OF, SENSITIVE_TEXT_EQUALS, SENSITIVE_TEXT_IS_NOT_ONE_OF,
    SENSITIVE_TEXT_IS_ONE_OF, SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF, SENSITIVE_TEXT_NOT_EQUALS,
    SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF, SENSITIVE_TEXT_STARTS_WITH_ANY_OF, TEXT_CONTAINS_ANY_OF,
    TEXT_ENDS_WITH_ANY_OF, TEXT_EQUALS, TEXT_IS_NOT_ONE_OF, TEXT_IS_ONE_OF,
    TEXT_NOT_CONTAINS_ANY_OF, TEXT_NOT_ENDS_WITH_ANY_OF, TEXT_NOT_EQUALS,
    TEXT_NOT_STARTS_WITH_ANY_OF, TEXT_STARTS_WITH_ANY_OF,
};
use serde_json::{Map, Value};

/// ConfigCat's event id for the "config evaluated" INFO log line. Captured
/// as `... [5000] ...`, matching the upstream oracle.
pub(crate) const EVAL_LOG_EVENT_ID: &str = "5000";

/// ConfigCat indents each nested eval-log line by two spaces per level.
const INDENT_UNIT: &str = "  ";

// Placeholders ConfigCat substitutes for malformed condition parts (parity
// with configcat-common's EvaluateLogBuilder).
const INVALID_VALUE_PLACEHOLDER: &str = "<invalid value>";
const INVALID_NAME_PLACEHOLDER: &str = "<invalid name>";
const INVALID_OPERATOR_PLACEHOLDER: &str = "<invalid operator>";

/// Max IS-ONE-OF / list items rendered before truncation (configcat parity).
const STRING_LIST_MAX_LENGTH: usize = 10;

// Prerequisite + segment comparators (mirror prerequisites.ts / segments.ts).
const PREREQUISITE_NOT_EQUALS: u64 = 1;
const SEGMENT_IS_NOT_IN: u64 = 1;

/// The condition-value kind: which slot a comparator reads.
#[derive(Clone, Copy)]
enum Kind {
    List,
    Str,
    Number,
    DateTime,
}

/// Per-comparator eval-log metadata (configcat-common parity): `token` is
/// the operator rendering, `kind` selects the condition value slot,
/// `sensitive` masks the value as `<hashed value>`. One table drives the
/// condition rendering, mirroring eval-log.ts COMPARATOR_META.
fn comparator_meta(comparator: u64) -> Option<(&'static str, Kind, bool)> {
    let entry = match comparator {
        TEXT_IS_ONE_OF => ("IS ONE OF", Kind::List, false),
        TEXT_IS_NOT_ONE_OF => ("IS NOT ONE OF", Kind::List, false),
        TEXT_CONTAINS_ANY_OF => ("CONTAINS ANY OF", Kind::List, false),
        TEXT_NOT_CONTAINS_ANY_OF => ("NOT CONTAINS ANY OF", Kind::List, false),
        SEMVER_IS_ONE_OF => ("IS ONE OF", Kind::List, false),
        SEMVER_IS_NOT_ONE_OF => ("IS NOT ONE OF", Kind::List, false),
        SEMVER_LESS => ("<", Kind::Str, false),
        SEMVER_LESS_OR_EQUALS => ("<=", Kind::Str, false),
        SEMVER_GREATER => (">", Kind::Str, false),
        SEMVER_GREATER_OR_EQUALS => (">=", Kind::Str, false),
        NUMBER_EQUALS => ("=", Kind::Number, false),
        NUMBER_NOT_EQUALS => ("!=", Kind::Number, false),
        NUMBER_LESS => ("<", Kind::Number, false),
        NUMBER_LESS_OR_EQUALS => ("<=", Kind::Number, false),
        NUMBER_GREATER => (">", Kind::Number, false),
        NUMBER_GREATER_OR_EQUALS => (">=", Kind::Number, false),
        SENSITIVE_TEXT_IS_ONE_OF => ("IS ONE OF", Kind::List, true),
        SENSITIVE_TEXT_IS_NOT_ONE_OF => ("IS NOT ONE OF", Kind::List, true),
        DATETIME_BEFORE => ("BEFORE", Kind::DateTime, false),
        DATETIME_AFTER => ("AFTER", Kind::DateTime, false),
        SENSITIVE_TEXT_EQUALS => ("EQUALS", Kind::Str, true),
        SENSITIVE_TEXT_NOT_EQUALS => ("NOT EQUALS", Kind::Str, true),
        SENSITIVE_TEXT_STARTS_WITH_ANY_OF => ("STARTS WITH ANY OF", Kind::List, true),
        SENSITIVE_TEXT_NOT_STARTS_WITH_ANY_OF => ("NOT STARTS WITH ANY OF", Kind::List, true),
        SENSITIVE_TEXT_ENDS_WITH_ANY_OF => ("ENDS WITH ANY OF", Kind::List, true),
        SENSITIVE_TEXT_NOT_ENDS_WITH_ANY_OF => ("NOT ENDS WITH ANY OF", Kind::List, true),
        SENSITIVE_ARRAY_CONTAINS_ANY_OF => ("ARRAY CONTAINS ANY OF", Kind::List, true),
        SENSITIVE_ARRAY_NOT_CONTAINS_ANY_OF => ("ARRAY NOT CONTAINS ANY OF", Kind::List, true),
        TEXT_EQUALS => ("EQUALS", Kind::Str, false),
        TEXT_NOT_EQUALS => ("NOT EQUALS", Kind::Str, false),
        TEXT_STARTS_WITH_ANY_OF => ("STARTS WITH ANY OF", Kind::List, false),
        TEXT_NOT_STARTS_WITH_ANY_OF => ("NOT STARTS WITH ANY OF", Kind::List, false),
        TEXT_ENDS_WITH_ANY_OF => ("ENDS WITH ANY OF", Kind::List, false),
        TEXT_NOT_ENDS_WITH_ANY_OF => ("NOT ENDS WITH ANY OF", Kind::List, false),
        ARRAY_CONTAINS_ANY_OF => ("ARRAY CONTAINS ANY OF", Kind::List, false),
        ARRAY_NOT_CONTAINS_ANY_OF => ("ARRAY NOT CONTAINS ANY OF", Kind::List, false),
        _ => return None,
    };
    Some(entry)
}

/// Render a `UserComparator` as ConfigCat's eval-log operator token, or
/// the invalid-operator placeholder for an unknown comparator.
fn format_user_comparator(comparator: u64) -> &'static str {
    comparator_meta(comparator)
        .map(|(token, _, _)| token)
        .unwrap_or(INVALID_OPERATOR_PLACEHOLDER)
}

/// Format a string list exactly as configcat-common's `formatStringList`
/// (Utils.ts): `'a', 'b'` joined by `", "`, with an optional truncation
/// appendix once `max_length` is exceeded.
fn format_string_list(items: &[String], max_length: usize) -> String {
    if items.is_empty() {
        return String::new();
    }
    let (shown, appendix) = if max_length > 0 && items.len() > max_length {
        let count = items.len() - max_length;
        let word = if count == 1 { "value" } else { "values" };
        (&items[..max_length], format!(", ... <{count} more {word}>"))
    } else {
        (items, String::new())
    };
    format!("'{}'{appendix}", shown.join("', '"))
}

/// Format a resolved SETTING value for the eval log (ConfigCat parity):
/// boolean → true/false (lowercase), string → verbatim, number → its
/// decimal string. Mirrors the `'<value>'` token in ConfigCat's
/// `Returning '<value>'.` footer (eval-log.ts `settingValueToString`).
pub(crate) fn setting_value_to_log_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::Bool(b)) => bool_to_log_string(*b),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) => number_to_canonical_string(f),
            None => String::new(),
        },
        _ => String::new(),
    }
}

/// Render a boolean as the lowercase `true`/`false` the oracle uses.
fn bool_to_log_string(value: bool) -> String {
    if value {
        "true".to_string()
    } else {
        "false".to_string()
    }
}

/// Render a Unix-seconds value as ConfigCat's eval-log datetime suffix —
/// JS `new Date(value*1000).toISOString()`, e.g.
/// `2023-04-01T00:00:00.000Z` (always millisecond precision, UTC). Returns
/// `None` for non-finite values (NaN / ±Inf), matching the JS
/// `isNaN(date)` guard.
fn unix_seconds_to_iso(seconds: f64) -> Option<String> {
    if !seconds.is_finite() {
        return None;
    }
    let ms = (seconds * 1000.0).round() as i64;
    // Decompose the epoch-millis into a UTC civil date/time without pulling
    // a date library (Howard Hinnant's civil-from-days algorithm).
    let (mut days, mut millis_of_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let total_seconds = millis_of_day / 1000;
    let millis = millis_of_day - total_seconds * 1000;
    millis_of_day = total_seconds;
    let hour = millis_of_day / 3600;
    let minute = (millis_of_day % 3600) / 60;
    let second = millis_of_day % 60;

    // civil_from_days (days since 1970-01-01).
    days += 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = days - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = if month <= 2 { year + 1 } else { year };

    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

/// Three-valued THEN consequence (MATCH / no match / error string),
/// mirroring TS's `boolean | string`.
pub(crate) enum MatchOrError {
    Match,
    NoMatch,
    Error(String),
}

/// Rust analogue of eval-log.ts `EvaluateLogBuilder`: indent/new_line/append
/// primitives + the condition-rendering helpers. `eol` defaults to `"\n"` —
/// the byte the upstream oracle uses.
pub(crate) struct EvaluateLogBuilder {
    chunks: String,
    indent_level: usize,
    eol: &'static str,
}

impl EvaluateLogBuilder {
    pub(crate) fn new() -> Self {
        Self {
            chunks: String::new(),
            indent_level: 0,
            eol: "\n",
        }
    }

    /// Append text to the current line.
    pub(crate) fn append(&mut self, text: &str) -> &mut Self {
        self.chunks.push_str(text);
        self
    }

    /// Break to a new line at the current indent, then append `text`.
    pub(crate) fn new_line(&mut self, text: &str) -> &mut Self {
        self.chunks.push_str(self.eol);
        for _ in 0..self.indent_level {
            self.chunks.push_str(INDENT_UNIT);
        }
        self.chunks.push_str(text);
        self
    }

    /// Break to a new line at the current indent without appending text
    /// (the TS `newLine()` with no argument).
    pub(crate) fn new_line_break(&mut self) -> &mut Self {
        self.new_line("")
    }

    pub(crate) fn increase_indent(&mut self) -> &mut Self {
        self.indent_level += 1;
        self
    }

    pub(crate) fn decrease_indent(&mut self) -> &mut Self {
        if self.indent_level > 0 {
            self.indent_level -= 1;
        }
        self
    }

    // ── condition formatting ─────────────────────────────────────────

    fn append_user_condition_core(
        &mut self,
        attr: &str,
        comparator: u64,
        value: &str,
    ) -> &mut Self {
        let value = if value.is_empty() {
            INVALID_VALUE_PLACEHOLDER
        } else {
            value
        };
        let token = format_user_comparator(comparator);
        self.append(&format!("User.{attr} {token} '{value}'"))
    }

    fn append_user_condition_string(
        &mut self,
        attr: &str,
        comparator: u64,
        value: Option<&str>,
        is_sensitive: bool,
    ) -> &mut Self {
        match value {
            None => self.append_user_condition_core(attr, comparator, ""),
            Some(_) if is_sensitive => {
                self.append_user_condition_core(attr, comparator, "<hashed value>")
            }
            Some(v) => self.append_user_condition_core(attr, comparator, v),
        }
    }

    fn append_user_condition_string_list(
        &mut self,
        attr: &str,
        comparator: u64,
        values: Option<&[String]>,
        is_sensitive: bool,
    ) -> &mut Self {
        let Some(values) = values else {
            return self.append_user_condition_core(attr, comparator, "");
        };
        let token = format_user_comparator(comparator);
        if is_sensitive {
            let word = if values.len() == 1 { "value" } else { "values" };
            return self.append(&format!(
                "User.{attr} {token} [<{} hashed {word}>]",
                values.len()
            ));
        }
        let list_text = format_string_list(values, STRING_LIST_MAX_LENGTH);
        self.append(&format!("User.{attr} {token} [{list_text}]"))
    }

    fn append_user_condition_number(
        &mut self,
        attr: &str,
        comparator: u64,
        value: Option<f64>,
        is_datetime: bool,
    ) -> &mut Self {
        let Some(value) = value else {
            return self.append_user_condition_core(attr, comparator, "");
        };
        let token = format_user_comparator(comparator);
        let value_text = number_to_canonical_string(value);
        if is_datetime {
            if let Some(iso) = unix_seconds_to_iso(value) {
                return self.append(&format!("User.{attr} {token} '{value_text}' ({iso} UTC)"));
            }
        }
        self.append(&format!("User.{attr} {token} '{value_text}'"))
    }

    /// Render one user condition (`User.<attr> <COMP> <value>`). The
    /// compact `IUserCondition` carries the value in `l` (list), `s`
    /// (string / sensitive-equals), or `d` (number / datetime), selected
    /// by the comparator kind.
    pub(crate) fn append_user_condition(&mut self, condition: &Map<String, Value>) -> &mut Self {
        let attr = condition
            .get("a")
            .and_then(Value::as_str)
            .unwrap_or(INVALID_NAME_PLACEHOLDER)
            .to_string();
        let c = condition.get("c").and_then(Value::as_u64);
        let Some(c) = c else {
            return self.append_user_condition_fallback(&attr, u64::MAX, condition);
        };
        let Some((_, kind, sensitive)) = comparator_meta(c) else {
            return self.append_user_condition_fallback(&attr, c, condition);
        };
        match kind {
            Kind::List => {
                let list = read_string_list(condition.get("l"));
                let has_list = condition.get("l").and_then(Value::as_array).is_some();
                self.append_user_condition_string_list(
                    &attr,
                    c,
                    has_list.then_some(list.as_slice()),
                    sensitive,
                )
            }
            Kind::Str => {
                let sv = condition.get("s").and_then(Value::as_str);
                self.append_user_condition_string(&attr, c, sv, sensitive)
            }
            Kind::Number => {
                let dv = condition.get("d").and_then(Value::as_f64);
                self.append_user_condition_number(&attr, c, dv, false)
            }
            Kind::DateTime => {
                let dv = condition.get("d").and_then(Value::as_f64);
                self.append_user_condition_number(&attr, c, dv, true)
            }
        }
    }

    /// Unknown comparator: fall back to the first present value slot
    /// (mirrors the Go/Python `appendUserCondition` default branch).
    fn append_user_condition_fallback(
        &mut self,
        attr: &str,
        c: u64,
        condition: &Map<String, Value>,
    ) -> &mut Self {
        if let Some(sv) = condition.get("s").and_then(Value::as_str) {
            return self.append_user_condition_core(attr, c, sv);
        }
        if let Some(dv) = condition.get("d").and_then(Value::as_f64) {
            return self.append_user_condition_core(attr, c, &number_to_canonical_string(dv));
        }
        let list = read_string_list(condition.get("l"));
        if let Some(first) = list.first() {
            return self.append_user_condition_core(attr, c, first);
        }
        self.append_user_condition_core(attr, c, "")
    }

    /// Append a single condition's boolean result (` => true` / ` =>
    /// false, skipping…`).
    pub(crate) fn append_condition_consequence(&mut self, result: bool) -> &mut Self {
        self.append(&format!(" => {}", bool_to_log_string(result)));
        if result {
            self
        } else {
            self.append(", skipping the remaining AND conditions")
        }
    }

    /// Append a targeting rule's THEN consequence. `then_value` is the
    /// rule's formatted served value (e.g. `Dog`) for a fixed-value rule,
    /// or `None` for a rule serving `% options`.
    pub(crate) fn append_targeting_rule_consequence(
        &mut self,
        then_value: Option<&str>,
        match_kind: &MatchOrError,
        new_line: bool,
    ) -> &mut Self {
        self.increase_indent();
        if new_line {
            self.new_line_break();
        } else {
            self.append(" ");
        }
        self.append("THEN");
        match then_value {
            Some(v) => {
                self.append(&format!(" '{v}'"));
            }
            None => {
                self.append(" % options");
            }
        }
        self.append(" => ");
        match match_kind {
            MatchOrError::Match => {
                self.append("MATCH, applying rule");
            }
            MatchOrError::NoMatch => {
                self.append("no match");
            }
            MatchOrError::Error(text) => {
                self.append(text);
            }
        }
        self.decrease_indent()
    }

    /// Append a prerequisite-flag condition (`Flag 'X' EQUALS 'Y'`).
    pub(crate) fn append_prerequisite_flag_condition(
        &mut self,
        prereq_key: &str,
        comparator: u64,
        comparison_value: &str,
    ) -> &mut Self {
        let op = if comparator == PREREQUISITE_NOT_EQUALS {
            "NOT EQUALS"
        } else {
            "EQUALS"
        };
        self.append(&format!("Flag '{prereq_key}' {op} '{comparison_value}'"))
    }

    /// Append a segment condition (`User IS [NOT] IN SEGMENT 'X'`).
    pub(crate) fn append_segment_condition(
        &mut self,
        segment_name: &str,
        comparator: u64,
    ) -> &mut Self {
        let op = if comparator == SEGMENT_IS_NOT_IN {
            "IS NOT IN SEGMENT"
        } else {
            "IS IN SEGMENT"
        };
        self.append(&format!("User {op} '{segment_name}'"))
    }

    /// Append a bare boolean condition result (`true` / `false`).
    pub(crate) fn append_condition_result(&mut self, result: bool) -> &mut Self {
        self.append(&bool_to_log_string(result))
    }

    /// The accumulated multi-line trace.
    pub(crate) fn build(&self) -> String {
        self.chunks.clone()
    }
}

/// Read a `l` operand into a `Vec<String>` (non-strings skipped).
fn read_string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_renders_millis_utc() {
        assert_eq!(
            unix_seconds_to_iso(1680307200.0).as_deref(),
            Some("2023-04-01T00:00:00.000Z")
        );
        assert_eq!(unix_seconds_to_iso(f64::NAN), None);
        assert_eq!(unix_seconds_to_iso(f64::INFINITY), None);
    }

    #[test]
    fn string_list_truncates_after_ten() {
        let items: Vec<String> = (1..=11).map(|n| n.to_string()).collect();
        assert_eq!(
            format_string_list(&items, STRING_LIST_MAX_LENGTH),
            "'1', '2', '3', '4', '5', '6', '7', '8', '9', '10', ... <1 more value>"
        );
    }

    #[test]
    fn indent_unit_two_spaces() {
        let mut b = EvaluateLogBuilder::new();
        b.append("a").increase_indent().new_line("b");
        assert_eq!(b.build(), "a\n  b");
    }
}
