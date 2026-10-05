// SPDX-License-Identifier: MIT

/// Internal trace logger threaded through the evaluation context (ADR 0003 /
/// epic #494, Dart slice of #501). Mirrors logger.ts `LoggerWrapper` and the
/// PHP `TraceLog` / `TraceSink` / `TraceLevel`: a null inner sink means tracing
/// is off (zero cost), and every helper is level-gated at the boundary.
///
/// The WARN / ERROR / INFO strings are ported VERBATIM from
/// `packages/sdk-shared/src/logger.ts` (Principle II — byte-identical to the
/// canonical), cross-checked against the Python / Ruby / Go / PHP ports. The
/// capture format the parity test reconstructs is
/// `"<LEVEL>: [<eventId>] <message>"` per emitted call, joined by "\n", with the
/// INFO 5000 entry carrying the multi-line indented trace.
///
/// Intentionally distinct from the public `Logger`: a customer-supplied logger
/// has the `error/warning/info/debug` shape, while this trace seam taps a
/// structured `(level, eventId, message)` recorder. Keeping them separate
/// mirrors the Python / Ruby / Go / PHP factoring and keeps the no-trace hot
/// path zero-cost.
library;

/// Trace-level constants mirroring configcat-common's numeric ordering
/// (logger.ts `LogLevel`). Level filtering ("Info and above") works identically
/// across SDKs. Distinct from the public `LogLevel` (stdlib ordering), used ONLY
/// for the eval-log trace seam (ADR 0003) so the gating matches the canonical
/// reference exactly.
abstract final class TraceLevel {
  /// Logging disabled.
  static const int off = -1;

  /// Error level.
  static const int error = 1;

  /// Warning level.
  static const int warn = 2;

  /// Informational level (the 5000 trace).
  static const int info = 3;

  /// Debug level.
  static const int debug = 4;
}

/// Captures the evaluator's structured log calls (ADR 0003). Each call is one
/// `(level, eventId, message)` tuple; an INFO-enabled sink drives the eval-log
/// trace (the multi-line INFO 5000 line) plus the WARN / ERROR lines emitted
/// during the walk. This is the seam the parity test taps to reconstruct
/// ConfigCat's byte-identical capture string.
abstract class TraceSink {
  /// Report the configured threshold (a [TraceLevel] value).
  int level();

  /// Record one emitted line.
  void log(int level, String eventId, String message);
}

/// Level-gated adapter around an optional [TraceSink]. A null sink (the hot
/// path) makes [enabled] always false, so the evaluator never builds the trace.
class TraceLog {
  /// Construct with an optional inner sink. A null sink disables tracing.
  TraceLog([this._inner]);

  final TraceSink? _inner;

  /// True iff the inner sink is attached and would emit at [level].
  bool enabled(int level) {
    final inner = _inner;
    if (inner == null) return false;
    final threshold = inner.level();
    if (threshold == TraceLevel.off) return false;
    return level <= threshold;
  }

  /// WARN 3001 (verbatim from logger.ts `userObjectIsMissing`).
  void userObjectIsMissing(String key) {
    _emit(
      TraceLevel.warn,
      '3001',
      "cannot evaluate targeting rules and % options for setting '$key' "
          '(User Object is missing); you should pass a User Object to the '
          'evaluation methods like `getValue()` in order to make targeting work '
          'properly; read more: https://configcat.com/docs/advanced/user-object/',
    );
  }

  /// WARN 3003 (verbatim from logger.ts `userObjectAttributeIsMissing`).
  void userObjectAttributeIsMissing(String key, String attributeName) {
    _emit(
      TraceLevel.warn,
      '3003',
      "cannot evaluate certain targeting rules of setting '$key' "
          '(the User.$attributeName attribute is missing); you should set the '
          'User.$attributeName attribute in order to make targeting work properly; '
          'read more: https://configcat.com/docs/advanced/user-object/',
    );
  }

  /// WARN 3003, % options variant (verbatim from logger.ts).
  void userObjectAttributeIsMissingForPercentage(
      String key, String attributeName) {
    _emit(
      TraceLevel.warn,
      '3003',
      "cannot evaluate % options for setting '$key' "
          '(the User.$attributeName attribute is missing); you should set the '
          'User.$attributeName attribute in order to make targeting work properly; '
          'read more: https://configcat.com/docs/advanced/user-object/',
    );
  }

  /// WARN 3004 (verbatim from logger.ts `userObjectAttributeIsInvalid`).
  void userObjectAttributeIsInvalid(
      String key, String attributeName, String reason) {
    _emit(
      TraceLevel.warn,
      '3004',
      "cannot evaluate certain targeting rules of setting '$key' "
          '(the User.$attributeName attribute is invalid ($reason)); please check '
          'the User.$attributeName attribute and make sure that its value '
          'corresponds to the comparison operator',
    );
  }

  /// WARN 3004, malformed config operand (#509). Note there is NO "please check
  /// the User.<attr>…" suffix (verbatim from logger.ts `comparisonValueIsInvalid`).
  /// [innerMessage] is the full `comparison value '<v>' is invalid (<reason>)`.
  void comparisonValueIsInvalid(String key, String innerMessage) {
    _emit(
      TraceLevel.warn,
      '3004',
      "cannot evaluate certain targeting rules of setting '$key' "
          '($innerMessage)',
    );
  }

  /// ERROR 1002 (verbatim from logger.ts `circularDependency`).
  void circularDependency(String key, String cycle) {
    _emit(
      TraceLevel.error,
      '1002',
      "failed to evaluate setting '$key' (circular dependency detected between "
          'the following depending flags: [$cycle])',
    );
  }

  /// INFO line (the 5000 trace). Mirrors logger.ts `LoggerWrapper.info`.
  void info(String eventId, String message) {
    _emit(TraceLevel.info, eventId, message);
  }

  void _emit(int level, String eventId, String message) {
    if (!enabled(level)) return;
    _inner?.log(level, eventId, message);
  }
}
