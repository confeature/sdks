// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * The two hashes the ConfigCat decision engine needs (ported from {@code
 * packages/sdk-shared/src/hash.ts}, the spec-117 reference):
 *
 * <ul>
 *   <li><b>SHA-1, UNSALTED</b> for percentage bucketing — {@code parseInt(sha1(key +
 *       attr).substring(0,7), 16) % 100}.
 *   <li><b>SHA-256, SALTED</b> for sensitive comparators — {@code sha256(utf8(value) +
 *       utf8(configSalt) + utf8(contextSalt))}.
 * </ul>
 *
 * <p>Both use {@link MessageDigest} (JDK stdlib — no new dependency). {@link MessageDigest} is not
 * thread-safe, so a fresh instance is obtained per call. Output is lowercase hex, byte-identical to
 * the TS reference (and therefore to every other federated SDK).
 */
final class Hashing {

  private static final char[] HEX = "0123456789abcdef".toCharArray();

  private Hashing() {
    // Utility class.
  }

  /** Lowercase-hex-encode a byte array. */
  static String toHex(byte[] bytes) {
    final char[] out = new char[bytes.length * 2];
    for (int i = 0; i < bytes.length; i++) {
      final int b = bytes[i] & 0xff;
      out[i * 2] = HEX[b >>> 4];
      out[i * 2 + 1] = HEX[b & 0x0f];
    }
    return new String(out);
  }

  /** SHA-1 digest of {@code input} (UTF-8) as a 40-char lowercase hex string. */
  static String sha1(String input) {
    return digest("SHA-1", input.getBytes(StandardCharsets.UTF_8));
  }

  /** SHA-256 digest of {@code input} (UTF-8) as a 64-char lowercase hex string. */
  static String sha256(String input) {
    return digest("SHA-256", input.getBytes(StandardCharsets.UTF_8));
  }

  /** SHA-256 digest of raw {@code bytes} as a 64-char lowercase hex string. */
  static String sha256Bytes(byte[] bytes) {
    return digest("SHA-256", bytes);
  }

  private static String digest(String algorithm, byte[] bytes) {
    try {
      final MessageDigest md = MessageDigest.getInstance(algorithm);
      return toHex(md.digest(bytes));
    } catch (NoSuchAlgorithmException e) {
      // SHA-1 / SHA-256 are mandated by every JVM; this never fires.
      throw new IllegalStateException("Missing standard digest algorithm: " + algorithm, e);
    }
  }

  /**
   * Hash a user-attribute value for a <b>sensitive</b> comparator. Mirrors common-js {@code
   * hashComparisonValue}: {@code sha256(utf8(value) + utf8(configSalt) + utf8(contextSalt))}, no
   * separators, lowercase hex.
   *
   * @param value the user attribute value as text (after attribute conversion).
   * @param configSalt the top-level config salt ({@code config.p.s}).
   * @param contextSalt the per-evaluation discriminator — the setting key for a user condition, or
   *     the segment name for a segment condition.
   */
  static String hashComparisonValue(String value, String configSalt, String contextSalt) {
    return sha256(value + configSalt + contextSalt);
  }

  /**
   * Hash a UTF-8 byte slice for a sensitive startsWith/endsWith comparator (common-js {@code
   * hashComparisonValueSlice}): {@code sha256(sliceBytes ++ utf8(configSalt) ++
   * utf8(contextSalt))}. The slice is raw bytes (a byte-boundary cut of the attribute, which may
   * land mid-codepoint), so the hash runs over the concatenated byte sequence.
   */
  static String hashComparisonValueSlice(byte[] sliceUtf8, String configSalt, String contextSalt) {
    final byte[] saltBytes = configSalt.getBytes(StandardCharsets.UTF_8);
    final byte[] ctxBytes = contextSalt.getBytes(StandardCharsets.UTF_8);
    final byte[] buf = new byte[sliceUtf8.length + saltBytes.length + ctxBytes.length];
    System.arraycopy(sliceUtf8, 0, buf, 0, sliceUtf8.length);
    System.arraycopy(saltBytes, 0, buf, sliceUtf8.length, saltBytes.length);
    System.arraycopy(ctxBytes, 0, buf, sliceUtf8.length + saltBytes.length, ctxBytes.length);
    return sha256Bytes(buf);
  }

  /**
   * ConfigCat percentage bucket in {@code [0, 99]} for {@code key + attrValue} (common-js {@code
   * evaluatePercentageOptions}): {@code parseInt(sha1(key + attrValue).substring(0,7), 16) % 100}.
   * SHA-1, unsalted. 7 hex chars = 28 bits, well within a 64-bit parse.
   */
  static int percentageBucket(String key, String attrValue) {
    final String hex = sha1(key + attrValue).substring(0, 7);
    return (int) (Long.parseLong(hex, 16) % 100);
  }
}
