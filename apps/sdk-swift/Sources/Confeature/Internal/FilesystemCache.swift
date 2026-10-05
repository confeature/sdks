// SPDX-License-Identifier: MIT

import Foundation

/// Filesystem-backed ``ConfigCache``.
///
/// Default cache directory:
/// `FileManager.default.urls(for: .cachesDirectory,
///  in: .userDomainMask).first` / `Confeature` (FR-014). Each entry
/// is written atomically (write-to-temp + rename) and falls back to
/// an in-memory mirror on the first IO error so subsequent reads
/// can still serve a freshly-fetched body even when the disk is
/// unavailable.
final class FilesystemCache: ConfigCache, @unchecked Sendable {
    private let directory: URL
    private let memoryFallback = InMemoryCache()
    private let lock = NSLock()
    private var inFallbackMode = false
    private let sdkKeyForLog: String
    private let logger: Logger

    init(directory: URL, sdkKey: String, logger: Logger) {
        self.directory = directory
        self.sdkKeyForLog = sdkKey
        self.logger = logger
    }

    /// Default cache directory under the user's caches root —
    /// mirrors Apple's documented `.cachesDirectory` placement.
    static func defaultDirectory() -> URL {
        let base =
            FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        return base.appendingPathComponent("Confeature", isDirectory: true)
    }

    private func fileURL(for key: String) -> URL {
        let tail = SdkKey.cacheKeyTail(key)
        return directory.appendingPathComponent("confeature-\(tail).json", isDirectory: false)
    }

    func read(forKey key: String) -> String? {
        let memoryHit = memoryFallback.read(forKey: key)
        if isInFallback() {
            return memoryHit
        }
        let url = fileURL(for: key)
        do {
            let data = try Data(contentsOf: url)
            if let text = String(data: data, encoding: .utf8) {
                return text
            }
            // Mirror to memory in case a subsequent write replaces it.
            return memoryHit
        } catch let error as NSError {
            // `NSCocoaErrorDomain` 260 = file does not exist; not an
            // error condition for read-before-first-write.
            if error.domain == NSCocoaErrorDomain && error.code == 260 {
                return memoryHit
            }
            logger.warning(
                "FilesystemCache.read: failed to load file (path=\(url.path), "
                    + "sdkKey=\(SdkKey.redact(sdkKeyForLog)), reason=\(error.localizedDescription))"
            )
            return memoryHit
        }
    }

    func write(value: String, forKey key: String) {
        // Mirror to memory first so a subsequent read after a failed
        // disk write still returns the entry.
        memoryFallback.write(value: value, forKey: key)
        if isInFallback() {
            return
        }

        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true, attributes: nil
            )
        } catch let error {
            triggerFallback("createDirectory: \(error.localizedDescription)")
            return
        }

        let url = fileURL(for: key)
        guard let data = value.data(using: .utf8) else {
            triggerFallback("encode value as UTF-8 failed")
            return
        }
        do {
            try data.write(to: url, options: .atomic)
        } catch let error {
            triggerFallback("write: \(error.localizedDescription)")
        }
    }

    private func isInFallback() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return inFallbackMode
    }

    private func triggerFallback(_ reason: String) {
        lock.lock()
        let wasAlreadyFallback = inFallbackMode
        inFallbackMode = true
        lock.unlock()
        if !wasAlreadyFallback {
            logger.warning(
                "FilesystemCache: filesystem unwritable; falling back to memory-only cache "
                    + "(path=\(directory.path), sdkKey=\(SdkKey.redact(sdkKeyForLog)), "
                    + "reason=\(reason))"
            )
        }
    }
}
