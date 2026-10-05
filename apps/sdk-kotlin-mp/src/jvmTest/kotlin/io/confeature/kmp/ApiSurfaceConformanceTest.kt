// SPDX-License-Identifier: MIT
package io.confeature.kmp

import com.configcat.ConfigCatClient
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Spec 069 US3 — API-surface conformance test for `sdk-kotlin-mp`.
 *
 * Reflects over the official ConfigCat Kotlin SDK (`com.configcat.ConfigCatClient`, pinned via a
 * `jvmTest` dependency in `build.gradle.kts`) and the Confeature [ConfeatureClient], and asserts
 * that the Confeature client's public surface is a conforming superset of ConfigCat's `suspend`
 * core evaluation surface — a consumer migrating from `configcat-kotlin-client` changes only the
 * base URL, and every core method they reference still resolves.
 *
 * ConfigCat's Kotlin client exposes `getValue` as a top-level extension function on
 * `ConfigCatClient` (the interface itself declares `getAnyValue`); Confeature declares `getValue`
 * as a real member. The conformance bar is the consumer-facing `getValue` name, which both
 * surfaces honour.
 *
 * **KNOWN DIVERGENCE (#264 / #266..#269).** Epic #264's audit found five JVM API-surface gaps
 * versus ConfigCat. Spec 069 is SPLIT-scoped (research §R0) — typed-value parity + this
 * conformance test only; the corrections are DEFERRED to the #266-#269 follow-on. Each gap below
 * is asserted as a drift-guard: the method is currently ABSENT on [ConfeatureClient], and the
 * assertion fails loudly the day the follow-on adds it — at which point this test is updated to
 * assert presence + conformance.
 *
 * - `getValueDetails` — #266 — landed spec 082.
 * - `getAnyValueDetails` — #266 (tracked separately).
 * - `getAllValues` — #266 — landed spec 082.
 * - `getAllValueDetails` — #266 (tracked separately).
 * - `setOnline` / `setOffline` / `isOffline` — #267.
 * - the hooks / events surface (`getHooks`) — #268.
 *
 * **Spec 077 / #269 — client-level `getAllKeys` landed.** The drift-guard for `getAllKeys` was
 * moved to the conforming list (see `confeatureClientCarriesClientLevelGetAllKeys`).
 *
 * **Spec 082 / #266 slice 4/12 — `getValueDetails` + `getAllValues` landed.** Their drift-guards
 * were moved to dedicated presence assertions (see `confeatureClientCarriesGetValueDetails` and
 * `confeatureClientCarriesGetAllValues`). Both methods are `suspend` (trailing `Continuation`
 * parameter) — matches upstream's KMP signature.
 *
 * Reflection only — no network, no client instantiation.
 */
class ApiSurfaceConformanceTest {

    private fun publicMethodNames(type: Class<*>): Set<String> =
        type.methods
            .filter { it.declaringClass != Any::class.java }
            .map { it.name }
            .toSet()

    @Test
    fun officialConfigCatSdkIsOnTheTestClasspath() {
        // Sanity guard — the reflective comparison is meaningless if the official SDK failed to
        // resolve. ConfigCatClient is the official client interface the conformance reflects.
        assertTrue(
            ConfigCatClient::class.java.name == "com.configcat.ConfigCatClient",
            "ConfigCat's ConfigCatClient must resolve from the jvmTest classpath",
        )
    }

    @Test
    fun confeatureClientCoversConfigCatCoreEvaluationSurface() {
        // ConfigCat's ConfigCatClient interface declares forceRefresh / snapshot / close directly;
        // getValue is a top-level extension (the consumer-facing resolver name). Confeature must
        // expose all four core names as members.
        val confeature = publicMethodNames(ConfeatureClient::class.java)
        val configcatInterface = publicMethodNames(ConfigCatClient::class.java)

        for (core in listOf("forceRefresh", "snapshot", "close")) {
            assertContains(
                configcatInterface,
                core,
                "ConfigCat's ConfigCatClient interface is expected to declare $core",
            )
            assertContains(
                confeature,
                core,
                "ConfeatureClient MUST expose ConfigCat's core method $core " +
                    "(Principle II — drop-in compatibility)",
            )
        }
        // getValue is ConfigCat's consumer-facing resolver (a ConfigCatClientKt extension);
        // Confeature exposes it as a real member.
        assertContains(
            confeature,
            "getValue",
            "ConfeatureClient MUST expose the getValue resolver ConfigCat consumers call",
        )
    }

    @Test
    fun confeatureGetValueIsSuspendLikeConfigCat() {
        // ConfigCat's Kotlin getValue resolver is a suspend function; the Confeature KMP
        // getValue MUST also be suspend so a migrating consumer's coroutine call site is
        // unchanged. Kotlin compiles a suspend function with a trailing Continuation parameter.
        val getValue = ConfeatureClient::class.java.methods.first { it.name == "getValue" }
        val params = getValue.parameterTypes
        assertTrue(
            params.isNotEmpty() &&
                params.last().name == "kotlin.coroutines.Continuation",
            "ConfeatureClient.getValue MUST be a suspend function (trailing Continuation) — " +
                "ConfigCat's Kotlin getValue is suspend",
        )
    }

    @Test
    fun confeatureClientCarriesClientLevelGetAllKeys() {
        // Spec 077 / #269 — client-level getAllKeys() is now present on ConfeatureClient. Upstream
        // ConfigCat's KMP signature is `suspend fun getAllKeys(): Collection<String>`; Confeature
        // mirrors the same shape so a migrating consumer's coroutine call site compiles unchanged
        // (Principle II — drop-in compatibility).
        val confeature = publicMethodNames(ConfeatureClient::class.java)
        val configcatInterface = publicMethodNames(ConfigCatClient::class.java)

        assertContains(
            configcatInterface,
            "getAllKeys",
            "ConfigCat's ConfigCatClient KMP interface is expected to declare getAllKeys",
        )
        assertContains(
            confeature,
            "getAllKeys",
            "ConfeatureClient MUST expose getAllKeys (Principle II — drop-in compatibility)",
        )

        // Confeature's getAllKeys MUST be suspend (trailing Continuation parameter), matching
        // ConfigCat's KMP shape.
        val getAllKeys = ConfeatureClient::class.java.methods.first { it.name == "getAllKeys" }
        val params = getAllKeys.parameterTypes
        assertTrue(
            params.isNotEmpty() &&
                params.last().name == "kotlin.coroutines.Continuation",
            "ConfeatureClient.getAllKeys MUST be a suspend function (trailing Continuation) — " +
                "ConfigCat's KMP getAllKeys is suspend",
        )
    }

    @Test
    fun confeatureClientCarriesConfigCatFactory() {
        // ConfigCat constructs via the top-level ConfigCatClient(sdkKey) { } factory; Confeature
        // mirrors construction with the create(sdkKey) / builder(sdkKey) companion factories.
        val companionMethods = ConfeatureClient.Companion::class.java.methods.map { it.name }.toSet()
        assertContains(
            companionMethods,
            "create",
            "ConfeatureClient.Companion MUST expose a create(sdkKey) factory",
        )
        assertContains(
            companionMethods,
            "builder",
            "ConfeatureClient.Companion MUST expose a builder(sdkKey) factory",
        )
    }

    @Test
    fun confeatureClientCarriesGetValueDetails() {
        // Spec 082 / #266 slice 4/12 — getValueDetails(String, Any?, User?) is now present on
        // ConfeatureClient, returning the upstream-aligned TypedEvaluationDetails envelope. Both
        // the name (`TypedEvaluationDetails`, NOT `EvaluationDetails`) and the suspend shape
        // mirror upstream `com.configcat.ConfigCatClient#getValueDetails` (Principle II —
        // drop-in compatibility; memory feedback "Copy ConfigCat at maximum").
        val confeature = publicMethodNames(ConfeatureClient::class.java)
        assertContains(
            confeature,
            "getValueDetails",
            "ConfeatureClient MUST expose getValueDetails (Principle II — drop-in compatibility)",
        )

        // Confeature's getValueDetails MUST be suspend — the trailing parameter on the JVM-mangled
        // signature is `kotlin.coroutines.Continuation`. ConfigCat's KMP getValueDetails is
        // suspend, so a migrating consumer's coroutine call site MUST compile unchanged.
        val getValueDetails = ConfeatureClient::class.java.methods.first { it.name == "getValueDetails" }
        val params = getValueDetails.parameterTypes
        assertTrue(
            params.isNotEmpty() &&
                params.last().name == "kotlin.coroutines.Continuation",
            "ConfeatureClient.getValueDetails MUST be a suspend function (trailing Continuation) " +
                "— ConfigCat's KMP getValueDetails is suspend",
        )
        assertTrue(
            getValueDetails.returnType == Any::class.java,
            "ConfeatureClient.getValueDetails MUST return the suspend-erased Any (Kotlin compiles" +
                " suspend return types to Any) — got ${getValueDetails.returnType}",
        )

        // NOTE on upstream: ConfigCat's KMP `getValueDetails<T>` is a typed EXTENSION on
        // `ConfigCatClient` (compiled to `com.configcat.ConfigCatClientKt`), not a member —
        // same pattern as `getValue` (see `confeatureGetValueIsSuspendLikeConfigCat` above).
        // We deliberately do NOT assert presence on `ConfigCatClient::class.java.methods`
        // because it would fail by reflection-shape — the consumer-facing call site
        // `client.getValueDetails(key, default, user)` still compiles as a Kotlin extension
        // resolved against the same interface, satisfying Principle II.
    }

    @Test
    fun confeatureClientCarriesGetAllValues() {
        // Spec 082 / #266 slice 4/12 — getAllValues(User?) is now present on ConfeatureClient,
        // returning Map<String, Any?>. Upstream ConfigCat's KMP signature is `suspend fun
        // getAllValues(user: User?): Map<String, Any?>`; Confeature mirrors the same suspend shape
        // + return type so a migrating consumer's call site compiles unchanged (Principle II).
        val confeature = publicMethodNames(ConfeatureClient::class.java)
        assertContains(
            confeature,
            "getAllValues",
            "ConfeatureClient MUST expose getAllValues (Principle II — drop-in compatibility)",
        )

        val getAllValues = ConfeatureClient::class.java.methods.first { it.name == "getAllValues" }
        val params = getAllValues.parameterTypes
        assertTrue(
            params.isNotEmpty() &&
                params.last().name == "kotlin.coroutines.Continuation",
            "ConfeatureClient.getAllValues MUST be a suspend function (trailing Continuation) — " +
                "ConfigCat's KMP getAllValues is suspend",
        )

        val configcatMethods = publicMethodNames(ConfigCatClient::class.java)
        assertContains(
            configcatMethods,
            "getAllValues",
            "sanity — ConfigCat KMP client is expected to expose getAllValues",
        )
    }

    @Test
    fun confeatureClientCarriesOnlineOfflineTriplet() {
        // Spec 093 / #267 slice 4/14 — setOnline + setOffline + isOffline are now present on
        // ConfeatureClient. Mirrors ConfigCat's client-level surface (Principle II — drop-in
        // compatibility). Non-suspend on the Confeature KMP surface: these are pure state
        // mutations / reads — the trailing-Continuation suspend marker is intentionally absent.
        val confeature = publicMethodNames(ConfeatureClient::class.java)
        for (m in listOf("setOnline", "setOffline", "isOffline")) {
            assertContains(
                confeature,
                m,
                "ConfeatureClient MUST expose ConfigCat's core method $m " +
                    "(Principle II — drop-in compatibility)",
            )
        }
        // Non-suspend signature check — setOnline/setOffline take zero params and return
        // Unit/void; isOffline takes zero params and returns boolean.
        for (m in listOf("setOnline", "setOffline", "isOffline")) {
            val method = ConfeatureClient::class.java.methods.first { it.name == m }
            assertTrue(
                method.parameterTypes.isEmpty(),
                "ConfeatureClient.$m MUST be non-suspend and take zero parameters — " +
                    "ConfigCat's KMP $m is a synchronous state mutation",
            )
        }
    }

    @Test
    fun confeatureClientCarriesGetHooks() {
        // Spec 105 / #268 slice 3/14 — getHooks() is now present on ConfeatureClient, returning the
        // Confeature hooks bus. Mirrors `com.configcat.ConfigCatClient.getHooks()` (Principle II —
        // drop-in compatibility).
        val getHooks = ConfeatureClient::class.java.getMethod("getHooks")
        assertTrue(
            getHooks.returnType == ConfeatureHooks::class.java,
            "ConfeatureClient#getHooks MUST return ConfeatureHooks — the four-hook bus " +
                "mirroring com.configcat.ConfigCatHooks (Principle II — drop-in compatibility).",
        )
        // Non-suspend signature check — getHooks takes zero params and returns synchronously.
        assertTrue(
            getHooks.parameterTypes.isEmpty(),
            "ConfeatureClient.getHooks MUST be non-suspend — upstream's KMP getHooks is sync.",
        )
    }

    @Test
    fun knownDivergences264AreAbsentDriftGuard() {
        // KNOWN DIVERGENCE (#264 / #266..#269) — spec 069 is SPLIT-scoped: the corrections are
        // DEFERRED. These are EXPECTED absent on ConfeatureClient today. The assertion is a
        // drift-guard: when the #266-#269 follow-on adds one, this test fails and MUST be updated
        // to assert presence + conformance against ConfigCat.
        val confeature = publicMethodNames(ConfeatureClient::class.java)
        val divergences = listOf(
            // NOTE: `getValueDetails` + `getAllValues` moved to dedicated presence
            // assertions under spec 082 / #266 slice 4/12 (both landed).
            "getAnyValueDetails", // #266
            "getAllValueDetails", // #266
            // NOTE: client-level `getAllKeys` moved to the conforming list under
            // spec 077 / #269 (the enumerator landed).
            // NOTE: `setOnline` + `setOffline` + `isOffline` moved to a dedicated presence
            // assertion under spec 093 / #267 slice 4/14 (all three landed). See
            // `confeatureClientCarriesOnlineOfflineTriplet`.
            // NOTE: `getHooks` moved to `confeatureClientCarriesGetHooks` under spec 105 /
            // #268 slice 3/14 (landed).
        )
        for (divergent in divergences) {
            assertFalse(
                confeature.contains(divergent),
                "KNOWN DIVERGENCE (#264): $divergent is deferred to the #266-#269 follow-on " +
                    "and MUST still be absent on ConfeatureClient. If this fails, the follow-on " +
                    "landed — update this conformance test to assert presence + conformance.",
            )
        }
    }
}
