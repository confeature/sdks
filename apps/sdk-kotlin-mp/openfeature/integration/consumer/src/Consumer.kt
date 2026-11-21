// SPDX-License-Identifier: MIT
package io.confeature.kmp.openfeature.consumer

import dev.openfeature.kotlin.sdk.ImmutableContext
import dev.openfeature.kotlin.sdk.OpenFeatureAPI
import io.confeature.kmp.ConfeatureClient
import io.confeature.kmp.FlagOverrides
import io.confeature.kmp.MapOverrideDataSource
import io.confeature.kmp.openfeature.ConfeatureProvider

suspend fun main() {
    val sdk = ConfeatureClient
        .builder("configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB")
        .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("checkout" to true))))
        .build()

    try {
        OpenFeatureAPI.setProviderAndWait(ConfeatureProvider(sdk))
        OpenFeatureAPI.setEvaluationContextAndWait(ImmutableContext("fixture-user"))
        check(OpenFeatureAPI.getClient().getBooleanValue("checkout", false))
    } finally {
        try {
            OpenFeatureAPI.shutdown()
        } finally {
            sdk.close()
        }
    }
}
