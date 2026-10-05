// SPDX-License-Identifier: MIT

/// Pluggable logger surface for the Confeature Dart SDK.
///
/// Customers integrate by either:
///   - keeping the default [StderrLogger] (writes to `stderr` via
///     `print`-style I/O) and filtering via [LogLevel], or
///   - implementing the [Logger] abstract class and passing the instance
///     via the client's `logger:` constructor arg.
///
/// Mirrors `configcat_client`'s `ConfigCatLogger` surface (constitution
/// Principle II).
library;

import 'dart:io';

import 'log_level.dart';

/// Abstract logger surface. Every log site in the SDK calls into one
/// of these four methods; the SDK key is NEVER passed verbatim — every
/// site routes through `internal/sdk_key.dart::redactSdkKey` first
/// (constitution security clause).
abstract class Logger {
  /// Default constructor for subclasses.
  const Logger();

  /// Emit a debug-level message.
  void debug(String message);

  /// Emit an info-level message.
  void info(String message);

  /// Emit a warning-level message.
  void warning(String message);

  /// Emit an error-level message.
  void error(String message);
}

/// Default logger: writes filtered messages to `stderr` with a level
/// prefix. Off by default below [LogLevel.warning] so production logs
/// stay clean.
class StderrLogger extends Logger {
  /// Construct with an optional level floor. Messages below the floor
  /// are silently dropped.
  StderrLogger({this.level = LogLevel.warning});

  /// Minimum severity that produces output.
  final LogLevel level;

  void _emit(LogLevel messageLevel, String message) {
    if (level == LogLevel.off) return;
    if (messageLevel.severity < level.severity) return;
    // Writing to stderr keeps SDK chatter off stdout, where customers
    // wire their own product output.
    stderr.writeln('[confeature/${messageLevel.name}] $message');
  }

  @override
  void debug(String message) => _emit(LogLevel.debug, message);

  @override
  void info(String message) => _emit(LogLevel.info, message);

  @override
  void warning(String message) => _emit(LogLevel.warning, message);

  @override
  void error(String message) => _emit(LogLevel.error, message);
}

/// Convenience factory: returns a [StderrLogger] at [LogLevel.warning].
Logger defaultLogger() => StderrLogger();
