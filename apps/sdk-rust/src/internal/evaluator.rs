// SPDX-License-Identifier: MIT

//! ConfigCat-parity flag evaluator. Pure function over a parsed
//! `config_v6.json` body.
//!
//! Port of `packages/sdk-shared/src/evaluator.ts` (spec 125 — the full
//! decision engine: targeting rules, the 36 comparators, segments,
//! prerequisite flags with cycle detection, and percentage rollout).
//! Fail-closed semantics: any reason a value can't be cleanly resolved
//! returns the supplied default + an error code. **NEVER panics** — every
//! failure path, including a circular prerequisite chain, returns the
//! supplied default (a detected cycle becomes a fail-closed error, never a
//! panic / stack overflow).
//!
//! Supported `SettingType` discriminators (matching
//! `packages/sdk-shared/src/config-json.ts`):
//!
//! - `t = 0` boolean → reads `v.b`, expects a `bool` default.
//! - `t = 1` string  → reads `v.s`, expects a `String` default.
//! - `t = 2` int     → reads `v.i`, expects an `i64` default.
//! - `t = 3` double  → reads `v.d`, expects an `f64` default.
//!
//! Tier-0 error codes (preserved, SC-006):
//! - key present + setting type matches default type → resolved value.
//! - key absent                            → default with `KEY_NOT_FOUND`.
//! - setting type unknown (not 0/1/2/3)    → default with `UNSUPPORTED_TYPE`.
//! - default type ≠ setting type           → default with `TYPE_MISMATCH`.
//! - setting `v` missing/malformed         → default with `MALFORMED_VALUE`.
//! - boolean slot `v.b` missing/non-bool   → default with `VALUE_NOT_BOOL`.
//! - config is `None`                      → default with `NO_CONFIG`.
//! - malformed config                      → default with `MALFORMED_CONFIG`.
//! - circular prereq / fatal config state  → default with `EVAL_ERROR`.
//!
//! Eval-log trace (ADR 0003 / epic #494): when an INFO-enabled
//! [`TraceLogger`] is attached via [`evaluate_traced_with_attrs`], the
//! evaluator drives the ConfigCat byte-identical evaluation-log trace — the
//! WARN 3001/3003/3004 + ERROR 1002 lines emitted during the walk, and the
//! final INFO 5000 multi-line indented trace. A `None` logger (the hot
//! path) is zero-cost: every trace append is guarded so non-trace
//! evaluation pays nothing.

use crate::internal::comparators::{
    bucket_for, evaluate_user_condition, user_attribute_value_to_string, AttrValue,
    ConditionOperands, MatchOutcome,
};
use crate::internal::eval_log::{
    setting_value_to_log_string, EvaluateLogBuilder, MatchOrError, EVAL_LOG_EVENT_ID,
};
use crate::internal::eval_logger::{TraceLog, TraceLogLevel, TraceLogger};
use crate::user::{User, UserValue};
use serde_json::{Map, Value};
use std::collections::HashMap;

const SETTING_TYPE_BOOL: u64 = 0;
const SETTING_TYPE_STRING: u64 = 1;
const SETTING_TYPE_INT: u64 = 2;
const SETTING_TYPE_DOUBLE: u64 = 3;

const SEGMENT_IS_NOT_IN: u64 = 1;

const PREREQ_EQUALS: u64 = 0;
const PREREQ_NOT_EQUALS: u64 = 1;

const MISSING_USER_OBJECT_ERROR: &str = "cannot evaluate, User Object is missing";

/// Result envelope. Customers don't see this — the client consumes
/// `error` to decide whether to log a warning and return the default.
#[derive(Debug, Clone, PartialEq)]
pub struct EvalResult {
    pub value: Value,
    pub error: &'static str,
    pub variation_id: String,
    /// `true` when a targeting rule decided the value (FR-011).
    pub matched_targeting_rule: bool,
    /// `true` when a percentage option decided the value (FR-011).
    pub matched_percentage_option: bool,
}

/// Three-valued condition outcome (data-model §3). `Error` short-circuits
/// the AND group like `NoMatch` but is surfaced; `Fatal` (cycle /
/// malformed reference) propagates to the fail-closed boundary.
enum CondOutcome {
    Match,
    NoMatch,
    /// A surfaced validation error (missing user / attr / bad type). The
    /// `String` is the reason text rendered on the THEN line.
    Error(String),
    /// A fatal config error → fail-closed default + `EVAL_ERROR`. The
    /// `Option<String>` carries the prerequisite cycle chain when the fatal
    /// is a detected circular dependency (drives ERROR 1002).
    Fatal(Option<String>),
}

/// Outcome of resolving a setting to a value envelope.
enum SettingOutcome {
    Resolved(ResolvedValue),
    /// No rule / option decided — the caller falls through.
    NoMatch,
    /// A fatal config error (cycle, malformed reference) → fail-closed. The
    /// `Option<String>` is the cycle chain when the fatal is a circular
    /// dependency.
    Fatal(Option<String>),
}

/// A resolved value envelope plus its identity.
struct ResolvedValue {
    /// The `v` envelope object (`{b|s|i|d}`).
    value: Value,
    variation_id: String,
    matched_rule: bool,
    matched_option: bool,
}

/// Per-evaluation mutable state shared across the recursion.
///
/// `log` + `log_builder` are the eval-log trace seam (ADR 0003), present
/// only when an INFO-enabled [`TraceLogger`] is attached. Every trace
/// append is guarded by `if state.log_builder.is_some()`, so the no-trace
/// hot path pays nothing. `log_builder` is shared across the recursion (a
/// prerequisite re-evaluates nested in `( … )` on the SAME builder).
///
/// `missing_user_object_logged` dedups the no-user WARN 3001 to once per
/// context (common-js parity); a prerequisite flag evaluates in its OWN
/// context (a fresh `EvalState`), so a prereq referenced by N rules logs
/// the WARN N times, but a single rule with multiple no-user conditions
/// logs it once.
struct EvalState<'a> {
    /// First surfaced condition error (informational, FR-016).
    error_message: Option<String>,
    /// Cycle-detection stack for prerequisite flags.
    visited_flags: Vec<String>,
    /// Dedups WARN 3001 once per context.
    missing_user_object_logged: bool,
    /// The structured trace logger (no-op when tracing is off).
    log: TraceLog<'a>,
    /// The lazily-built multi-line trace (`None` when tracing is off).
    log_builder: Option<EvaluateLogBuilder>,
}

