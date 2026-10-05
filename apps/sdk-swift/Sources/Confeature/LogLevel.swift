// SPDX-License-Identifier: MIT

import Foundation

/// Severity threshold for ``Logger`` dispatch.
///
/// Variants are ordered from least-verbose (``off``) to most-verbose
/// (``debug``). A logger configured at level ``info`` MUST emit
/// ``error``, ``warning``, and ``info`` lines and silently drop
/// ``debug`` lines.
///
/// Mirrors `ConfigCat-iOS`'s `LogLevel` enum 1:1 — same cases, same
/// ordering, same defaults.
public enum LogLevel: Int, Sendable, Comparable {
    /// Logging disabled entirely.
    case off = 0
    /// Errors only (the default for production).
    case error = 1
    /// Errors + warnings.
    case warning = 2
    /// Errors + warnings + info.
    case info = 3
    /// All log lines.
    case debug = 4

    public static func < (lhs: LogLevel, rhs: LogLevel) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    /// Reports whether a log at `incoming` severity should be emitted
    /// when the configured threshold is `self`. ``off`` blocks every
    /// incoming severity.
    public func allows(_ incoming: LogLevel) -> Bool {
        if self == .off { return false }
        return incoming.rawValue <= self.rawValue
    }
}
