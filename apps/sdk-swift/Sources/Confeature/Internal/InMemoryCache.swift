// SPDX-License-Identifier: MIT

import Foundation

/// In-process ``ConfigCache`` backed by an `NSLock`-guarded
/// dictionary. Used directly when the caller opts into in-memory
/// mode and as the fallback target when ``FilesystemCache`` flips
/// out of disk mode.
final class InMemoryCache: ConfigCache, @unchecked Sendable {
    private let lock = NSLock()
    private var store: [String: String] = [:]

    init() {}

    func read(forKey key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return store[key]
    }

    func write(value: String, forKey key: String) {
        lock.lock()
        defer { lock.unlock() }
        store[key] = value
    }
}