impl EvalState<'_> {
    /// Run a closure against the trace builder if tracing is active.
    fn with_builder(&mut self, f: impl FnOnce(&mut EvaluateLogBuilder)) {
        if let Some(b) = self.log_builder.as_mut() {
            f(b);
        }
    }

    fn tracing(&self) -> bool {
        self.log_builder.is_some()
    }
}

/// Immutable per-evaluation context.
struct EvalContext<'a> {
    settings: &'a Map<String, Value>,
    segments: &'a [Value],
    config_salt: &'a str,
    /// Typed user attributes, or `None` for no user.
    user_attrs: Option<&'a HashMap<String, AttrValue>>,
    /// The eval-log header `for User '…'` token, pre-rendered once (empty
    /// when there is no user). Mirrors the Go/Python
    /// `userAttributesForLogJSON`.
    user_header: String,
}

/// Evaluates `key` against `config`, threading the optional `user`.
/// NEVER panics — every failure path returns the supplied `default`.
pub fn evaluate(
    config: Option<&Value>,
    key: &str,
    default: &Value,
    user: Option<&User>,
) -> EvalResult {
    let attrs = user.map(user_to_attrs);
    evaluate_with_attrs(config, key, default, attrs.as_ref())
}

/// Build the typed-attribute map from a public [`User`]. The predefined
/// attributes (`Identifier` / `Email` / `Country`) are always strings;
/// each custom attribute carries its declared [`UserValue`] type so the
/// evaluator can convert non-string values to ConfigCat's canonical
/// string (number → invariant decimal, date → epoch seconds, array →
/// JSON) exactly as the upstream SDK does.
fn user_to_attrs(user: &User) -> HashMap<String, AttrValue> {
    let mut m = HashMap::new();
    m.insert(
        "Identifier".to_string(),
        AttrValue::Str(user.identifier.clone()),
    );
    if let Some(email) = &user.email {
        m.insert("Email".to_string(), AttrValue::Str(email.clone()));
    }
    if let Some(country) = &user.country {
        m.insert("Country".to_string(), AttrValue::Str(country.clone()));
    }
    for (k, v) in &user.custom {
        m.insert(k.clone(), user_value_to_attr(v));
    }
    m
}

/// Map a public [`UserValue`] onto the internal [`AttrValue`] the
/// evaluator consumes. A 1:1 type-preserving bridge — the conversion to
/// ConfigCat's canonical string happens later, inside the comparators,
/// only when a text comparator needs it.
fn user_value_to_attr(v: &UserValue) -> AttrValue {
    match v {
        UserValue::String(s) => AttrValue::Str(s.clone()),
        UserValue::Int(i) => AttrValue::Num(*i as f64),
        UserValue::UInt(u) => AttrValue::Num(*u as f64),
        UserValue::Float(f) => AttrValue::Num(*f),
        UserValue::DateTime(secs) => AttrValue::DateSeconds(*secs),
        UserValue::StringVec(a) => AttrValue::StrArray(a.clone()),
    }
}

/// Core entry point taking typed attributes directly (used by the public
/// `evaluate` and by the conversion corpus test, which feeds numbers /
/// arrays / dates un-stringified).
pub fn evaluate_with_attrs(
    config: Option<&Value>,
    key: &str,
    default: &Value,
    user_attrs: Option<&HashMap<String, AttrValue>>,
) -> EvalResult {
    evaluate_traced_with_attrs(config, key, default, user_attrs, None)
}

