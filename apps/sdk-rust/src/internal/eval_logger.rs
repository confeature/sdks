// SPDX-License-Identifier: MIT

//! Evaluation logger surface (ADR 0003 / epic #494, Rust slice of #501).
//!
//! The WARN / ERROR / INFO lines the federated evaluator emits during a
//! trace, ported from `packages/sdk-shared/src/logger.ts` (the
//! `LoggerWrapper` helpers `userObjectIsMissing` /
//! `userObjectAttributeIsMissing` /
//! `userObjectAttributeIsMissingForPercentage` /
//! `userObjectAttributeIsInvalid` / `comparisonValueIsInvalid` /
//! `circularDependency`) and the INFO 5000 trace emission point in
//! `evaluator.ts`. Mirrors the Go port
//! (`apps/sdk-go/internal/evaluator/eval_logger.go`) and the Python port
//! (`apps/sdk-python/src/confeature_client/eval_logger.py`) so the
//! federation ports stay consistent.
//!
//! The strings are ported VERBATIM from `logger.ts` (Principle II —
//! byte-identical to the canonical). The capture format the parity test
//! reconstructs is `"<LEVEL>: [<eventId>] <message>"` per emitted call,
//! joined by `"\n"`, with the INFO 5000 entry carrying the multi-line
//! indented trace — see `parity-upstream.test.ts` `assertEvalLogTrace`.
//!
//! This trace-logging seam is intentionally distinct from the public
//! [`crate::logger::Logger`] trait: a customer-supplied logger has the
//! `error/warning/info/debug` shape, while the trace test taps a
//! structured `(level, event_id, message)` recorder. Keeping them
//! separate matches the Go / Python factoring (their `TraceLogger` is
//! likewise independent of the SDK's public logger surface) and keeps the
//! no-trace hot path zero-cost.

/// Mirrors configcat-common's numeric ordering (logger.ts `LogLevel`) so
/// level filtering ("Info and above") works identically across SDKs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceLogLevel {
    /// Disables all logging.
    Off,
    /// ERROR only.
    Error,
    /// WARN and above.
    Warn,
    /// INFO and above — the level at which the eval-log trace is built.
    Info,
    /// Everything.
    Debug,
}

impl TraceLogLevel {
    /// Numeric rank matching configcat-common (logger.ts `LogLevel`):
    /// `Off=-1`, `Error=1`, `Warn=2`, `Info=3`, `Debug=4`.
    fn rank(self) -> i32 {
        match self {
            TraceLogLevel::Off => -1,
            TraceLogLevel::Error => 1,
            TraceLogLevel::Warn => 2,
            TraceLogLevel::Info => 3,
            TraceLogLevel::Debug => 4,
        }
    }
}

/// Captures the evaluator's structured log calls. Each call is one
/// `(level, event_id, message)` tuple; an INFO-enabled logger drives the
/// eval-log trace (the multi-line INFO 5000 line) plus the WARN/ERROR
/// lines emitted during the walk. This is the seam the parity test taps
/// to reconstruct ConfigCat's byte-identical capture string.
pub trait TraceLogger {
    /// Reports the configured threshold (`Info` enables tracing).
    fn level(&self) -> TraceLogLevel;
    /// Records one emitted line.
    fn log(&mut self, level: TraceLogLevel, event_id: &str, message: &str);
}

/// Internal logger adapter threaded through the evaluation context. It
/// mirrors logger.ts `LoggerWrapper`: a `None` inner means tracing is off
/// (zero cost), and every helper is level-gated at the boundary.
pub(crate) struct TraceLog<'a> {
    inner: Option<&'a mut dyn TraceLogger>,
}

impl<'a> TraceLog<'a> {
    pub(crate) fn new(inner: Option<&'a mut dyn TraceLogger>) -> Self {
        Self { inner }
    }

    pub(crate) fn enabled(&self, level: TraceLogLevel) -> bool {
        let Some(inner) = self.inner.as_ref() else {
            return false;
        };
        let threshold = inner.level();
        if threshold == TraceLogLevel::Off {
            return false;
        }
        level.rank() <= threshold.rank()
    }

