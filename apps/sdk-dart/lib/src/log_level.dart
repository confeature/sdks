// SPDX-License-Identifier: MIT

/// Confeature log severity.
///
/// Integer ordinals mirror the Java SDK's `Level` enum: lower number ==
/// more verbose. The default [Logger] floor is [warning] — see
/// `logger.dart`.
library;

/// SDK log severity.
///
/// Customers who plug a custom [Logger] implementation in via the
/// client constructor MUST honour the level filter themselves; the
/// default `StderrLogger` filters based on this enum's ordinal.
enum LogLevel {
  /// Internal debug messages — typically off in production.
  debug(10),

  /// Informational messages — fetched config metadata, polling cadence.
  info(20),

  /// Operationally-actionable warnings — INVALID_SDK_KEY, fetch
  /// failures, cache fallbacks.
  warning(30),

  /// Hard errors — non-2xx CDN responses, evaluation exceptions.
  error(40),

  /// All logging disabled.
  off(100);

  /// Construct a level with its severity ordinal.
  const LogLevel(this.severity);

  /// Severity ordinal — lower = more verbose, matches stdlib `logging`
  /// in Python + slf4j in Java for cross-runtime intuition.
  final int severity;
}