/// [`evaluate_with_attrs`] with an optional [`TraceLogger`]. When the
/// logger is INFO-enabled it drives the ConfigCat byte-identical
/// evaluation-log trace (ADR 0003 / epic #494). A `None` logger (the hot
/// path) is zero-cost — identical behaviour to [`evaluate_with_attrs`].
///
/// The trace header is rendered from `user_attrs` directly, with custom
/// keys emitted in sorted order — the corpus scenarios carry at most one
/// custom key so any total order is byte-identical to the oracle.
pub fn evaluate_traced_with_attrs(
    config: Option<&Value>,
    key: &str,
    default: &Value,
    user_attrs: Option<&HashMap<String, AttrValue>>,
    logger: Option<&mut dyn TraceLogger>,
) -> EvalResult {
    let Some(cfg) = config else {
        return fail(default, "NO_CONFIG");
    };

    let log = TraceLog::new(logger);

    let Some(settings) = cfg.get("f").and_then(Value::as_object) else {
        return fail(default, "MALFORMED_CONFIG");
    };
    let Some(setting) = settings.get(key) else {
        return fail(default, "KEY_NOT_FOUND");
    };
    let Some(setting_obj) = setting.as_object() else {
        return fail(default, "MALFORMED_CONFIG");
    };
    let Some(t) = setting_obj.get("t").and_then(read_u64) else {
        return fail(default, "MALFORMED_CONFIG");
    };

    // Type guards against the DEFAULT (preserved tier-0 contract, SC-006).
    //
    // DELIBERATE Principle-II contract (spec 152 / #475): Rust is a strongly
    // typed SDK and distinguishes int (t=2) from double (t=3) — exactly as
    // ConfigCat's typed SDKs (Rust/Go/Swift/.NET) do. An int default against
    // a DOUBLE setting (or vice-versa) is a TYPE_MISMATCH and serves the
    // default. JSON erases the int-vs-float distinction on a whole number, so
    // a typed default MUST be supplied by the caller at the right kind: an f64
    // for a DOUBLE flag, an i64 for an INT flag. The parity/eval-log runners
    // pick the matching typed default by reading the setting's `t` (the same
    // approach python/go/swift use in their runners). Relaxing this guard to
    // `is_number()` would weaken the type contract and is forbidden.
    let type_error: Option<&'static str> = match t {
        SETTING_TYPE_BOOL => (!default.is_boolean()).then_some("TYPE_MISMATCH"),
        SETTING_TYPE_STRING => (!default.is_string()).then_some("TYPE_MISMATCH"),
        SETTING_TYPE_INT => (!default.is_i64()).then_some("TYPE_MISMATCH"),
        SETTING_TYPE_DOUBLE => (!default.is_f64()).then_some("TYPE_MISMATCH"),
        _ => Some("UNSUPPORTED_TYPE"),
    };
    if let Some(code) = type_error {
        return fail(default, code);
    }

    let config_salt = cfg
        .get("p")
        .and_then(|p| p.get("s"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let empty_segments: Vec<Value> = Vec::new();
    let segments = cfg
        .get("s")
        .and_then(Value::as_array)
        .unwrap_or(&empty_segments);

    let user_header = user_attrs
        .map(user_attributes_for_log_json)
        .unwrap_or_default();

    let ctx = EvalContext {
        settings,
        segments,
        config_salt,
        user_attrs,
        user_header,
    };

    // Evaluation-log trace (ADR 0003). Built lazily — only when the logger
    // would emit at INFO. The header is appended here; the
    // `Returning '<value>'.` footer below; the whole multi-line trace is
    // surfaced under event id 5000.
    let mut log_builder = None;
    if log.enabled(TraceLogLevel::Info) {
        let mut b = EvaluateLogBuilder::new();
        b.append(&format!("Evaluating '{key}'"));
        if ctx.user_attrs.is_some() {
            b.append(&format!(" for User '{}'", ctx.user_header));
        }
        log_builder = Some(b);
    }

    let mut state = EvalState {
        error_message: None,
        visited_flags: Vec::new(),
        missing_user_object_logged: false,
        log,
        log_builder,
    };

    let resolved = match evaluate_setting(key, setting_obj, &ctx, &mut state) {
        SettingOutcome::Resolved(r) => r,
        SettingOutcome::NoMatch => served_fallback(setting_obj),
        SettingOutcome::Fatal(cycle) => {
            if let Some(cycle) = cycle {
                state.log.circular_dependency(key, &cycle);
            }
            return fail(default, "EVAL_ERROR");
        }
    };

    let typed = finalize(t, &resolved, default);

    // Footer + emit. The INFO 5000 trace is emitted only when the resolved
    // value is clean (no error); a type/value error fails closed without a
    // footer (matching evaluator.ts, which emits the trace after the value
    // guard).
    if typed.error.is_empty() {
        let footer = format!(
            "Returning '{}'.",
            setting_value_to_log_string(Some(&typed.value))
        );
        let trace = state.log_builder.as_mut().map(|b| {
            b.new_line(&footer);
            b.build()
        });
        if let Some(trace) = trace {
            state.log.info(EVAL_LOG_EVENT_ID, &trace);
        }
    }

    typed
}

/// Render the user's attributes as the eval-log header shows them — a
/// Confeature-canonical object `{Identifier, Email?, Country?, …custom}`
/// JSON-serialized to the `for User '…'` token (ADR 0003 addendum). This
/// is the configcat-js form. Insertion order is fixed (Identifier, Email,
/// Country, then custom keys in sorted order — the corpus carries at most
/// one custom key, so any total order is byte-identical to the oracle) and
/// the serialization is compact (no spaces) with JS-JSON string escaping.
fn user_attributes_for_log_json(attrs: &HashMap<String, AttrValue>) -> String {
    let mut parts: Vec<String> = Vec::new();
    let identifier = attrs
        .get("Identifier")
        .map(user_attribute_value_to_string)
        .unwrap_or_default();
    parts.push(format!("\"Identifier\":{}", js_json_string(&identifier)));
    if let Some(email) = attrs.get("Email") {
        parts.push(format!(
            "\"Email\":{}",
            js_json_string(&user_attribute_value_to_string(email))
        ));
    }
    if let Some(country) = attrs.get("Country") {
        parts.push(format!(
            "\"Country\":{}",
            js_json_string(&user_attribute_value_to_string(country))
        ));
    }
    let mut custom_keys: Vec<&String> = attrs
        .keys()
        .filter(|k| !matches!(k.as_str(), "Identifier" | "Email" | "Country"))
        .collect();
    custom_keys.sort();
    for name in custom_keys {
        let value = user_attribute_value_to_string(&attrs[name]);
        parts.push(format!(
            "{}:{}",
            js_json_string(name),
            js_json_string(&value)
        ));
    }
    format!("{{{}}}", parts.join(","))
}

/// Serialize a string exactly as ECMAScript `JSON.stringify` of a string:
/// wrapped in double quotes, with `"`, `\`, and the C0 control characters
/// escaped, all other code points (incl. `/` and non-ASCII) verbatim.
fn js_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Resolve a setting to its value envelope (port of `evaluateSetting`):
/// targeting rules first (first-match-wins), then setting-level
/// percentage options, then the served `v`.
fn evaluate_setting(
    key: &str,
    setting: &Map<String, Value>,
    ctx: &EvalContext,
    state: &mut EvalState,
) -> SettingOutcome {
    // 1. Targeting rules — first-match-wins.
    if let Some(rules) = setting.get("r").and_then(Value::as_array) {
        if !rules.is_empty() {
            if let Some(outcome) = evaluate_targeting_rules(key, setting, rules, ctx, state) {
                return outcome;
            }
        }
    }

    // 2. Setting-level percentage options.
    if let Some(options) = setting.get("p").and_then(Value::as_array) {
        if !options.is_empty() {
            match evaluate_percentage_options(
                key,
                setting,
                Some(options),
                setting.get("a").and_then(Value::as_str),
                false,
                ctx,
                state,
            ) {
                SettingOutcome::Resolved(r) => return SettingOutcome::Resolved(r),
                SettingOutcome::Fatal(c) => return SettingOutcome::Fatal(c),
                SettingOutcome::NoMatch => {}
            }
        }
    }

    // 3. Served fallback `setting.v`.
    SettingOutcome::Resolved(served_fallback(setting))
}

/// Walk rules in document order; return the first whose conditions all
/// match (`Some(Resolved)`), or `Some(Fatal)` on a fatal error, or `None`
/// when no rule decides (fall through to % options / served value).
fn evaluate_targeting_rules(
    key: &str,
    setting: &Map<String, Value>,
    rules: &[Value],
    ctx: &EvalContext,
    state: &mut EvalState,
) -> Option<SettingOutcome> {
    state.with_builder(|b| {
        b.new_line("Evaluating targeting rules and applying the first match if any:");
    });
    for rule in rules {
        let Some(rule_obj) = rule.as_object() else {
            continue;
        };
        let conditions = rule_obj.get("c").and_then(Value::as_array);
        let outcome =
            evaluate_conditions(key, setting, conditions, key, ctx, state, Some(rule_obj));
        match outcome {
            CondOutcome::Match => {}
            CondOutcome::NoMatch => continue,
            CondOutcome::Error(msg) => {
                state.error_message.get_or_insert(msg);
                // A rule whose conditions ERRORED is ignored; evaluation
                // continues — ConfigCat emits this trace line.
                state.with_builder(|b| {
                    b.increase_indent()
                        .new_line(
                            "The current targeting rule is ignored and the evaluation continues \
                             with the next rule.",
                        )
                        .decrease_indent();
                });
                continue;
            }
            CondOutcome::Fatal(c) => return Some(SettingOutcome::Fatal(c)),
        }

        // A matched rule serves a fixed value (`s`) or % options (`p`).
        if let Some(served) = rule_obj.get("s") {
            let (value, vid) = served_value(served);
            return Some(SettingOutcome::Resolved(ResolvedValue {
                value,
                variation_id: vid,
                matched_rule: true,
                matched_option: false,
            }));
        }
        let attr_name = rule_obj
            .get("a")
            .and_then(Value::as_str)
            .or_else(|| setting.get("a").and_then(Value::as_str));
        state.with_builder(|b| {
            b.increase_indent();
        });
        let opt = evaluate_percentage_options(
            key,
            setting,
            rule_obj.get("p").and_then(Value::as_array),
            attr_name,
            true,
            ctx,
            state,
        );
        match opt {
            SettingOutcome::Resolved(r) => {
                state.with_builder(|b| {
                    b.decrease_indent();
                });
                return Some(SettingOutcome::Resolved(r));
            }
            SettingOutcome::Fatal(c) => return Some(SettingOutcome::Fatal(c)),
            SettingOutcome::NoMatch => {
                state.with_builder(|b| {
                    b.new_line(
                        "The current targeting rule is ignored and the evaluation continues \
                         with the next rule.",
                    )
                    .decrease_indent();
                });
                // % options weren't resolvable (no user / missing attr) →
                // ignore the rule and continue with the next.
            }
        }
    }
    None
}

/// Evaluate a rule's (or segment's) AND-grouped condition list, short-
/// circuiting on the first non-match / error / fatal. When `rule` is
/// `Some` and tracing is on, the rule's THEN consequence is appended after
/// the AND group, mirroring `evaluator.ts::evaluateConditions`.
#[allow(clippy::too_many_arguments)]
fn evaluate_conditions(
    setting_key: &str,
    setting: &Map<String, Value>,
    conditions: Option<&Vec<Value>>,
    context_salt: &str,
    ctx: &EvalContext,
    state: &mut EvalState,
    rule: Option<&Map<String, Value>>,
) -> CondOutcome {
    state.with_builder(|b| {
        b.new_line("- ");
    });
    let mut result = CondOutcome::Match;
    let conditions = conditions.map(Vec::as_slice).unwrap_or(&[]);
    for (i, condition) in conditions.iter().enumerate() {
        state.with_builder(|b| {
            if i == 0 {
                b.append("IF ").increase_indent();
            } else {
                b.increase_indent().new_line("AND ");
            }
        });
        let Some(cond_obj) = condition.as_object() else {
            result = CondOutcome::Error("empty condition".to_string());
            state.with_builder(|b| {
                b.append_condition_consequence(false);
                b.decrease_indent();
            });
            break;
        };
        result = if let Some(uc) = cond_obj.get("u").and_then(Value::as_object) {
            evaluate_one_user_condition(setting_key, uc, context_salt, ctx, state)
        } else if let Some(pc) = cond_obj.get("p").and_then(Value::as_object) {
            evaluate_prerequisite_condition(setting_key, pc, ctx, state)
        } else if let Some(sc) = cond_obj.get("s").and_then(Value::as_object) {
            evaluate_segment_condition(setting_key, sc, ctx, state)
        } else {
            CondOutcome::Error("empty condition".to_string())
        };
        let clean_match = matches!(result, CondOutcome::Match);
        state.with_builder(|b| {
            b.append_condition_consequence(clean_match);
            b.decrease_indent();
        });
        if !clean_match {
            break;
        }
    }

    // Append the rule's THEN consequence (rule-owned condition list only).
    if let Some(rule) = rule {
        if !matches!(result, CondOutcome::Fatal(_)) && state.tracing() {
            let (then_value, has_then) = rule_then_value(setting, rule);
            let match_kind = match &result {
                CondOutcome::Match => MatchOrError::Match,
                CondOutcome::Error(msg) => MatchOrError::Error(msg.clone()),
                _ => MatchOrError::NoMatch,
            };
            let then_value_ref = has_then.then_some(then_value.as_str());
            let new_line = !conditions.is_empty();
            state.with_builder(|b| {
                b.append_targeting_rule_consequence(then_value_ref, &match_kind, new_line);
            });
        }
    }

    result
}

/// A rule's formatted served value (e.g. `Dog`) for a fixed-value rule, or
/// `("", false)` for a rule serving `% options`.
fn rule_then_value(setting: &Map<String, Value>, rule: &Map<String, Value>) -> (String, bool) {
    let Some(served) = rule.get("s").and_then(Value::as_object) else {
        return (String::new(), false);
    };
    let Some(t) = setting.get("t").and_then(read_u64) else {
        return (String::new(), false);
    };
    let value = served
        .get("v")
        .and_then(|env| select_typed_from_value(env, t));
    (setting_value_to_log_string(value.as_ref()), true)
}

/// Convert a comparator [`MatchOutcome`] into a [`CondOutcome`].
fn from_match(outcome: MatchOutcome) -> CondOutcome {
    match outcome {
        MatchOutcome::Match => CondOutcome::Match,
        MatchOutcome::NoMatch => CondOutcome::NoMatch,
        MatchOutcome::ValidationError(e) => CondOutcome::Error(e),
        MatchOutcome::ComparisonValueError(e) => CondOutcome::Error(e),
    }
}

/// Dispatch one user condition (port of `evaluateUserCondition`).
fn evaluate_one_user_condition(
    setting_key: &str,
    uc: &Map<String, Value>,
    context_salt: &str,
    ctx: &EvalContext,
    state: &mut EvalState,
) -> CondOutcome {
    state.with_builder(|b| {
        b.append_user_condition(uc);
    });

    let Some(attrs) = ctx.user_attrs else {
        surface_missing_user(setting_key, state);
        return CondOutcome::Error(MISSING_USER_OBJECT_ERROR.to_string());
    };
    let attr_name = uc.get("a").and_then(Value::as_str).unwrap_or("");
    let attr_value = attrs.get(attr_name);
    let missing = match attr_value {
        None => true,
        Some(v) => v.is_empty_string(),
    };
    if missing {
        let msg = missing_user_attribute_error(attr_name);
        state.error_message.get_or_insert(msg.clone());
        // WARN 3003 per targeting rule whose attribute is missing.
        state
            .log
            .user_object_attribute_is_missing(setting_key, attr_name);
        return CondOutcome::Error(msg);
    }
    let attr_value = match attr_value {
        Some(v) => v,
        None => return CondOutcome::Error(missing_user_attribute_error(attr_name)),
    };

    let comparator = uc.get("c").and_then(read_u64).unwrap_or(u64::MAX);
    let string_value = uc.get("s").and_then(Value::as_str).unwrap_or("");
    let double_value = uc.get("d").and_then(Value::as_f64).unwrap_or(0.0);
    let double_present = uc.get("d").and_then(Value::as_f64).is_some();
    let list = read_string_list(uc.get("l"));
    let ops = ConditionOperands {
        comparator,
        string_value,
        double_value,
        double_present,
        list: &list,
    };
    let outcome =
        evaluate_user_condition(attr_name, attr_value, &ops, ctx.config_salt, context_salt);
    // Surface + log the typed validation / malformed-operand outcomes the
    // trace replays (FR-016): attribute-invalid → WARN 3004 (with suffix);
    // a malformed config operand (#509) → WARN 3004 (no suffix).
    match &outcome {
        MatchOutcome::ValidationError(msg) => {
            state.error_message.get_or_insert(msg.clone());
            if let Some((attr, reason)) = parse_invalid_attribute(msg) {
                state
                    .log
                    .user_object_attribute_is_invalid(setting_key, attr, reason);
            }
        }
        MatchOutcome::ComparisonValueError(msg) => {
            state.error_message.get_or_insert(msg.clone());
            state.log.comparison_value_is_invalid(setting_key, msg);
        }
        _ => {}
    }
    from_match(outcome)
}

/// Parse `cannot evaluate, the User.<attr> attribute is invalid (<reason>)`
/// into `(attr, reason)`. Mirrors the Python `_INVALID_ATTR_RE` split.
fn parse_invalid_attribute(msg: &str) -> Option<(&str, &str)> {
    let prefix = "cannot evaluate, the User.";
    let rest = msg.strip_prefix(prefix)?;
    let suffix_idx = rest.find(" attribute is invalid (")?;
    let attr = &rest[..suffix_idx];
    let after = &rest[suffix_idx + " attribute is invalid (".len()..];
    let reason = after.strip_suffix(')')?;
    Some((attr, reason))
}

/// Resolve a segment condition (port of `segments.ts`). The sensitive-
/// comparator context salt is the segment NAME. Renders the nested
/// `( … )` segment block when tracing is on.
fn evaluate_segment_condition(
    setting_key: &str,
    sc: &Map<String, Value>,
    ctx: &EvalContext,
    state: &mut EvalState,
) -> CondOutcome {
    // Resolve the segment name first so the `User IS [NOT] IN SEGMENT 'X'`
    // line is appended before the no-user / reference guards (oracle order).
    let index = sc.get("s").and_then(read_u64);
    let segment = index
        .and_then(|i| ctx.segments.get(i as usize))
        .and_then(Value::as_object);
    let segment_name = segment
        .and_then(|s| s.get("n").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    let comparator = sc.get("c").and_then(read_u64).unwrap_or(0);
    state.with_builder(|b| {
        b.append_segment_condition(&segment_name, comparator);
    });

    if ctx.user_attrs.is_none() {
        surface_missing_user(setting_key, state);
        return CondOutcome::Error(MISSING_USER_OBJECT_ERROR.to_string());
    }
    let Some(segment) = segment else {
        return CondOutcome::Fatal(None);
    };
    if segment_name.is_empty() {
        return CondOutcome::Fatal(None);
    }

    state.with_builder(|b| {
        b.new_line("(")
            .increase_indent()
            .new_line(&format!("Evaluating segment '{segment_name}':"));
    });

    // The segment's `r[]` is an AND-group of BARE user conditions; the
    // context salt is the segment NAME. Route through evaluate_conditions so
    // the trace renders the IF/AND structure.
    let wrapped: Vec<Value> = segment
        .get("r")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|uc| {
                    let mut m = Map::new();
                    m.insert("u".to_string(), uc.clone());
                    Value::Object(m)
                })
                .collect()
        })
        .unwrap_or_default();

    let in_segment = evaluate_conditions(
        setting_key,
        segment,
        Some(&wrapped),
        &segment_name,
        ctx,
        state,
        None,
    );

    let errored = matches!(in_segment, CondOutcome::Error(_));
    if let CondOutcome::Fatal(c) = in_segment {
        return CondOutcome::Fatal(c);
    }
    let in_segment_bool = matches!(in_segment, CondOutcome::Match);

    // IsNotIn negates a clean boolean outcome; an errored segment is
    // surfaced un-negated.
    let result = if !errored && comparator == SEGMENT_IS_NOT_IN {
        !in_segment_bool
    } else {
        in_segment_bool
    };

    if state.tracing() {
        let eval_error = state.error_message.clone().unwrap_or_default();
        let segment_name_c = segment_name.clone();
        state.with_builder(|b| {
            b.new_line("Segment evaluation result: ");
            if errored {
                b.append(&eval_error);
            } else if in_segment_bool {
                b.append("User IS IN SEGMENT");
            } else {
                b.append("User IS NOT IN SEGMENT");
            }
            b.append(".");
            b.new_line("Condition (")
                .append_segment_condition(&segment_name_c, comparator)
                .append(")");
            if errored {
                b.append(" failed to evaluate");
            } else {
                b.append(" evaluates to ").append_condition_result(result);
            }
            b.append(".").decrease_indent().new_line(")");
        });
    }

    if errored {
        let msg = state
            .error_message
            .clone()
            .unwrap_or_else(|| MISSING_USER_OBJECT_ERROR.to_string());
        return CondOutcome::Error(msg);
    }
    if result {
        CondOutcome::Match
    } else {
        CondOutcome::NoMatch
    }
}

