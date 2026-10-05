// SPDX-License-Identifier: MIT
package io.confeature.client;

/**
 * Logging verbosity selector. Matches ConfigCat's Java SDK {@code com.configcat.LogLevel} 1:1
 * (constitution Principle II).
 *
 * <p>Mapped onto SLF4J levels by the bundled default {@link Logger} implementation.
 */
public enum LogLevel {
  /** No logging. */
  OFF,
  /** Error-level only. */
  ERROR,
  /** Warning + error. */
  WARNING,
  /** Info + warning + error. */
  INFO,
  /** Debug + info + warning + error (everything). */
  DEBUG
}
