// SPDX-License-Identifier: MIT

import Foundation

/// Typed error code on a ``RefreshResult``. Mirrors ConfigCat 11.3.1's
/// `RefreshErrorCode` enum (`Sources/ConfigCat/ConfigService.swift`)
/// 1:1 — same case names, same raw integer values.
@objc public enum RefreshErrorCode: Int {
    /// No error — the refresh succeeded.
    case none = 0

    /// Client is configured with LocalOnly overrides; the remote
    /// fetch path is intentionally disabled. ``RefreshResult/isSuccess``
    /// is `false` but this is not a bug.
    case localOnlyClient = 1

    /// Client is in offline mode; the remote fetch path is suspended.
    case offlineClient = 2

    /// The HTTP request failed (transport-level — DNS, TCP, TLS).
    case httpRequestFailure = 3

    /// The HTTP response was received but indicated an error
    /// (non-2xx status, malformed body, ETag mismatch, etc.).
    case httpResponseFailure = 4

    /// Some other unexpected error (e.g. client closed, JSON
    /// deserialisation crash).
    case unexpectedError = 5
}

/// Outcome of a ``ConfeatureClient/forceRefresh()`` call. Mirrors
/// ConfigCat 11.3.1's `RefreshResult`
/// (`Sources/ConfigCat/ConfigService.swift`) 1:1.
///
/// Pre-1.0 BC change (FR-018): ``ConfeatureClient/forceRefresh()`` now
/// returns `RefreshResult` instead of `Void` so callers can inspect
/// ``RefreshResult/isSuccess`` and ``RefreshResult/errorCode``. Existing
/// `await client.forceRefresh()` call sites that ignore the result will
/// emit a "result of call ... is unused" warning under Swift 5.9's
/// strict checks; assign to `_` to discard explicitly.
public final class RefreshResult: NSObject {
    /// `true` when the refresh completed without an error code.
    @objc public let isSuccess: Bool

    /// Human-readable error message. `nil` on success.
    @objc public let errorMessage: String?

    /// Typed error code. ``RefreshErrorCode/none`` on success.
    @objc public let errorCode: RefreshErrorCode

    /// Designated initialiser.
    @objc public init(isSuccess: Bool, errorMessage: String?, errorCode: RefreshErrorCode) {
        self.isSuccess = isSuccess
        self.errorMessage = errorMessage
        self.errorCode = errorCode
        super.init()
    }
}