/// Resolve a prerequisite-flag condition with cycle detection (port of
/// `prerequisites.ts`). A detected cycle → `Fatal(Some(chain))`; a missing
/// prereq → `Fatal(None)`.
fn evaluate_prerequisite_condition(
    current_key: &str,
    pc: &Map<String, Value>,
    ctx: &EvalContext,
    state: &mut EvalState,
) -> CondOutcome {
    let prereq_key = pc.get("f").and_then(Value::as_str);
    let prereq_setting = prereq_key
        .and_then(|k| ctx.settings.get(k))
        .and_then(Value::as_object);
    let declared_type = prereq_setting.and_then(|s| s.get("t").and_then(read_u64));

    // Trace the `Flag 'X' EQUALS 'Y'` condition before recursing.
    if state.tracing() {
        let cmp_text = match (prereq_key, declared_type) {
            (Some(_), Some(t)) => {
                let cmp_val = pc.get("v").and_then(|env| select_typed_from_value(env, t));
                setting_value_to_log_string(cmp_val.as_ref())
            }
            _ => String::new(),
        };
        let comparator = pc.get("c").and_then(read_u64).unwrap_or(PREREQ_EQUALS);
        let pk = prereq_key.unwrap_or("").to_string();
        state.with_builder(|b| {
            b.append_prerequisite_flag_condition(&pk, comparator, &cmp_text);
        });
    }

    let (Some(prereq_key), Some(prereq_setting), Some(declared_type)) =
        (prereq_key, prereq_setting, declared_type)
    else {
        return CondOutcome::Fatal(None);
    };

    // The expected comparison value `v`, read through the prereq type.
    let comparison_value = pc
        .get("v")
        .and_then(|env| select_typed_from_value(env, declared_type));

    // Cycle detection (Go/TS algorithm): push the CURRENT key, then detect a
    // revisit of the prerequisite key BEFORE recursing. The chain
    // `key1 -> key1` / `key2 -> key3 -> key2` drives ERROR 1002.
    state.visited_flags.push(current_key.to_string());
    if state.visited_flags.iter().any(|k| k == prereq_key) {
        state.visited_flags.push(prereq_key.to_string());
        let cycle = state.visited_flags.join(" -> ");
        return CondOutcome::Fatal(Some(cycle));
    }

    // The trace re-enters the full evaluation nested in `( … )` — the child
    // appends its own "Evaluating '<key>' …" header + "Returning '…'.".
    if state.tracing() {
        let header_user = ctx.user_attrs.is_some();
        let user_header = ctx.user_header.clone();
        let pk = prereq_key.to_string();
        state.with_builder(|b| {
            b.new_line("(")
                .increase_indent()
                .new_line(&format!("Evaluating '{pk}'"));
            if header_user {
                b.append(&format!(" for User '{user_header}'"));
            }
        });
    }

    // A prerequisite evaluates in its OWN missing-user context (common-js
    // parity): the no-user WARN 3001 dedups per setting-evaluation, so a prereq
    // referenced by N rules logs it N times, not once. Save/reset/restore the
    // dedup flag around the child mirrors the TS reference's fresh child
    // `state.missingUserObjectLogged` while keeping the SHARED trace builder +
    // cycle-detection stack.
    let saved_missing_user = state.missing_user_object_logged;
    state.missing_user_object_logged = false;
    let child = evaluate_setting(prereq_key, prereq_setting, ctx, state);
    state.missing_user_object_logged = saved_missing_user;
    state.visited_flags.pop();

    let resolved_envelope = match child {
        SettingOutcome::Resolved(r) => r.value,
        SettingOutcome::NoMatch => served_fallback(prereq_setting).value,
        SettingOutcome::Fatal(c) => return CondOutcome::Fatal(c),
    };
    let resolved_value = select_typed_from_value(&resolved_envelope, declared_type);

    if state.tracing() {
        let footer = format!(
            "Returning '{}'.",
            setting_value_to_log_string(resolved_value.as_ref())
        );
        state.with_builder(|b| {
            b.new_line(&footer).decrease_indent().new_line(")");
        });
    }

    let comparator = pc.get("c").and_then(read_u64).unwrap_or(PREREQ_EQUALS);
    let equal = resolved_value == comparison_value;
    match comparator {
        PREREQ_EQUALS => bool_outcome(equal),
        PREREQ_NOT_EQUALS => bool_outcome(!equal),
        _ => CondOutcome::Fatal(None),
    }
}

