// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import io.confeature.client.ConfigCache;
import io.confeature.client.Logger;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Filesystem-backed {@link ConfigCache}.
 *
 * <p>Writes to {@code {dir}/confeature-{cacheKeyTail}.json} atomically: the payload lands in a
 * tempfile first, then {@link Files#move} renames it over the target with {@code REPLACE_EXISTING}
 * + {@code ATOMIC_MOVE}.
 *
 * <p>On the first {@link IOException} (read or write), the cache logs a single WARNING and switches
 * to memory-only mode for the remainder of the client lifetime — subsequent operations route
 * through an embedded {@link InMemoryCache} and never re-attempt the filesystem. Matches the Go /
 * .NET file-cache fallback behaviour (FR-014 + spec 037 §FR-012).
 *
 * <p>SDK key NEVER stored raw: the on-disk filename uses only the derived 32-char base64url tail.
 */
public final class FilesystemCache implements ConfigCache {

  /** Default cache directory inside {@code $HOME}. Matches the Python + Go layouts. */
  public static String defaultCacheDir() {
    final String home = System.getProperty("user.home");
    if (home == null || home.isEmpty()) {
      // Fall back to the working directory; the constructor handles
      // unwritable cases via the fallback path.
      return Paths.get(".confeature").toAbsolutePath().toString();
    }
    return Paths.get(home, ".cache", "confeature").toString();
  }

  private final Path directory;
  private final Logger logger;
  private final String sdkKey;
  private final InMemoryCache fallback = new InMemoryCache();
  private final AtomicBoolean memoryOnly = new AtomicBoolean(false);

  /**
   * Constructs a filesystem cache.
   *
   * @param directory cache directory; created lazily on first write.
   * @param sdkKey for redacted logging on fallback (never serialised).
   * @param logger non-null logger.
   */
  public FilesystemCache(Path directory, String sdkKey, Logger logger) {
    this.directory = Objects.requireNonNull(directory, "directory");
    this.sdkKey = Objects.requireNonNull(sdkKey, "sdkKey");
    this.logger = Objects.requireNonNull(logger, "logger");
  }

  /** Returns the on-disk path for a given cache key. */
  public Path resolveFilePath(String cacheKey) {
    final String tail = SdkKey.cacheKeyTail(cacheKey);
    return directory.resolve("confeature-" + tail + ".json");
  }

  @Override
  public String read(String cacheKey) {
    if (cacheKey == null) {
      return null;
    }
    if (memoryOnly.get()) {
      return fallback.read(cacheKey);
    }
    final Path path = resolveFilePath(cacheKey);
    try {
      if (!Files.exists(path)) {
        return fallback.read(cacheKey);
      }
      return new String(Files.readAllBytes(path), StandardCharsets.UTF_8);
    } catch (IOException ex) {
      engageFallback(path, ex);
      return fallback.read(cacheKey);
    }
  }

  @Override
  public void write(String cacheKey, String value) {
    if (cacheKey == null || value == null) {
      return;
    }
    // Mirror every write into memory first so a subsequent read after a
    // failed disk write still returns the entry.
    fallback.write(cacheKey, value);
    if (memoryOnly.get()) {
      return;
    }
    final Path path = resolveFilePath(cacheKey);
    // Thread.getId() is deprecated in JDK 19+ in favour of threadId(), but
    // the latter is unavailable on the JDK 11 baseline. Keep getId() and
    // suppress the warning — switch when the baseline moves.
    @SuppressWarnings("deprecation")
    final long threadId = Thread.currentThread().getId();
    final Path tmp = path.resolveSibling(path.getFileName().toString() + ".tmp." + threadId);
    try {
      Files.createDirectories(directory);
      Files.write(tmp, value.getBytes(StandardCharsets.UTF_8));
      try {
        Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
      } catch (AtomicMoveNotSupportedException atomicNotSupported) {
        // Some filesystems (e.g. cross-device tmpfs) don't support
        // ATOMIC_MOVE. Fall back to a non-atomic replace — still better
        // than failing the cache write entirely.
        Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING);
      }
    } catch (IOException ex) {
      tryDeleteQuietly(tmp);
      engageFallback(path, ex);
    }
  }

  private void engageFallback(Path path, IOException ex) {
    if (memoryOnly.compareAndSet(false, true)) {
      logger.warning(
          "FilesystemCache: filesystem unwritable at "
              + path
              + "; falling back to in-memory cache. sdkKey="
              + SdkKey.redact(sdkKey)
              + " reason="
              + ex.getMessage());
    }
  }

  private void tryDeleteQuietly(Path path) {
    try {
      Files.deleteIfExists(path);
    } catch (IOException ex) {
      // Best-effort cleanup — already in the failure path; another
      // IOException here is not actionable. We log at WARN so an
      // operator investigating disk pressure sees the residue and the
      // catch doesn't become a "silent catch" per the project rules.
      // The next successful write creates a fresh tempfile under a new
      // thread-id suffix.
      logger.warning(
          "FilesystemCache: residual tempfile cleanup failed at "
              + path
              + "; reason="
              + ex.getMessage());
    }
  }

  /** Visible for tests. */
  boolean isMemoryFallback() {
    return memoryOnly.get();
  }
}
