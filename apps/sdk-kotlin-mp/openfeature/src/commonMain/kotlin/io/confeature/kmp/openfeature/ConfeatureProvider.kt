// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature

import dev.openfeature.kotlin.sdk.EvaluationContext
import dev.openfeature.kotlin.sdk.FeatureProvider
import dev.openfeature.kotlin.sdk.Hook
import dev.openfeature.kotlin.sdk.ProviderEvaluation
import dev.openfeature.kotlin.sdk.ProviderMetadata
import dev.openfeature.kotlin.sdk.Reason
import dev.openfeature.kotlin.sdk.Value
import dev.openfeature.kotlin.sdk.exceptions.ErrorCode
import dev.openfeature.kotlin.sdk.exceptions.OpenFeatureError
import io.confeature.kmp.ConfeatureClient
import io.confeature.kmp.internal.ProviderResult
import io.confeature.kmp.internal.ProviderValueType
import kotlin.concurrent.atomics.AtomicBoolean
import kotlin.concurrent.atomics.ExperimentalAtomicApi

/** An OpenFeature adapter borrowing a caller-owned Confeature Kotlin Multiplatform client. */
@OptIn(ExperimentalAtomicApi::class)
public class ConfeatureProvider(private val client: ConfeatureClient) : FeatureProvider {
    override val metadata: ProviderMetadata = Metadata
    override val hooks: List<Hook<*>> = emptyList()

    private val retired = AtomicBoolean(false)

    override suspend fun initialize(initialContext: EvaluationContext?) {
        checkActive()
    }

    override suspend fun onContextSet(oldContext: EvaluationContext?, newContext: EvaluationContext) {
        checkActive()
    }

    override fun shutdown() {
        retired.store(true)
    }

    override fun getBooleanEvaluation(key: String, defaultValue: Boolean, context: EvaluationContext?) =
        resolve(key, defaultValue, context, ProviderValueType.BOOLEAN) { it as? Boolean }

    override fun getStringEvaluation(key: String, defaultValue: String, context: EvaluationContext?) =
        resolve(key, defaultValue, context, ProviderValueType.STRING) { it as? String }

    override fun getIntegerEvaluation(key: String, defaultValue: Int, context: EvaluationContext?) =
        resolve(key, defaultValue, context, ProviderValueType.INTEGER) { it as? Int }

    override fun getLongEvaluation(key: String, defaultValue: Long, context: EvaluationContext?) =
        resolve(key, defaultValue, context, ProviderValueType.INTEGER) { (it as? Int)?.toLong() }

    override fun getDoubleEvaluation(key: String, defaultValue: Double, context: EvaluationContext?) =
        resolve(key, defaultValue, context, ProviderValueType.DOUBLE) { it as? Double }

    override fun getObjectEvaluation(
        key: String,
        defaultValue: Value,
        context: EvaluationContext?,
    ): ProviderEvaluation<Value> =
        fail(if (retired.load()) ErrorCode.PROVIDER_NOT_READY else ErrorCode.TYPE_MISMATCH)

    private inline fun <T : Any> resolve(
        key: String,
        fallback: T,
        context: EvaluationContext?,
        type: ProviderValueType,
        valueOf: (Any?) -> T?,
    ): ProviderEvaluation<T> {
        if (retired.load()) fail(ErrorCode.PROVIDER_NOT_READY)
        val user = try {
            OpenFeatureUser.from(context)
        } catch (_: Exception) {
            fail(ErrorCode.INVALID_CONTEXT)
        }

        val details = client.getValueDetailsForProvider(key, fallback, user, type)
        val error = when (details.status) {
            ProviderResult.Status.RESOLVED -> null
            ProviderResult.Status.NOT_READY -> ErrorCode.PROVIDER_NOT_READY
            ProviderResult.Status.NOT_FOUND -> ErrorCode.FLAG_NOT_FOUND
            ProviderResult.Status.TYPE_MISMATCH -> ErrorCode.TYPE_MISMATCH
            ProviderResult.Status.PARSE_ERROR -> ErrorCode.PARSE_ERROR
            ProviderResult.Status.GENERAL -> ErrorCode.GENERAL
        }
        if (error != null) fail(error)

        val value = valueOf(details.value) ?: fail(ErrorCode.TYPE_MISMATCH)
        val reason = when (details.match) {
            ProviderResult.Match.PERCENTAGE_OPTION -> Reason.SPLIT.name
            ProviderResult.Match.TARGETING_RULE -> Reason.TARGETING_MATCH.name
            null -> null
        }
        return ProviderEvaluation(value, variant = details.variationId, reason = reason)
    }

    private fun checkActive() {
        if (retired.load()) throw OpenFeatureError.ProviderNotReadyError(NOT_READY)
    }

    private object Metadata : ProviderMetadata {
        override val name: String = "Confeature"
    }

    private companion object {
        const val NOT_READY = "The Confeature provider is not ready."

        // The official client uses exceptions to run error hooks and supply its caller's fallback.
        fun fail(error: ErrorCode): Nothing = throw when (error) {
            ErrorCode.PROVIDER_NOT_READY -> OpenFeatureError.ProviderNotReadyError(NOT_READY)
            ErrorCode.FLAG_NOT_FOUND -> OpenFeatureError.FlagNotFoundError(null, "The Confeature flag was not found.")
            ErrorCode.TYPE_MISMATCH -> OpenFeatureError.TypeMismatchError("The Confeature flag type does not match.")
            ErrorCode.PARSE_ERROR -> OpenFeatureError.ParseError("The Confeature configuration could not be evaluated.")
            ErrorCode.INVALID_CONTEXT -> OpenFeatureError.InvalidContextError("The OpenFeature evaluation context is invalid.")
            else -> OpenFeatureError.GeneralError("The Confeature evaluation failed.")
        }
    }
}