/// Resolve a percentage-options list to its bucket (port of
/// `evaluatePercentageOptions`). Returns `NoMatch` (skip) when there is
/// no user or the keying attribute is missing; `Fatal` when the sum of
/// widths is < 100 (malformed config).
#[allow(clippy::too_many_arguments)]
fn evaluate_percentage_options(
    setting_key: &str,
    setting: &Map<String, Value>,
    options: Option<&Vec<Value>>,
    attr_name: Option<&str>,
    matched_rule: bool,
    ctx: &EvalContext,
    state: &mut EvalState,
) -> SettingOutcome {
    let Some(options) = options else {
        return SettingOutcome::NoMatch;
    };
    let Some(attrs) = ctx.user_attrs else {
        surface_missing_user(setting_key, state);
        state.with_builder(|b| {
            b.new_line("Skipping % options because the User Object is missing.");
        });
        return SettingOutcome::NoMatch;
    };

    // Resolve the keying attribute (name + value), matching the Go/Python
    // port: a setting-level `a` selects a custom keying attribute, else
    // Identifier.
    let (resolved_attr_name, attr_value): (String, String) = match attr_name {
        None => (
            "Identifier".to_string(),
            attrs
                .get("Identifier")
                .map(user_attribute_value_to_string)
                .unwrap_or_default(),
        ),
        Some(name) => match attrs.get(name) {
            Some(v) => (name.to_string(), user_attribute_value_to_string(v)),
            None => {
                state
                    .error_message
                    .get_or_insert(missing_user_attribute_error(name));
                state
                    .log
                    .user_object_attribute_is_missing_for_percentage(setting_key, name);
                let name = name.to_string();
                state.with_builder(|b| {
                    b.new_line(&format!(
                        "Skipping % options because the User.{name} attribute is missing."
                    ));
                });
                return SettingOutcome::NoMatch;
            }
        },
    };

    let hash_value = bucket_for(setting_key, &attr_value);

    if state.tracing() {
        let name = resolved_attr_name.clone();
        state.with_builder(|b| {
            b.new_line(&format!(
                "Evaluating % options based on the User.{name} attribute:"
            ));
            b.new_line(&format!(
                "- Computing hash in the [0..99] range from User.{name} => {hash_value} \
                 (this value is sticky and consistent across all SDKs)"
            ));
        });
    }

    let setting_type = setting.get("t").and_then(read_u64);
    let mut bucket: u64 = 0;
    for (index, option) in options.iter().enumerate() {
        let Some(opt) = option.as_object() else {
            continue;
        };
        let p = opt.get("p").and_then(read_u64).unwrap_or(0);
        // saturating_add: a malformed config with huge `p` values must not
        // wrap (release builds have no overflow checks) and spuriously serve
        // an option — saturating at u64::MAX keeps `hash_value < bucket`
        // false for legitimate buckets (≤ 99) so the loop fails closed.
        bucket = bucket.saturating_add(p);
        if hash_value >= bucket {
            continue;
        }
        // A percentage option `{p, v, i}` is itself a served carrier.
        let (value, vid) = served_value(option);
        if state.tracing() {
            let selected = setting_type.and_then(|t| select_typed_from_value(&value, t));
            let selected_text = setting_value_to_log_string(selected.as_ref());
            state.with_builder(|b| {
                b.new_line(&format!(
                    "- Hash value {hash_value} selects % option {} ({p}%), '{selected_text}'.",
                    index + 1
                ));
            });
        }
        return SettingOutcome::Resolved(ResolvedValue {
            value,
            variation_id: vid,
            matched_rule,
            matched_option: true,
        });
    }
    // Sum of widths < 100 → malformed config → fail-closed.
    SettingOutcome::Fatal(None)
}