    fn emit(&mut self, level: TraceLogLevel, event_id: &str, message: &str) {
        if !self.enabled(level) {
            return;
        }
        if let Some(inner) = self.inner.as_mut() {
            inner.log(level, event_id, message);
        }
    }

    /// WARN 3001 (verbatim from logger.ts `userObjectIsMissing`).
    pub(crate) fn user_object_is_missing(&mut self, key: &str) {
        self.emit(
            TraceLogLevel::Warn,
            "3001",
            &format!(
                "cannot evaluate targeting rules and % options for setting '{key}' \
                 (User Object is missing); you should pass a User Object to the evaluation \
                 methods like `getValue()` in order to make targeting work properly; read more: \
                 https://configcat.com/docs/advanced/user-object/"
            ),
        );
    }

    /// WARN 3003 (verbatim from logger.ts `userObjectAttributeIsMissing`).
    pub(crate) fn user_object_attribute_is_missing(&mut self, key: &str, attribute_name: &str) {
        self.emit(
            TraceLogLevel::Warn,
            "3003",
            &format!(
                "cannot evaluate certain targeting rules of setting '{key}' \
                 (the User.{attribute_name} attribute is missing); you should set the \
                 User.{attribute_name} attribute in order to make targeting work properly; \
                 read more: https://configcat.com/docs/advanced/user-object/"
            ),
        );
    }

    /// WARN 3003, % options variant (verbatim from logger.ts
    /// `userObjectAttributeIsMissingForPercentage`).
    pub(crate) fn user_object_attribute_is_missing_for_percentage(
        &mut self,
        key: &str,
        attribute_name: &str,
    ) {
        self.emit(
            TraceLogLevel::Warn,
            "3003",
            &format!(
                "cannot evaluate % options for setting '{key}' \
                 (the User.{attribute_name} attribute is missing); you should set the \
                 User.{attribute_name} attribute in order to make targeting work properly; \
                 read more: https://configcat.com/docs/advanced/user-object/"
            ),
        );
    }

    /// WARN 3004 (verbatim from logger.ts `userObjectAttributeIsInvalid`).
    pub(crate) fn user_object_attribute_is_invalid(
        &mut self,
        key: &str,
        attribute_name: &str,
        reason: &str,
    ) {
        self.emit(
            TraceLogLevel::Warn,
            "3004",
            &format!(
                "cannot evaluate certain targeting rules of setting '{key}' \
                 (the User.{attribute_name} attribute is invalid ({reason})); please check the \
                 User.{attribute_name} attribute and make sure that its value corresponds to the \
                 comparison operator"
            ),
        );
    }

    /// WARN 3004, malformed config operand (#509). Note there is NO
    /// "please check the User.<attr>…" suffix (verbatim from logger.ts
    /// `comparisonValueIsInvalid`). `inner_message` is the full
    /// `comparison value '<v>' is invalid (<reason>)` text.
    pub(crate) fn comparison_value_is_invalid(&mut self, key: &str, inner_message: &str) {
        self.emit(
            TraceLogLevel::Warn,
            "3004",
            &format!(
                "cannot evaluate certain targeting rules of setting '{key}' ({inner_message})"
            ),
        );
    }

    /// ERROR 1002 (verbatim from logger.ts `circularDependency`).
    pub(crate) fn circular_dependency(&mut self, key: &str, cycle: &str) {
        self.emit(
            TraceLogLevel::Error,
            "1002",
            &format!(
                "failed to evaluate setting '{key}' (circular dependency detected between the \
                 following depending flags: [{cycle}])"
            ),
        );
    }

    /// INFO line (the 5000 trace). Mirrors logger.ts `LoggerWrapper.info`.
    pub(crate) fn info(&mut self, event_id: &str, message: &str) {
        self.emit(TraceLogLevel::Info, event_id, message);
    }
}
