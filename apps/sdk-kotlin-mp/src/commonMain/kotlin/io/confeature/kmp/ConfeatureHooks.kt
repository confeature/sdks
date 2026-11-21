// SPDX-License-Identifier: MIT
package io.confeature.kmp

import io.confeature.kmp.internal.platform.isFatalError

/**
 * Subscribe to client lifecycle events. Mirrors `com.configcat.ConfigCatHooks` 1:1 at the public
 * API surface (constitution Principle II, epic #268).
 *
 * Four hook points map to the JS-family reference contract (clientReady, configChanged,
 * flagEvaluated, clientError). Listener registration uses plain `MutableList`s — matching the
 * `closedFlag` / `offlineFlag` discipline elsewhere in the KMP client (best-effort short-circuit
 * reads). Typical lifecycle: listeners are registered before the first `getValueDetails` / poll
 * iteration, so concurrent registration is not a real-world hazard. Exceptions thrown by
 * listeners are caught and logged — never escape to the emitter.
 *
 * Obtain via [ConfeatureClient.getHooks].
 */
public class ConfeatureHooks internal constructor(private val logger: Logger) {

    private val onClientReady: MutableList<() -> Unit> = mutableListOf()
    private val onConfigChanged: MutableList<(Map<String, Any?>) -> Unit> = mutableListOf()
    private val onFlagEvaluated: MutableList<(TypedEvaluationDetails<*>) -> Unit> = mutableListOf()
    private val onError: MutableList<(String) -> Unit> = mutableListOf()

    /** Subscribe to the first successful config load (cache hydration or HTTP fetch). */
    public fun addOnClientReady(listener: () -> Unit) {
        onClientReady.add(listener)
    }

    /** Subscribe to every new config (FETCHED status). Receives the settings map. */
    public fun addOnConfigChanged(listener: (Map<String, Any?>) -> Unit) {
        onConfigChanged.add(listener)
    }

    /** Subscribe to every [TypedEvaluationDetails] produced by `getValueDetails`. */
    public fun addOnFlagEvaluated(listener: (TypedEvaluationDetails<*>) -> Unit) {
        onFlagEvaluated.add(listener)
    }

    /** Subscribe to non-fatal SDK errors (HTTP failures, cache I/O, parse failures). */
    public fun addOnError(listener: (String) -> Unit) {
        onError.add(listener)
    }

    internal fun invokeOnClientReady(sanitizeFailure: Boolean = false) {
        for (listener in onClientReady.toList()) {
            invokeListener("onClientReady", sanitizeFailure) { listener() }
        }
    }

    internal fun invokeOnConfigChanged(settings: Map<String, Any?>, sanitizeFailure: Boolean = false) {
        for (listener in onConfigChanged.toList()) {
            invokeListener("onConfigChanged", sanitizeFailure) { listener(settings) }
        }
    }

    internal fun invokeOnFlagEvaluated(details: TypedEvaluationDetails<*>, sanitizeFailure: Boolean = false) {
        for (listener in onFlagEvaluated.toList()) {
            invokeListener("onFlagEvaluated", sanitizeFailure) { listener(details) }
        }
    }

    internal fun invokeOnError(message: String, sanitizeFailure: Boolean = false) {
        for (listener in onError.toList()) {
            invokeListener("onError", sanitizeFailure) { listener(message) }
        }
    }

    private inline fun invokeListener(name: String, sanitizeFailure: Boolean, listener: () -> Unit) {
        try {
            listener()
        } catch (failure: Throwable) {
            if (sanitizeFailure) {
                if (isFatalError(failure)) throw failure
                logger.reportProviderFailure("ConfeatureHooks: $name listener raised.")
            } else {
                if (failure !is Exception) throw failure
                logger.error("ConfeatureHooks: $name listener raised.", failure)
            }
        }
    }
}

/** Protect companion evaluation and background refresh from consumer logger failures. */
internal fun Logger.reportProviderFailure(message: String) {
    try {
        error(message)
    } catch (failure: Throwable) {
        if (isFatalError(failure)) throw failure
    }
}
