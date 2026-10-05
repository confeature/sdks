// SPDX-License-Identifier: MIT
package io.confeature.client.internal;

/**
 * Evaluation-log trace surface (ADR 0003 / epic #494, Java slice of #501).
 *
 * <p>The WARN / ERROR / INFO lines the federated evaluator emits during a trace, ported VERBATIM
 * from {@code packages/sdk-shared/src/logger.ts} (the {@code LoggerWrapper} helpers {@code
 * userObjectIsMissing} / {@code userObjectAttributeIsMissing} / {@code
 * userObjectAttributeIsMissingForPercentage} / {@code userObjectAttributeIsInvalid} / {@code
 * comparisonValueIsInvalid} / {@code circularDependency}) and the INFO 5000 trace emission point in
 * {@code evaluator.ts} (Principle II — byte-identical to the canonical). Mirrors the Go / Python /
 * Rust / .NET ports.
 *
 * <p>This trace-logging seam is intentionally distinct from the public {@link
 * io.confeature.client.Logger}: a customer-supplied logger has the error/warning/info/debug shape,
 * while the trace test taps a structured {@code (level, eventId, message)} recorder. Keeping them
 * separate matches the federation factoring and keeps the no-trace hot path zero-cost.
 */
final class EvalTraceLog {

  /**
   * Numeric log levels mirroring configcat-common's ordering (logger.ts {@code LogLevel}), so level
   * filtering ("Info and above") works identically across SDKs. Intentionally distinct from the
   * public {@link io.confeature.client.LogLevel} (the customer-facing enum) — this is the internal
   * capture-side ordering.
   */
  enum Level {
    OFF(-1),
    ERROR(1),
    WARN(2),
    INFO(3),
    DEBUG(4);

    final int rank;

    Level(int rank) {
      this.rank = rank;
    }
  }

  /**
   * Captures the evaluator's structured log calls. Each call is one {@code (level, eventId,
   * message)} tuple; an INFO-enabled sink drives the eval-log trace (the multi-line INFO 5000 line)
   * plus the WARN/ERROR lines emitted during the walk. This is the seam the parity test taps to
   * reconstruct ConfigCat's byte-identical capture string.
   */
  interface Sink {
    /** Reports the configured threshold ({@link Level#INFO} enables tracing). */
    Level level();

    /** Records one emitted line. */
    void log(Level level, String eventId, String message);
  }

  private final Sink inner;

  EvalTraceLog(Sink inner) {
    this.inner = inner;
  }

  boolean enabled(Level level) {
    if (inner == null) {
      return false;
    }
    final Level threshold = inner.level();
    if (threshold == Level.OFF) {
      return false;
    }
    return level.rank <= threshold.rank;
  }

  /** WARN 3001 (verbatim from logger.ts {@code userObjectIsMissing}). */
  void userObjectIsMissing(String key) {
    emit(
        Level.WARN,
        "3001",
        "cannot evaluate targeting rules and % options for setting '"
            + key
            + "' (User Object is missing); you should pass a User Object to the evaluation methods"
            + " like `getValue()` in order to make targeting work properly; read more:"
            + " https://configcat.com/docs/advanced/user-object/");
  }

  /** WARN 3003 (verbatim from logger.ts {@code userObjectAttributeIsMissing}). */
  void userObjectAttributeIsMissing(String key, String attributeName) {
    emit(
        Level.WARN,
        "3003",
        "cannot evaluate certain targeting rules of setting '"
            + key
            + "' (the User."
            + attributeName
            + " attribute is missing); you should set the User."
            + attributeName
            + " attribute in order to make targeting work properly; read more:"
            + " https://configcat.com/docs/advanced/user-object/");
  }

  /** WARN 3003, % options variant (verbatim from logger.ts). */
  void userObjectAttributeIsMissingForPercentage(String key, String attributeName) {
    emit(
        Level.WARN,
        "3003",
        "cannot evaluate % options for setting '"
            + key
            + "' (the User."
            + attributeName
            + " attribute is missing); you should set the User."
            + attributeName
            + " attribute in order to make targeting work properly; read more:"
            + " https://configcat.com/docs/advanced/user-object/");
  }

  /** WARN 3004 (verbatim from logger.ts {@code userObjectAttributeIsInvalid}). */
  void userObjectAttributeIsInvalid(String key, String attributeName, String reason) {
    emit(
        Level.WARN,
        "3004",
        "cannot evaluate certain targeting rules of setting '"
            + key
            + "' (the User."
            + attributeName
            + " attribute is invalid ("
            + reason
            + ")); please check the User."
            + attributeName
            + " attribute and make sure that its value corresponds to the comparison operator");
  }

  /**
   * WARN 3004, malformed config operand (#509). Note there is NO "please check the
   * User.&lt;attr&gt;…" suffix (verbatim from logger.ts {@code comparisonValueIsInvalid}). {@code
   * innerMessage} is the full {@code comparison value '<v>' is invalid (<reason>)} text.
   */
  void comparisonValueIsInvalid(String key, String innerMessage) {
    emit(
        Level.WARN,
        "3004",
        "cannot evaluate certain targeting rules of setting '" + key + "' (" + innerMessage + ")");
  }

  /** ERROR 1002 (verbatim from logger.ts {@code circularDependency}). */
  void circularDependency(String key, String cycle) {
    emit(
        Level.ERROR,
        "1002",
        "failed to evaluate setting '"
            + key
            + "' (circular dependency detected between the following depending flags: ["
            + cycle
            + "])");
  }

  /** INFO line (the 5000 trace). Mirrors logger.ts {@code LoggerWrapper.info}. */
  void info(String eventId, String message) {
    emit(Level.INFO, eventId, message);
  }

  private void emit(Level level, String eventId, String message) {
    if (!enabled(level)) {
      return;
    }
    inner.log(level, eventId, message);
  }
}