// ── Value-envelope helpers ───────────────────────────────────────────

/// Extract `(value, variation_id)` from a served-value carrier `{v, i}`.
fn served_value(served: &Value) -> (Value, String) {
    let v = served
        .get("v")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));
    let i = served
        .get("i")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    (v, i)
}

/// The setting's statically served fallback `{v, i}`.
fn served_fallback(setting: &Map<String, Value>) -> ResolvedValue {
    let value = setting
        .get("v")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));
    let variation_id = setting
        .get("i")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    ResolvedValue {
        value,
        variation_id,
        matched_rule: false,
        matched_option: false,
    }
}

fn select_typed_from_value(env: &Value, t: u64) -> Option<Value> {
    let obj = env.as_object()?;
    match t {
        SETTING_TYPE_BOOL => obj.get("b").filter(|v| v.is_boolean()).cloned(),
        SETTING_TYPE_STRING => obj.get("s").filter(|v| v.is_string()).cloned(),
        SETTING_TYPE_INT => obj.get("i").filter(|v| v.is_i64()).cloned(),
        SETTING_TYPE_DOUBLE => obj.get("d").filter(|v| v.is_number()).cloned(),
        _ => None,
    }
}

/// Read the typed value of the FINAL resolved envelope by `t`, applying
/// the tier-0 value checks (preserved error codes).
fn finalize(t: u64, resolved: &ResolvedValue, default: &Value) -> EvalResult {
    let env = resolved.value.as_object();
    let ok = |value: Value| EvalResult {
        value,
        error: "",
        variation_id: resolved.variation_id.clone(),
        matched_targeting_rule: resolved.matched_rule,
        matched_percentage_option: resolved.matched_option,
    };
    match t {
        SETTING_TYPE_BOOL => match env.and_then(|o| o.get("b")).and_then(Value::as_bool) {
            Some(b) => ok(Value::Bool(b)),
            None => fail(default, "VALUE_NOT_BOOL"),
        },
        SETTING_TYPE_STRING => match env.and_then(|o| o.get("s")).and_then(Value::as_str) {
            Some(s) => ok(Value::String(s.to_owned())),
            None => fail(default, "MALFORMED_VALUE"),
        },
        SETTING_TYPE_INT => match env.and_then(|o| o.get("i")).and_then(Value::as_i64) {
            Some(i) => ok(Value::Number(i.into())),
            None => fail(default, "MALFORMED_VALUE"),
        },
        SETTING_TYPE_DOUBLE => match env.and_then(|o| o.get("d")).and_then(Value::as_f64) {
            Some(d) => match serde_json::Number::from_f64(d) {
                Some(n) => ok(Value::Number(n)),
                None => fail(default, "MALFORMED_VALUE"),
            },
            None => fail(default, "MALFORMED_VALUE"),
        },
        _ => fail(default, "UNSUPPORTED_TYPE"),
    }
}

