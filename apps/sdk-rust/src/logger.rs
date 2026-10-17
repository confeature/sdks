// SPDX-License-Identifier: MIT

//! Customer-pluggable logging surface.
//!
//! [`Logger`] is the trait every SDK log site routes through; the
//! default implementation [`LogFacadeLogger`] forwards to the
//! [`log`] crate's `log::log!` macros so customers who plug a
//! `env_logger` / `tracing-log` bridge see SDK lines in their
//! existing pipeline.
//!
//! SECURITY: log sites that need to reference an SDK key MUST pass
//! it through [`crate::internal::sdk_key::redact_sdk_key`] FIRST.
//! The raw key never reaches a [`Logger`] implementation.

use crate::log_level::LogLevel;

/// Customer-pluggable logging trait. Implementors MUST be `Send +
/// Sync` so the SDK can hand the same instance to a background
/// AutoPoll task. Methods take `&self`, never `&mut`, so logging from
/// multiple async contexts requires no external locking.
pub trait Logger: Send + Sync {
    /// Emits an `Error`-severity message.
    fn error(&self, message: &str);
    /// Emits a `Warning`-severity message.
    fn warning(&self, message: &str);
    /// Emits an `Info`-severity message.
    fn info(&self, message: &str);
    /// Emits a `Debug`-severity message.
    fn debug(&self, message: &str);
}

/// Default [`Logger`] forwarding to the `log` crate's macros. Customers
/// who already plug `env_logger` / `tracing-log` / `log4rs` will see
/// SDK lines in their existing pipeline without further configuration.
///
/// The struct carries a configured threshold so the SDK can short-
/// circuit verbose paths before formatting the message.
pub struct LogFacadeLogger {
    level: LogLevel,
}

impl LogFacadeLogger {
    /// Constructs a [`LogFacadeLogger`] with the given threshold.
    pub fn new(level: LogLevel) -> Self {
        Self { level }
    }
}

impl Default for LogFacadeLogger {
    fn default() -> Self {
        Self::new(LogLevel::Error)
    }
}

impl Logger for LogFacadeLogger {
    fn error(&self, message: &str) {
        if self.level.allows(LogLevel::Error) {
            log::error!(target: "confeature", "{message}");
        }
    }
    fn warning(&self, message: &str) {
        if self.level.allows(LogLevel::Warning) {
            log::warn!(target: "confeature", "{message}");
        }
    }
    fn info(&self, message: &str) {
        if self.level.allows(LogLevel::Info) {
            log::info!(target: "confeature", "{message}");
        }
    }
    fn debug(&self, message: &str) {
        if self.level.allows(LogLevel::Debug) {
            log::debug!(target: "confeature", "{message}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct RecordingLogger {
        lines: Mutex<Vec<(LogLevel, String)>>,
    }

    impl Logger for RecordingLogger {
        fn error(&self, m: &str) {
            self.lines
                .lock()
                .unwrap()
                .push((LogLevel::Error, m.to_string()));
        }
        fn warning(&self, m: &str) {
            self.lines
                .lock()
                .unwrap()
                .push((LogLevel::Warning, m.to_string()));
        }
        fn info(&self, m: &str) {
            self.lines
                .lock()
                .unwrap()
                .push((LogLevel::Info, m.to_string()));
        }
        fn debug(&self, m: &str) {
            self.lines
                .lock()
                .unwrap()
                .push((LogLevel::Debug, m.to_string()));
        }
    }

    #[test]
    fn recording_logger_captures_lines() {
        let l = RecordingLogger {
            lines: Mutex::new(Vec::new()),
        };
        l.warning("hello");
        l.error("boom");
        let recorded = l.lines.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0].0, LogLevel::Warning);
        assert_eq!(recorded[1].0, LogLevel::Error);
    }

    #[test]
    fn log_facade_logger_default_is_error_level() {
        let l = LogFacadeLogger::default();
        assert_eq!(l.level, LogLevel::Error);
    }

    #[test]
    fn log_facade_logger_emits_at_all_levels_when_debug() {
        // Smoke-test that the four severity methods are call-safe at
        // every level (they delegate to the global `log` crate which
        // discards lines when no logger backend is installed — which is
        // the default in `cargo test`).
        let l = LogFacadeLogger::new(LogLevel::Debug);
        l.error("e");
        l.warning("w");
        l.info("i");
        l.debug("d");
    }

    #[test]
    fn log_facade_logger_short_circuits_below_threshold() {
        let l = LogFacadeLogger::new(LogLevel::Off);
        // Should not panic; each call hits the `allows(...)` guard and
        // bypasses the macro.
        l.error("e");
        l.warning("w");
        l.info("i");
        l.debug("d");
    }
}
