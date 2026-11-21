# Confeature OpenFeature provider for Kotlin Multiplatform

<!-- SPDX-License-Identifier: MIT -->

Use Kotlin 2.2.21 to build with this optional provider. Targets include JVM
with Java 11 or later, Android API 21 or later, Kotlin/JS in Node.js 22 and in
the browser, and iOS arm64 devices and simulators.

Use Android Gradle Plugin 8.10 or later when packaging an Android app with the
provider, so D8 and R8 can read its Kotlin 2.2 metadata. AGP 8.10 needs
Gradle 8.11.1 or later and JDK 17 or later to build the app.

## Install

Add the Confeature Maven repository and Maven Central to your Gradle settings.
Include Google's Maven repository for Android builds. Gradle selects the
platform artifact from the root dependency.

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        exclusiveContent {
            forRepository { maven { url = uri("https://maven.confeature.io") } }
            filter { includeGroup("io.confeature") }
        }
        mavenCentral()
        google()
    }
}
```

```kotlin
// build.gradle.kts
kotlin {
    sourceSets {
        commonMain.dependencies {
            implementation("io.confeature:confeature-openfeature-kotlin:0.1.0")
        }
    }
}
```

## Evaluate a flag

Run this example with a synthetic SDK key and a `LocalOnly` override. The program
prints `true` without fetching a configuration.

```kotlin
import dev.openfeature.kotlin.sdk.ImmutableContext
import dev.openfeature.kotlin.sdk.OpenFeatureAPI
import dev.openfeature.kotlin.sdk.Value
import io.confeature.kmp.ConfeatureClient
import io.confeature.kmp.FlagOverrides
import io.confeature.kmp.MapOverrideDataSource
import io.confeature.kmp.openfeature.ConfeatureProvider

suspend fun main() {
    val sdk = ConfeatureClient
        .builder("configcat-sdk-1/AAAAAAAAAAAAAAAAAAAAAA/BBBBBBBBBBBBBBBBBBBBBB")
        .flagOverrides(FlagOverrides.localOnly(MapOverrideDataSource(mapOf("new-checkout" to true))))
        .build()

    try {
        OpenFeatureAPI.setProviderAndWait(ConfeatureProvider(sdk))
        OpenFeatureAPI.setEvaluationContextAndWait(
            ImmutableContext("customer-42", mapOf("Country" to Value.String("FR"))),
        )

        val enabled = OpenFeatureAPI.getClient().getBooleanValue("new-checkout", false)
        println(enabled)
    } finally {
        try {
            OpenFeatureAPI.shutdown()
        } finally {
            sdk.close()
        }
    }
}
```

Set the current evaluation context on the OpenFeature API instance. Its targeting
key supplies the user identifier. An empty context evaluates anonymously. A context
with attributes and an empty targeting key can match attribute rules. Percentage
rules that use the default identifier require a targeting key. The provider accepts
string `Email` and `Country` attributes, along with supported custom scalars, lists
of strings and instants converted to epoch seconds. [OpenFeature Kotlin SDK](https://openfeature.dev/docs/reference/sdks/client/kotlin/)

The application owns the Confeature client. Replacing or shutting down the
provider leaves the client open. Close the client when your application is done
with it. Use a new provider instance after shutting down the previous one.

## Polling and values

Provider registration completes independently of configuration loading. Flag
evaluation is synchronous and uses the current configuration. A cold client
returns the caller's fallback with `PROVIDER_NOT_READY` until a configuration is
available.

- `AutoPoll` refreshes on the Confeature client's polling loop.
- `LazyLoad` can start one background refresh when the cache is cold or expired.
  Evaluations can use the last usable configuration while it refreshes.
- `ManualPoll` refreshes when the application calls `sdk.forceRefresh()`.
- Offline mode uses cached values. `LocalOnly` uses local overrides. Neither
  mode sends requests.

The provider supports boolean, string, integer, long and double evaluations.
Long evaluations widen the signed 32-bit Config V2 integer and preserve the
caller's full `Long` fallback. Object evaluations return `TYPE_MISMATCH`. On
Kotlin/JS, a whole number in a flat override is an integer when it fits in a
signed 32-bit value. Use `FlagOverrides.localConfig` with a Config V2 double flag
to preserve the double type for a value such as `1.0`.

## Browser configuration

For remote evaluation in Kotlin/JS browsers, set `ConfeatureClient.Builder.baseUrl`
to a Config V2 base URL on the page's origin. The SDK appends
`/configuration-files/{sdkKey}/config_v6.json` to that base URL. Serve that path
from the same origin, including when the application uses a reverse proxy.

[MIT license](./LICENSE)
