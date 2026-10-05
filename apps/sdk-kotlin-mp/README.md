# confeature-kmp

<!-- SPDX-License-Identifier: MIT -->

Confeature Kotlin Multiplatform SDK. Drop-in compatible with ConfigCat's KMP pattern. Targets: JVM, Android, iOS (arm64 + x64 + simulator-arm64), JS (IR). Common API via `commonMain`; platform specifics via `expect/actual`.

> **License**: MIT. SPDX header on every source file.

## Install (Gradle Kotlin DSL)

Not published to Maven Central yet (#794): build this directory from source until then. The
coordinates below are the ones this build produces.

```kotlin
kotlin {
    sourceSets {
        commonMain.dependencies {
            implementation("io.confeature:confeature-kotlin-mp-sdk:0.1.0")
        }
    }
}
```

## Quickstart (commonMain)

```kotlin
import io.confeature.kmp.*

suspend fun main() {
    val client = ConfeatureClient.builder("configcat-sdk-1/<22-char-segment>/<22-char-segment>")
        .pollingMode(PollingMode.autoPoll(pollInterval = 60.seconds))
        .build()

    val user = User(identifier = "alice@example.com")
    val enabled = client.getValue("new-checkout-flow", false, user)
    println(if (enabled) "new flow" else "old flow")

    client.close()
}
```

## Migrating from ConfigCat KMP

```diff
- import com.configcat.client.ConfigCatClient
+ import io.confeature.kmp.ConfeatureClient
```

Methods, options, polling modes — all 1:1 with the ConfigCat counterpart.

## SDK keys

Confeature mints SDK keys in ConfigCat's own shape — `configcat-sdk-1/<22 chars>/<22 chars>`
(alphabet `[A-Za-z0-9_-]`) — so the same key works in a stock ConfigCat SDK pointed at Confeature.
Keys minted earlier, `confeature-sdk-1-<32 chars>-<32 chars>`, are still accepted until rotated.

`io.confeature.kmp.internal.SdkKey.isValidConfeatureKeyFormat(key)` accepts both shapes. An
unrecognised key never throws: the client logs `INVALID_SDK_KEY` (with the key redacted) and
continues. The key is never logged raw and never used as a cache file name (a SHA-256-derived
32-char suffix is used instead).

## Architecture

- HTTP: Ktor Client 3.x (multiplatform, per-target engines: CIO/JVM, OkHttp/Android, Darwin/iOS, Js/JS).
- JSON: kotlinx-serialization-json.
- Coroutines: kotlinx-coroutines-core for async + polling.
- Cache: filesystem (JVM/Android/iOS via `expect/actual`) / localStorage (JS browser) / fs (JS Node).
- Crypto: SHA-256 via `expect/actual` Sha256Provider (`MessageDigest` on JVM/Android, `CC_SHA256` on iOS, `crypto.subtle.digest` on JS).

## License

[MIT](./LICENSE).

<!-- ci-nudge 1779068568 -->
