// SPDX-License-Identifier: MIT

//! Log level enum mirroring the upstream `configcat` crate's
//! `LogLevel`.

/// Severity threshold for [`crate::Logger`] dispatch. Variants are
/// ordered from least-verbose (`Off`) to most-verbose (`Debug`); a
/// logger configured at level `Info` MUST emit `Error`, `Warning`, and
/// `Info` lines and silently drop `Debug` lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub enum LogLevel {
    /// Logging disabled entirely.
    Off,
    /// Errors only (the default for production).
    #[default]
    Error,
    /// Errors + warnings.
    Warning,
    /// Errors + warnings + info.
    Info,
    /// All log lines.
    Debug,
}

impl LogLevel {
    /// Reports whether a log at `incoming` severity should be emitted
    /// when the configured threshold is `self`.
    pub fn allows(self, incoming: LogLevel) -> bool {
        // Off blocks everything; otherwise emit when incoming severity
        // is at or below the configured threshold's numeric rank.
        if self == LogLevel::Off {
            return false;
        }
        incoming as u8 <= self as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_blocks_everything() {
        assert!(!LogLevel::Off.allows(LogLevel::Error));
        assert!(!LogLevel::Off.allows(LogLevel::Debug));
    }

    #[test]
    fn error_only_passes_error() {
        assert!(LogLevel::Error.allows(LogLevel::Error));
        assert!(!LogLevel::Error.allows(LogLevel::Warning));
        assert!(!LogLevel::Error.allows(LogLevel::Info));
        assert!(!LogLevel::Error.allows(LogLevel::Debug));
    }

    #[test]
    fn debug_passes_everything_except_off() {
        assert!(LogLevel::Debug.allows(LogLevel::Error));
        assert!(LogLevel::Debug.allows(LogLevel::Warning));
        assert!(LogLevel::Debug.allows(LogLevel::Info));
        assert!(LogLevel::Debug.allows(LogLevel::Debug));
    }
}
