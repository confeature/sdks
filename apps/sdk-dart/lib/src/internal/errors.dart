// SPDX-License-Identifier: MIT

/// Internal evaluation errors. These are thrown WITHIN the evaluator and caught
/// by its outer fail-closed `catch (_) → EVAL_EXCEPTION` frame — they NEVER
/// escape to the SDK caller (FR-012). A [CircularDependencyError] is what
/// bounds an otherwise-unbounded prerequisite recursion (FR-007, SC-004).
library;

/// Thrown when a prerequisite-flag cycle is detected. The bounded second visit
/// throws this, converting an unbounded recursion into a fail-closed default.
class CircularDependencyError implements Exception {
  /// Construct with a human-readable cycle [message] and the bare [cycle]
  /// chain (no surrounding brackets) the ERROR 1002 trace renders as
  /// `[a -> b -> a]` (ADR 0003 / epic #494).
  const CircularDependencyError(this.message, [this.cycle = '']);

  /// The cycle chain, e.g. `a -> b -> a`.
  final String message;

  /// The bare `a -> b -> a` chain for the eval-log ERROR 1002 line.
  final String cycle;

  @override
  String toString() => 'CircularDependencyError: $message';
}

/// Thrown on a structurally malformed config reference (a missing prerequisite
/// flag, an out-of-range segment index, etc.). Caught by the fail-closed frame.
class MalformedConfigError implements Exception {
  /// Construct with a human-readable [message].
  const MalformedConfigError(this.message);

  /// The reason the config is malformed.
  final String message;

  @override
  String toString() => 'MalformedConfigError: $message';
}
