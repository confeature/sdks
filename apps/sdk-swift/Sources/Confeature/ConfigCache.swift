// SPDX-License-Identifier: MIT

import Foundation

/// Customer-pluggable persistence surface for the latest
/// `config_v6.json` body + ETag.
///
/// Mirrors `ConfigCat-iOS`'s `ConfigCache` protocol 1:1: the SDK
/// reads / writes opaque `String` blobs and never reaches into the
/// payload shape. The default implementation
/// (``FilesystemCache``) persists to disk; customers can plug a
/// memory-only or remote-backed cache by conforming to this
/// protocol.
public protocol ConfigCache: Sendable {
    /// Reads the cached entry for `key` (the derived cache-key
    /// envelope, e.g. `confeature:cache:v1:…`). Returns `nil` when
    /// no entry has been written or when the underlying store is
    /// unreachable.
    func read(forKey key: String) -> String?

    /// Persists `value` under `key`. Implementations MUST be
    /// best-effort and MUST NOT throw — the SDK falls back to its
    /// in-memory mirror if the implementation can't persist.
    func write(value: String, forKey key: String)
}
