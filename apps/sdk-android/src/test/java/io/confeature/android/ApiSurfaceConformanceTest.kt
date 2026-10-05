// SPDX-License-Identifier: MIT
package io.confeature.android

import com.configcat.ConfigCatClient
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Spec 069 US3 — API-surface conformance test for `sdk-android`.
 *
 * Reflects over the official ConfigCat Android SDK (`com.configcat.ConfigCatClient`, pinned via a
 * `testImplementation` dependency in `build.gradle.kts`) and the Confeature [ConfeatureClient],
 * and asserts that the Confeature client's public surface is a conforming superset of ConfigCat's
 * core evaluation surface — a consumer migrating from `configcat-android-client` changes only the
 * base URL, and every core method they reference still resolves.
 *
 * `sdk-android` had no API-surface test before spec 069 (research §R3) — this is its first.
 *
 * Reflection is performed over class metadata only — no Android-framework-dependent client
 * instantiation, so the test does not need a Robolectric runtime (plan.md Risks).
 *
 * **KNOWN DIVERGENCE (#264 / #266..#269).** Epic #264's audit found five JVM API-surface gaps
 * versus ConfigCat. Spec 069 is SPLIT-scoped (research §R0) — typed-value parity + this
 * conformance test only; the corrections are DEFERRED to the #266-#269 follow-on. Each gap below
 * is asserted as a drift-guard: the method is currently ABSENT on [ConfeatureClient], and the
 * assertion fails loudly the day the follow-on adds it — at which point this test is updated to
 * assert presence + conformance.
 *
 * - `getValueDetails` — #266 — landed spec 081.
 * - `getAllValues` — #266 — landed spec 081.
 * - `getAllValueDetails` — #266 (tracked separately).
 * - `setOnline` / `setOffline` / `isOffline` — #267.
 * - the hooks / events surface (`getHooks`) — #268.
 *
 * **Spec 077 / #269 — client-level `getAllKeys` landed.** The drift-guard for `getAllKeys` was
 * moved to the conforming list (see `confeatureClientCarriesClientLevelGetAllKeys`).
 *
 * **Spec 081 / #266 slice 3/12 — `getValueDetails` + `getAllValues` landed.** Their drift-guards
 * were moved to dedicated presence assertions (see `confeatureClientCarriesGetValueDetails` and
 * `confeatureClientCarriesGetAllValues`).
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
        // resolve. ConfigCatClient is the official Android client the conformance reflects.
        assertThat(ConfigCatClient::class.java.name)
            .describedAs("ConfigCat's ConfigCatClient must resolve from the test classpath")
            .isEqualTo("com.configcat.ConfigCatClient")
    }

    @Test
    fun confeatureClientCoversConfigCatCoreEvaluationSurface() {
        // ConfigCat's Android ConfigCatClient declares getValue / forceRefresh / close / getAllKeys
        // directly. Confeature must expose each core name (snapshot is asserted separately — it is
        // a Confeature superset extension).
        val confeature = publicMethodNames(ConfeatureClient::class.java)
        val configcat = publicMethodNames(ConfigCatClient::class.java)

        // Spec 077 / #269 — client-level getAllKeys landed.
        for (core in listOf("getValue", "forceRefresh", "close", "getAllKeys")) {
            assertThat(configcat.contains(core))
                .describedAs(
                    "ConfigCat's ConfigCatClient is expected to expose the core method $core",
                )
                .isTrue()
            assertThat(confeature.contains(core))
                .describedAs(
                    "ConfeatureClient MUST expose ConfigCat's core method $core " +
                        "(Principle II — drop-in compatibility)",
                )
                .isTrue()
        }
    }

    @Test
    fun confeatureClientCarriesClientLevelGetAllKeys() {
        // Spec 077 / #269 — client-level getAllKeys() is now present on ConfeatureClient. Upstream
        // ConfigCat's signature is `Collection<String> getAllKeys()`; Confeature mirrors the same
        // return shape so a migrating consumer's call site compiles unchanged (Principle II).
        val getAllKeys = ConfeatureClient::class.java.getMethod("getAllKeys")
        assertThat(getAllKeys.returnType)
            .describedAs(
                "ConfeatureClient#getAllKeys MUST return Collection<String> to match ConfigCat's " +
                    "ConfigCatClient#getAllKeys signature (Principle II — drop-in compatibility).",
            )
            .isEqualTo(java.util.Collection::class.java)

        val configcatGetAllKeys = ConfigCatClient::class.java.getMethod("getAllKeys")
        assertThat(configcatGetAllKeys.returnType)
            .describedAs(
                "sanity — ConfigCat Android client is expected to expose getAllKeys() returning " +
                    "Collection<String>.",
            )
            .isEqualTo(java.util.Collection::class.java)
    }

    @Test
    fun confeatureClientExposesSnapshotAsConfeatureSupersetExtension() {
        // snapshot() is a Confeature superset extension — ConfigCat's Android client has no
        // equivalent (it exposes keys via the client-level getAllKeys). The conformance bar is
        // "superset", so this is a legitimate addition.
        assertThat(publicMethodNames(ConfigCatClient::class.java).contains("snapshot"))
            .describedAs(
                "ConfigCat's Android ConfigCatClient has no snapshot() — Confeature's is additive",
            )
            .isFalse()
        assertThat(publicMethodNames(ConfeatureClient::class.java).contains("snapshot"))
            .describedAs(
                "ConfeatureClient exposes snapshot() — the Confeature key/value access surface",
            )
            .isTrue()
    }

    @Test
    fun confeatureClientCarriesConfigCatContextFactory() {
        // ConfigCat's Android client adds a Context-aware static get(Context, sdkKey) factory on
        // top of the plain get(sdkKey). Confeature mirrors both on its companion object — the
        // Context overload is the Android-idiomatic entry point a migrating consumer calls.
        val companionMethods = ConfeatureClient.Companion::class.java.methods.map { it.name }.toSet()
        assertThat(companionMethods.contains("get"))
            .describedAs("ConfeatureClient.Companion MUST expose a get(...) factory")
            .isTrue()
        assertThat(companionMethods.contains("builder"))
            .describedAs("ConfeatureClient.Companion MUST expose a builder(sdkKey) factory")
            .isTrue()

        // The Android Context overload: get(Context, String).
        val getOverloads = ConfeatureClient.Companion::class.java.methods
            .filter { it.name == "get" }
            .map { method -> method.parameterTypes.map { it.name } }
        val hasContextOverload = getOverloads.any { params ->
            params.size == 2 &&
                params[0] == "android.content.Context" &&
                params[1] == "java.lang.String"
        }
        assertThat(hasContextOverload)
            .describedAs(
                "ConfeatureClient MUST expose the Android Context factory overload " +
                    "get(Context, sdkKey) — ConfigCat's Android client requires it",
            )
            .isTrue()
    }

    @Test
    fun confeatureClientCarriesGetValueDetails() {
        // Spec 081 / #266 slice 3/12 — getValueDetails(String, Any?, User?) is now present on
        // ConfeatureClient, returning the upstream-aligned EvaluationDetails envelope. Confeature
        // mirrors the 3-arg untyped path that the migrating consumer's most common call site uses
        // (Principle II — drop-in compatibility).
        val getValueDetails = ConfeatureClient::class.java.getMethod(
            "getValueDetails",
            String::class.java,
            Any::class.java,
            User::class.java,
        )
        assertThat(getValueDetails.returnType)
            .describedAs(
                "ConfeatureClient#getValueDetails MUST return EvaluationDetails to match " +
                    "ConfigCat's ConfigCatClient#getValueDetails return shape (Principle II — " +
                    "drop-in compatibility).",
            )
            .isEqualTo(EvaluationDetails::class.java)

        // Sanity — ConfigCat 10.x is expected to expose at least one `getValueDetails` overload.
        // We don't constrain the exact arity because upstream's typed overload uses a `Class<T>`
        // first parameter; Confeature exposes the same arity-3 untyped form used by every
        // migrating Kotlin call site.
        val configcatMethods = publicMethodNames(ConfigCatClient::class.java)
        assertThat(configcatMethods.contains("getValueDetails"))
            .describedAs("sanity — ConfigCat Android client is expected to expose getValueDetails")
            .isTrue
    }

    @Test
    fun confeatureClientCarriesGetAllValues() {
        // Spec 081 / #266 slice 3/12 — getAllValues(User?) is now present on ConfeatureClient,
        // returning Map<String, Any?>. Upstream ConfigCat's signature is `Map<String, Object>
        // getAllValues(User)`; Confeature mirrors the same return shape so a migrating consumer's
        // call site compiles unchanged (Principle II).
        val getAllValues = ConfeatureClient::class.java.getMethod("getAllValues", User::class.java)
        assertThat(getAllValues.returnType)
            .describedAs(
                "ConfeatureClient#getAllValues MUST return Map<String, Any?> to match ConfigCat's " +
                    "ConfigCatClient#getAllValues signature (Principle II — drop-in compatibility).",
            )
            .isEqualTo(java.util.Map::class.java)

        val configcatMethods = publicMethodNames(ConfigCatClient::class.java)
        assertThat(configcatMethods.contains("getAllValues"))
            .describedAs("sanity — ConfigCat Android client is expected to expose getAllValues")
            .isTrue
    }

    @Test
    fun confeatureClientCarriesOnlineOfflineTriplet() {
        // Spec 092 / #267 slice 3/14 — setOnline + setOffline + isOffline are now present on
        // ConfeatureClient. Mirrors ConfigCat's client-level surface (Principle II — drop-in
        // compatibility). Arity 0 for all three (each takes only the implicit receiver).
        val confeature = publicMethodNames(ConfeatureClient::class.java)
        val configcat = publicMethodNames(ConfigCatClient::class.java)
        for (m in listOf("setOnline", "setOffline", "isOffline")) {
            assertThat(configcat.contains(m))
                .describedAs("sanity — ConfigCat Android client is expected to expose $m")
                .isTrue
            assertThat(confeature.contains(m))
                .describedAs(
                    "ConfeatureClient MUST expose ConfigCat's core method $m " +
                        "(Principle II — drop-in compatibility)",
                )
                .isTrue
        }
    }

    @Test
    fun confeatureClientCarriesGetHooks() {
        // Spec 104 / #268 slice 2/14 — getHooks() is now present on ConfeatureClient, returning the
        // Confeature hooks bus. Upstream ConfigCat's Android client signature is
        // `ConfigCatHooks getHooks()`; Confeature mirrors the accessor name so a migrating
        // consumer's call site compiles unchanged (Principle II — drop-in compatibility).
        val getHooks = ConfeatureClient::class.java.getMethod("getHooks")
        assertThat(getHooks.returnType)
            .describedAs(
                "ConfeatureClient#getHooks MUST return ConfeatureHooks — the four-hook bus " +
                    "mirroring com.configcat.ConfigCatHooks (Principle II — drop-in compatibility).",
            )
            .isEqualTo(ConfeatureHooks::class.java)

        val configcatMethods = publicMethodNames(ConfigCatClient::class.java)
        assertThat(configcatMethods.contains("getHooks"))
            .describedAs("sanity — ConfigCat Android client is expected to expose getHooks")
            .isTrue
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
            // assertions under spec 081 / #266 slice 3/12 (both landed).
            "getAllValueDetails", // #266
            // NOTE: client-level `getAllKeys` moved to the conforming list under
            // spec 077 / #269 (the enumerator landed).
            // NOTE: `setOnline` + `setOffline` + `isOffline` moved to a dedicated presence
            // assertion under spec 092 / #267 slice 3/14 (all three landed). See
            // `confeatureClientCarriesOnlineOfflineTriplet`.
            // NOTE: `getHooks` moved to `confeatureClientCarriesGetHooks` under spec 104 /
            // #268 slice 2/14 (landed).
        )
        for (divergent in divergences) {
            assertThat(confeature.contains(divergent))
                .describedAs(
                    "KNOWN DIVERGENCE (#264): $divergent is deferred to the #266-#269 follow-on " +
                        "and MUST still be absent on ConfeatureClient. If this fails, the " +
                        "follow-on landed — update this test to assert presence + conformance.",
                )
                .isFalse()
        }
    }
}
