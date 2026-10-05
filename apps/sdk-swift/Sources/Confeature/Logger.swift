// SPDX-License-Identifier: MIT

import Foundation
import os

/// Customer-pluggable logging trait.
///
/// Implementors MUST be `Sendable` so the SDK can hand the same
/// instance to a background AutoPoll `Task`. Methods are non-mutating,
/// so logging from multiple async contexts requires no external
/// locking.
///
/// SECURITY: log sites that need to reference an SDK key MUST pass
/// it through ``SdkKey/redact(_:)`` first. The raw key never reaches
/// a ``Logger`` implementation.
public protocol Logger: Sendable {
    /// Emits an ``LogLevel/error``-severity message.
    func error(_ message: String)
    /// Emits a ``LogLevel/warning``-severity message.
    func warning(_ message: String)
    /// Emits an ``LogLevel/info``-severity message.
    func info(_ message: String)
    /// Emits a ``LogLevel/debug``-severity message.
    func debug(_ message: String)
}

/// Default ``Logger`` implementation backed by Apple's unified
/// logging system (the legacy `os_log` C API — iOS 10+ / macOS 10.12+).
/// Customers who already route through OSLog will see SDK lines in
/// their existing pipeline without further configuration.
///
/// The struct carries a configured threshold so the SDK can short-
/// circuit verbose paths before formatting the message.
///
/// `os_log` is used instead of the newer `os.Logger` to keep the
/// minimum deployment targets at iOS 13 / macOS 10.15 / tvOS 13 /
/// watchOS 6, which match `ConfigCat-iOS`'s public matrix
/// (`os.Logger` requires iOS 14 / macOS 11).
public struct OSLogger: Logger {
    private let level: LogLevel
    private let osLog: OSLog

    /// Constructs an ``OSLogger`` with the given threshold and
    /// subsystem / category.
    public init(
        level: LogLevel = .error,
        subsystem: String = "io.confeature.sdk",
        category: String = "confeature"
    ) {
        self.level = level
        self.osLog = OSLog(subsystem: subsystem, category: category)
    }

    public func error(_ message: String) {
        guard level.allows(.error) else { return }
        os_log("%{public}@", log: osLog, type: .error, message)
    }

    public func warning(_ message: String) {
        guard level.allows(.warning) else { return }
        // `os_log` collapses `default` + `error` + `fault` into the
        // three actionable levels; warnings ride the default channel.
        os_log("%{public}@", log: osLog, type: .default, message)
    }

    public func info(_ message: String) {
        guard level.allows(.info) else { return }
        os_log("%{public}@", log: osLog, type: .info, message)
    }

    public func debug(_ message: String) {
        guard level.allows(.debug) else { return }
        os_log("%{public}@", log: osLog, type: .debug, message)
    }
}

/// Logger that silently discards every message. Useful in tests and
/// for customers who explicitly want SDK logging off.
public struct NoOpLogger: Logger {
    public init() {}
    public func error(_ message: String) {}
    public func warning(_ message: String) {}
    public func info(_ message: String) {}
    public func debug(_ message: String) {}
}
