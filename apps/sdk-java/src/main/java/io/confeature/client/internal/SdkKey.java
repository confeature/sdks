// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * SDK-key format helpers + cache-key derivation.
 *
 * <p><b>SECURITY</b> (constitution security clause + spec 045 FR-013): SDK keys are secrets. They
 * MUST NEVER appear verbatim in any log line. Every log site that references the key MUST route
 * through {@link #redact(String)}.
 *
 * <p>The cache-key algorithm mirrors {@code packages/sdk-shared/src/sdk-key.ts}'s async {@code
 * deriveCacheKey} (SHA-256 → base64url → first 32 chars) plus the Python / Go / .NET / Rust / Ruby
 * ports. Cross-language fixture verification lives in {@code CacheKeyFixturesTest}.
 */
public final class SdkKey {

  /** Envelope prefix for derived cache keys — identical across every SDK. */
  public static final String CACHE_KEY_PREFIX = "confeature:cache:v1:";

  /**
   * Both Confeature SDK-key shapes (#802), mirroring {@code packages/sdk-shared/src/sdk-key.ts}:
   *
   * <ul>
   *   <li>{@code configcat-sdk-1/<22 url-safe chars>/<22 url-safe chars>} — minted today;
   *       ConfigCat's own shape, so a stock ConfigCat SDK accepts the key too.
   *   <li>{@code confeature-sdk-1-<32 url-safe chars>-<32 url-safe chars>} — minted before #802,
   *       still valid until the key is rotated.
   * </ul>
   */
  private static final Pattern CONFEATURE_SDK_KEY_PATTERN =
      Pattern.compile(
          "^(?:configcat-sdk-1/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{22}"
              + "|confeature-sdk-1-[A-Za-z0-9_-]{32}-[A-Za-z0-9_-]{32})$");

  private SdkKey() {
    // Utility class.
  }

  /**
   * Returns {@code true} iff {@code sdkKey} matches either Confeature SDK-key shape — the
   * ConfigCat-shaped {@code configcat-sdk-1/<22>/<22>} minted today, or the legacy {@code
   * confeature-sdk-1-<32>-<32>} (still accepted). The accept/reject cases every SDK tests against
   * live in {@code packages/test-fixtures-sdk-parity/fixtures/sdk-key-shapes.json}. A {@code false}
   * result does NOT cause the SDK to throw; it triggers an {@code INVALID_SDK_KEY} log line (which,
   * per the security clause, includes only the redacted form).
   */
  public static boolean isValidConfeatureKeyFormat(String sdkKey) {
    if (sdkKey == null) {
      return false;
    }
    return CONFEATURE_SDK_KEY_PATTERN.matcher(sdkKey).matches();
  }

  /**
   * Returns a privacy-preserving rendering of {@code sdkKey} for log output. NEVER returns the raw
   * key.
   *
   * <p>Strategy: keep ~10% of the key visible at each end (minimum 4 chars), mask the middle. For
   * short / unusual keys (&lt; 16 chars) and the empty string / {@code null}, fall back to a full
   * mask. Mirrors the TS / Python / Go / .NET ports byte-for-byte.
   *
   * <p>The key is treated as opaque text: a {@code /} in a ConfigCat-shaped key is just another
   * character. For that 61-char shape the head is {@code "config"} (no secret characters) and the
   * tail shows 6 secret characters — fewer than the 8 a legacy 82-char key shows.
   */
  public static String redact(String sdkKey) {
    if (sdkKey == null || sdkKey.length() < 16) {
      return "[redacted]";
    }
    final int visible = Math.max(4, sdkKey.length() / 10);
    final String head = sdkKey.substring(0, visible);
    final String tail = sdkKey.substring(sdkKey.length() - visible);
    return head + "…[redacted]…" + tail;
  }

  /**
   * Derives a stable, opaque cache key from {@code sdkKey}.
   *
   * <p>Format: {@code confeature:cache:v1:<base64url(sha256(sdkKey))[:32]>}.
   *
   * <p>Output is byte-identical to:
   *
   * <ul>
   *   <li>{@code packages/sdk-shared/src/sdk-key.ts::deriveCacheKey} (TS canonical).
   *   <li>{@code apps/sdk-python/.../sdk_key.py::derive_cache_key}.
   *   <li>{@code apps/sdk-go/internal/sdkkey/sdkkey.go::DeriveCacheKey}.
   *   <li>{@code apps/sdk-dotnet/.../SdkKey.cs::DeriveCacheKey}.
   * </ul>
   *
   * <p><b>SECURITY:</b> the SDK key is HASHED, never stored raw. Even an attacker with filesystem
   * access to the cache directory cannot read the SDK key from a written cache file's name.
   *
   * @throws NullPointerException when {@code sdkKey} is {@code null}.
   */
  public static String deriveCacheKey(String sdkKey) {
    if (sdkKey == null) {
      throw new NullPointerException("sdkKey");
    }
    try {
      final MessageDigest md = MessageDigest.getInstance("SHA-256");
      final byte[] hash = md.digest(sdkKey.getBytes(StandardCharsets.UTF_8));
      final String b64 = Base64.getUrlEncoder().withoutPadding().encodeToString(hash);
      return CACHE_KEY_PREFIX + b64.substring(0, 32);
    } catch (NoSuchAlgorithmException e) {
      // SHA-256 is mandated by every JRE since 1.4; the runtime that
      // omits it is broken. Surface as an unchecked error so callers
      // don't need to handle an impossible exception.
      throw new IllegalStateException("SHA-256 not available on this JVM", e);
    }
  }

  /**
   * Returns the 32-char base64url tail of a cache key (the part after the envelope prefix). A local
   * cache id only — the on-disk filename, so the cache directory never holds the raw key. It never
   * goes on the wire: the config URL carries the key itself, as ConfigCat's does (#803).
   */
  public static String cacheKeyTail(String cacheKey) {
    if (cacheKey == null) {
      throw new NullPointerException("cacheKey");
    }
    final int idx = cacheKey.lastIndexOf(':');
    if (idx < 0 || idx == cacheKey.length() - 1) {
      return cacheKey;
    }
    return cacheKey.substring(idx + 1);
  }
}
