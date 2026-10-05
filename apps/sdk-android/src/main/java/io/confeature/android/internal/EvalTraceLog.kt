// SPDX-License-Identifier: MIT
package io.confeature.android.internal

/**
 * Evaluation-log trace surface (ADR 0003 / epic #494, Android slice of #501).
 *
 * The WARN / ERROR / INFO lines the federated evaluator emits during a trace, ported VERBATIM from
 * `packages/sdk-shared/src/logger.ts` (the `LoggerWrapper` helpers `userObjectIsMissing` /
 * `userObjectAttributeIsMissing` / `userObjectAttributeIsMissingForPercentage` /
 * `userObjectAttributeIsInvalid` / `comparisonValueIsInvalid` / `circularDependency`) and the INFO
 * 5000 trace emission point in `evaluator.ts` (Principle II — byte-identical to the canonical).
 * Transliterated from the Java port [io.confeature.client.internal.EvalTraceLog]; mirrors the Go /
 * Python / Rust / .NET ports.
 *
 * This trace-logging seam is intentionally distinct from the public [io.confeature.android.Logger]:
 * a customer-supplied logger has the error/warning/info/debug shape, while the trace test taps a
 * structured `(level, eventId, message)` recorder. Keeping them separate matches the federation
 * factoring and keeps the no-trace hot path zero-cost.
 */
internal class EvalTraceLog(private val inner: Sink?) {

    /**
     * Numeric log levels mirroring configcat-common's ordering (logger.ts `LogLevel`), so level
     * filtering ("Info and above") works identically across SDKs. Intentionally distinct from the
     * public [io.confeature.android.LogLevel] (the customer-facing enum) — this is the internal
     * capture-side ordering.
     */
    enum class Level(val rank: Int) {
        OFF(-1),
        ERROR(1),
        WARN(2),
        INFO(3),
        DEBUG(4),
    }

    /**
     * Captures the evaluator's structured log calls. Each call is one `(level, eventId, message)`
     * tuple; an INFO-enabled sink drives the eval-log trace (the multi-line INFO 5000 line) plus the
     * WARN/ERROR lines emitted during the walk. This is the seam the parity test taps to reconstruct
     * ConfigCat's byte-identical capture string.
     */
    interface Sink {
        /** Reports the configured threshold ([Level.INFO] enables tracing). */
        fun level(): Level

        /** Records one emitted line. */
        fun log(level: Level, eventId: String, message: String)
    }

    fun enabled(level: Level): Boolean {
        if (inner == null) return false
        val threshold = inner.level()
        if (threshold == Level.OFF) return false
        return level.rank <= threshold.rank
    }

    /** WARN 3001 (verbatim from logger.ts `userObjectIsMissing`). */
    fun userObjectIsMissing(key: String) {
        emit(
            Level.WARN,
            "3001",
            "cannot evaluate targeting rules and % options for setting '" +
                key +
                "' (User Object is missing); you should pass a User Object to the evaluation methods" +
                " like `getValue()` in order to make targeting work properly; read more:" +
                " https://configcat.com/docs/advanced/user-object/",
        )
    }

    /** WARN 3003 (verbatim from logger.ts `userObjectAttributeIsMissing`). */
    fun userObjectAttributeIsMissing(key: String, attributeName: String) {
        emit(
            Level.WARN,
            "3003",
            "cannot evaluate certain targeting rules of setting '" +
                key +
                "' (the User." +
                attributeName +
                " attribute is missing); you should set the User." +
                attributeName +
                " attribute in order to make targeting work properly; read more:" +
                " https://configcat.com/docs/advanced/user-object/",
        )
    }

    /** WARN 3003, % options variant (verbatim from logger.ts). */
    fun userObjectAttributeIsMissingForPercentage(key: String, attributeName: String) {
        emit(
            Level.WARN,
            "3003",
            "cannot evaluate % options for setting '" +
                key +
                "' (the User." +
                attributeName +
                " attribute is missing); you should set the User." +
                attributeName +
                " attribute in order to make targeting work properly; read more:" +
                " https://configcat.com/docs/advanced/user-object/",
        )
    }

    /** WARN 3004 (verbatim from logger.ts `userObjectAttributeIsInvalid`). */
    fun userObjectAttributeIsInvalid(key: String, attributeName: String, reason: String) {
        emit(
            Level.WARN,
            "3004",
            "cannot evaluate certain targeting rules of setting '" +
                key +
                "' (the User." +
                attributeName +
                " attribute is invalid (" +
                reason +
                ")); please check the User." +
                attributeName +
                " attribute and make sure that its value corresponds to the comparison operator",
        )
    }

    /**
     * WARN 3004, malformed config operand (#509). Note there is NO "please check the User.<attr>…"
     * suffix (verbatim from logger.ts `comparisonValueIsInvalid`). [innerMessage] is the full
     * `comparison value '<v>' is invalid (<reason>)` text.
     */
    fun comparisonValueIsInvalid(key: String, innerMessage: String) {
        emit(
            Level.WARN,
            "3004",
            "cannot evaluate certain targeting rules of setting '" + key + "' (" + innerMessage + ")",
        )
    }

    /** ERROR 1002 (verbatim from logger.ts `circularDependency`). */
    fun circularDependency(key: String, cycle: String) {
        emit(
            Level.ERROR,
            "1002",
            "failed to evaluate setting '" +
                key +
                "' (circular dependency detected between the following depending flags: [" +
                cycle +
                "])",
        )
    }

    /** INFO line (the 5000 trace). Mirrors logger.ts `LoggerWrapper.info`. */
    fun info(eventId: String, message: String) {
        emit(Level.INFO, eventId, message)
    }

    private fun emit(level: Level, eventId: String, message: String) {
        if (!enabled(level)) return
        inner?.log(level, eventId, message)
    }
}
