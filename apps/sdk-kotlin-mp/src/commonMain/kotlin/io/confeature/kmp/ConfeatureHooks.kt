// SPDX-License-Identifier: MIT
package io.confeature.kmp

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

    internal fun invokeOnClientReady() {
        for (listener in onClientReady.toList()) {
            try {
                listener()
            } catch (ex: Exception) {
                logger.error("ConfeatureHooks: onClientReady listener raised.", ex)
            }
        }
    }

    internal fun invokeOnConfigChanged(settings: Map<String, Any?>) {
        for (listener in onConfigChanged.toList()) {
            try {
                listener(settings)
            } catch (ex: Exception) {
                logger.error("ConfeatureHooks: onConfigChanged listener raised.", ex)
            }
        }
    }

    internal fun invokeOnFlagEvaluated(details: TypedEvaluationDetails<*>) {
        for (listener in onFlagEvaluated.toList()) {
            try {
                listener(details)
            } catch (ex: Exception) {
                logger.error("ConfeatureHooks: onFlagEvaluated listener raised.", ex)
            }
        }
    }

    internal fun invokeOnError(message: String) {
        for (listener in onError.toList()) {
            try {
                listener(message)
            } catch (ex: Exception) {
                logger.error("ConfeatureHooks: onError listener raised.", ex)
            }
        }
    }
}
