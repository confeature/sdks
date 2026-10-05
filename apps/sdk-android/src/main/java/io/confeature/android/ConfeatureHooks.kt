// SPDX-License-Identifier: MIT
package io.confeature.android

import java.util.concurrent.CopyOnWriteArrayList

/**
 * Subscribe to client lifecycle events. Mirrors `com.configcat.ConfigCatHooks` 1:1 at the public
 * API surface (constitution Principle II, epic #268).
 *
 * Four hook points map to the JS-family reference contract (clientReady, configChanged,
 * flagEvaluated, clientError). All `addOn*` methods are thread-safe; listeners fire on the thread
 * that produced the event (AutoPoll scheduler thread, evaluation caller thread, etc.). Exceptions
 * thrown by listeners are caught and logged — never escape to the emitter.
 *
 * Obtain via [ConfeatureClient.getHooks].
 */
public class ConfeatureHooks internal constructor(private val logger: Logger) {

    private val onClientReady = CopyOnWriteArrayList<Runnable>()
    private val onConfigChanged = CopyOnWriteArrayList<(Map<String, Any?>) -> Unit>()
    private val onFlagEvaluated = CopyOnWriteArrayList<(EvaluationDetails<*>) -> Unit>()
    private val onError = CopyOnWriteArrayList<(String) -> Unit>()

    /** Subscribe to the first successful config load (cache hydration or HTTP fetch). */
    public fun addOnClientReady(listener: Runnable) {
        onClientReady.add(listener)
    }

    /** Subscribe to every new config (FETCHED status). Receives the settings map. */
    public fun addOnConfigChanged(listener: (Map<String, Any?>) -> Unit) {
        onConfigChanged.add(listener)
    }

    /** Subscribe to every [EvaluationDetails] produced by `getValueDetails`. */
    public fun addOnFlagEvaluated(listener: (EvaluationDetails<*>) -> Unit) {
        onFlagEvaluated.add(listener)
    }

    /** Subscribe to non-fatal SDK errors (HTTP failures, cache I/O, parse failures). */
    public fun addOnError(listener: (String) -> Unit) {
        onError.add(listener)
    }

    internal fun invokeOnClientReady() {
        for (listener in onClientReady) {
            try {
                listener.run()
            } catch (ex: RuntimeException) {
                logger.error("ConfeatureHooks: onClientReady listener raised.", ex)
            }
        }
    }

    internal fun invokeOnConfigChanged(settings: Map<String, Any?>) {
        for (listener in onConfigChanged) {
            try {
                listener(settings)
            } catch (ex: RuntimeException) {
                logger.error("ConfeatureHooks: onConfigChanged listener raised.", ex)
            }
        }
    }

    internal fun invokeOnFlagEvaluated(details: EvaluationDetails<*>) {
        for (listener in onFlagEvaluated) {
            try {
                listener(details)
            } catch (ex: RuntimeException) {
                logger.error("ConfeatureHooks: onFlagEvaluated listener raised.", ex)
            }
        }
    }

    internal fun invokeOnError(message: String) {
        for (listener in onError) {
            try {
                listener(message)
            } catch (ex: RuntimeException) {
                logger.error("ConfeatureHooks: onError listener raised.", ex)
            }
        }
    }
}
