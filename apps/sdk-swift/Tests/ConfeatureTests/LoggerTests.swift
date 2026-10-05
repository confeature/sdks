// SPDX-License-Identifier: MIT

import XCTest

@testable import Confeature

/// Unit tests for the public ``Logger`` surface.
///
/// ``OSLogger`` routes through `os_log`, so we can't trivially capture
/// its output in-process. The tests below exercise the four severity
/// methods at every threshold to assert no method throws / panics.
/// Customer-side capture is delegated to the host app's OSLog
/// inspection tooling.
final class LoggerTests: XCTestCase {
    func testOSLoggerEmitsAtEveryLevelWhenDebug() {
        let l = OSLogger(level: .debug)
        l.error("e")
        l.warning("w")
        l.info("i")
        l.debug("d")
    }

    func testOSLoggerShortCircuitsBelowThreshold() {
        // Off threshold — every call should hit the `allows(...)` guard
        // and skip the os_log emit. We're asserting the early-return
        // doesn't throw.
        let l = OSLogger(level: .off)
        l.error("e")
        l.warning("w")
        l.info("i")
        l.debug("d")
    }

    func testOSLoggerErrorOnlyThreshold() {
        let l = OSLogger(level: .error)
        // No throws; only `error` calls past the threshold actually
        // emit through os_log.
        l.error("e")
        l.warning("w")
        l.info("i")
        l.debug("d")
    }

    func testNoOpLoggerSwallowsEverything() {
        let l = NoOpLogger()
        l.error("e")
        l.warning("w")
        l.info("i")
        l.debug("d")
    }

    func testCustomLoggerCapturesMessages() {
        let recorder = RecordingLogger()
        recorder.error("e1")
        recorder.warning("w1")
        recorder.info("i1")
        recorder.debug("d1")
        let entries = recorder.entries()
        XCTAssertEqual(entries.count, 4)
        XCTAssertEqual(entries[0].level, .error)
        XCTAssertEqual(entries[1].level, .warning)
        XCTAssertEqual(entries[2].level, .info)
        XCTAssertEqual(entries[3].level, .debug)
    }
}

/// Test-only ``Logger`` that captures every message + severity. The
/// SDK relies on this shape (via the public protocol) to drive
/// in-process assertions across the rest of the suite.
final class RecordingLogger: Logger, @unchecked Sendable {
    struct Entry {
        let level: LogLevel
        let message: String
    }

    private let lock = NSLock()
    private var lines: [Entry] = []

    func entries() -> [Entry] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }

    func error(_ message: String) { append(.error, message) }
    func warning(_ message: String) { append(.warning, message) }
    func info(_ message: String) { append(.info, message) }
    func debug(_ message: String) { append(.debug, message) }

    private func append(_ level: LogLevel, _ message: String) {
        lock.lock()
        lines.append(Entry(level: level, message: message))
        lock.unlock()
    }
}