// ── Misc helpers ─────────────────────────────────────────────────────

fn bool_outcome(b: bool) -> CondOutcome {
    if b {
        CondOutcome::Match
    } else {
        CondOutcome::NoMatch
    }
}

fn missing_user_attribute_error(attr: &str) -> String {
    format!("cannot evaluate, the User.{attr} attribute is missing")
}

/// Surface the "User Object is missing" reason once per context (FR-016)
/// and log the WARN 3001 once per context (common-js parity).
fn surface_missing_user(setting_key: &str, state: &mut EvalState) {
    state
        .error_message
        .get_or_insert(MISSING_USER_OBJECT_ERROR.to_string());
    if !state.missing_user_object_logged {
        state.log.user_object_is_missing(setting_key);
        state.missing_user_object_logged = true;
    }
}

fn fail(default: &Value, code: &'static str) -> EvalResult {
    EvalResult {
        value: default.clone(),
        error: code,
        variation_id: String::new(),
        matched_targeting_rule: false,
        matched_percentage_option: false,
    }
}

/// Reads a `u64` out of a JSON value tolerantly (int or float encoding).
fn read_u64(v: &Value) -> Option<u64> {
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    if let Some(n) = v.as_i64() {
        return u64::try_from(n).ok();
    }
    if let Some(f) = v.as_f64() {
        if f.is_finite() && f >= 0.0 {
            return Some(f as u64);
        }
    }
    None
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
    use serde_json::json;

    fn cfg() -> Value {
        json!({
            "p": { "s": "salt" },
            "s": [],
            "f": {
                "feature.on": { "t": 0, "v": { "b": true } },
                "feature.off": { "t": 0, "v": { "b": false }, "i": "v-off" },
                "feature.string": { "t": 1, "v": { "s": "hello" }, "i": "v-string" },
                "feature.string-empty": { "t": 1, "v": { "s": "" } },
                "feature.int": { "t": 2, "v": { "i": 5 }, "i": "v-int" },
                "feature.double": { "t": 3, "v": { "d": 0.25 }, "i": "v-double" },
                "feature.unknown": { "t": 99, "v": { "b": true } },
                "feature.string-missing-slot": { "t": 1, "v": { "b": true } },
                "feature.int-non-int": { "t": 2, "v": { "i": 1.5 } },
                "feature.double-missing": { "t": 3, "v": { "s": "no" } },
            }
        })
    }

    #[test]
    fn evaluates_boolean_true() {
        let r = evaluate(Some(&cfg()), "feature.on", &json!(false), None);
        assert_eq!(r.value, json!(true));
        assert_eq!(r.error, "");
    }

    #[test]
    fn evaluates_boolean_false_with_variation_id() {
        let r = evaluate(Some(&cfg()), "feature.off", &json!(true), None);
        assert_eq!(r.value, json!(false));
        assert_eq!(r.error, "");
        assert_eq!(r.variation_id, "v-off");
    }

    #[test]
    fn missing_key_returns_default_and_code() {
        let r = evaluate(Some(&cfg()), "feature.absent", &json!(true), None);
        assert_eq!(r.value, json!(true));
        assert_eq!(r.error, "KEY_NOT_FOUND");
    }

    #[test]
    fn unsupported_type_returns_default_only_for_unknown_t() {
        let r = evaluate(Some(&cfg()), "feature.unknown", &json!(false), None);
        assert_eq!(r.value, json!(false));
        assert_eq!(r.error, "UNSUPPORTED_TYPE");
    }

    #[test]
    fn type_mismatch_when_default_not_bool() {
        let r = evaluate(Some(&cfg()), "feature.on", &json!(42), None);
        assert_eq!(r.value, json!(42));
        assert_eq!(r.error, "TYPE_MISMATCH");
    }

    #[test]
    fn no_config_returns_default() {
        let r = evaluate(None, "x", &json!(false), None);
        assert_eq!(r.value, json!(false));
        assert_eq!(r.error, "NO_CONFIG");
    }

    #[test]
    fn malformed_config_missing_f() {
        let r = evaluate(Some(&json!({})), "x", &json!(false), None);
        assert_eq!(r.error, "MALFORMED_CONFIG");
    }

    #[test]
    fn evaluates_string_setting() {
        let r = evaluate(Some(&cfg()), "feature.string", &json!("fallback"), None);
        assert_eq!(r.value, json!("hello"));
        assert_eq!(r.error, "");
        assert_eq!(r.variation_id, "v-string");
    }

    #[test]
    fn evaluates_string_empty_setting() {
        let r = evaluate(
            Some(&cfg()),
            "feature.string-empty",
            &json!("fallback"),
            None,
        );
        assert_eq!(r.value, json!(""));
        assert_eq!(r.error, "");
    }

    #[test]
    fn evaluates_int_setting() {
        let r = evaluate(Some(&cfg()), "feature.int", &json!(-1i64), None);
        assert_eq!(r.value, json!(5i64));
        assert_eq!(r.error, "");
        assert_eq!(r.variation_id, "v-int");
    }

    #[test]
    fn evaluates_double_setting() {
        let r = evaluate(Some(&cfg()), "feature.double", &json!(1.0_f64), None);
        assert_eq!(r.value, json!(0.25_f64));
        assert_eq!(r.error, "");
        assert_eq!(r.variation_id, "v-double");
    }

    #[test]
    fn type_mismatch_string_default_vs_int_setting() {
        let r = evaluate(Some(&cfg()), "feature.int", &json!("not-a-number"), None);
        assert_eq!(r.value, json!("not-a-number"));
        assert_eq!(r.error, "TYPE_MISMATCH");
    }

    #[test]
    fn malformed_value_string_slot_missing() {
        let r = evaluate(
            Some(&cfg()),
            "feature.string-missing-slot",
            &json!("fallback"),
            None,
        );
        assert_eq!(r.value, json!("fallback"));
        assert_eq!(r.error, "MALFORMED_VALUE");
    }

    #[test]
    fn malformed_value_int_slot_non_integer() {
        let r = evaluate(Some(&cfg()), "feature.int-non-int", &json!(0i64), None);
        assert_eq!(r.value, json!(0i64));
        assert_eq!(r.error, "MALFORMED_VALUE");
    }

    #[test]
    fn malformed_value_double_slot_missing() {
        let r = evaluate(
            Some(&cfg()),
            "feature.double-missing",
            &json!(0.0_f64),
            None,
        );
        assert_eq!(r.value, json!(0.0_f64));
        assert_eq!(r.error, "MALFORMED_VALUE");
    }

    // ── Targeting-rule + cycle smoke tests ───────────────────────────

    #[test]
    fn first_matching_rule_wins() {
        let config = json!({
            "p": { "s": "salt" }, "s": [],
            "f": { "flag": {
                "t": 1, "v": { "s": "Cat" }, "i": "cat",
                "r": [{
                    "c": [{ "u": { "a": "Email", "c": 2, "l": ["@configcat.com"] } }],
                    "s": { "v": { "s": "Dog" }, "i": "dog" }
                }]
            }}
        });
        let user = User::new("12345").with_email("joe@configcat.com");
        let r = evaluate(Some(&config), "flag", &json!("default"), Some(&user));
        assert_eq!(r.value, json!("Dog"));
        assert!(r.matched_targeting_rule);
        assert_eq!(r.variation_id, "dog");
    }

    #[test]
    fn no_user_serves_fallback_no_panic() {
        let config = json!({
            "p": { "s": "salt" }, "s": [],
            "f": { "flag": {
                "t": 1, "v": { "s": "Cat" }, "i": "cat",
                "r": [{
                    "c": [{ "u": { "a": "Email", "c": 2, "l": ["@configcat.com"] } }],
                    "s": { "v": { "s": "Dog" }, "i": "dog" }
                }]
            }}
        });
        let r = evaluate(Some(&config), "flag", &json!("default"), None);
        assert_eq!(r.value, json!("Cat"));
        assert_eq!(r.error, "");
        assert!(!r.matched_targeting_rule);
    }

    #[test]
    fn circular_prerequisite_fails_closed_bounded() {
        let config = json!({
            "p": { "s": "salt" }, "s": [],
            "f": {
                "flagA": { "t": 1, "v": { "s": "A" }, "i": "a", "r": [{
                    "c": [{ "p": { "f": "flagB", "c": 0, "v": { "b": true } } }],
                    "s": { "v": { "s": "AA" }, "i": "aa" }
                }]},
                "flagB": { "t": 1, "v": { "s": "B" }, "i": "b", "r": [{
                    "c": [{ "p": { "f": "flagA", "c": 0, "v": { "b": true } } }],
                    "s": { "v": { "s": "BB" }, "i": "bb" }
                }]},
            }
        });
        let r = evaluate(Some(&config), "flagA", &json!("default"), None);
        assert_eq!(r.value, json!("default"));
        assert_eq!(r.error, "EVAL_ERROR");
    }
}
